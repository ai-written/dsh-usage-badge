/**
 * dsh-usage-badge — session-log folding and its incremental cache.
 *
 * DSH persists one append-only log per session under `$DSH_HOME/sessions`. This
 * module folds every log it finds into per-day / per-(provider, model) token
 * buckets holding the raw per-request usage records, which is what lets the
 * pricing layer apply a different multiplier to each request instead of pricing
 * a day at one flat rate.
 *
 * Ported from the desktop shell's `usage-sidecar.mjs` fold, with the same
 * discovery rules (generation selection per session directory) and the same
 * size/mtime cursor that keeps a refresh proportional to what actually changed.
 * The cache file is this plugin's own (`usage-badge-cache.json`) rather than the
 * shell's `usage-cache.json`: both read the same logs, but sharing one cache file
 * would mean two writers racing over it.
 *
 * @module dsh-usage-badge/fold
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { dayKey, initHourly, localHour } from './pricing.js'

/** Bucket key and display name used when a log records no provider/model. */
export const UNKNOWN = 'unknown'

/** Matches `session.jsonl`, `session.jsonl.zstd`, `session.v2.jsonl(.zstd)`, … */
const SESSION_LOG_RE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** This plugin's cache format version. Unknown versions are ignored, not migrated. */
const CACHE_VERSION = 1

/** Files folded between event-loop yields, so a cold scan never stalls the host. */
const YIELD_EVERY = 25

/** Expand `~`, `~/`, `~\` against the OS home. */
function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the DeepSeek Harness home.
 *
 * This mirrors `resolveDshHome()` from `@deepseek-ai/dsh-home-paths`, inlined so
 * the plugin needs no peer dependency: an explicit path, then a non-blank
 * `$DSH_HOME`, then `~/.dsh`. A whitespace-only `$DSH_HOME` counts as unset, so a
 * blank override can never resolve the home to the current directory.
 */
export function resolveDshHome(configured, env = process.env) {
  const fromEnv = env?.DSH_HOME
  const chosen =
    configured ?? (typeof fromEnv === 'string' && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh'))
  return resolve(expandHome(chosen))
}

/**
 * Decode a log body that may hold one or more concatenated zstd frames.
 *
 * DSH appends frames as a session grows, so a `.zstd` log is a frame sequence
 * rather than one stream; `zstdDecompressSync` handles a single frame, so the
 * buffer is split on the frame magic first. A body with no frame magic is
 * returned as UTF-8, which keeps plain `.jsonl` and any partially written file
 * readable instead of throwing.
 */
export function decodeLogBody(buf) {
  const starts = []
  let i = 0
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) {
    starts.push(i)
    i += 1
  }
  if (starts.length === 0) return buf.toString('utf8')
  if (typeof zstdDecompressSync !== 'function') {
    throw new Error('this Node build has no zlib.zstdDecompressSync; a zstd session log cannot be read')
  }
  let out = ''
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    out += zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8')
  }
  return out
}

function logParent(file) {
  const index = Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/'))
  return index >= 0 ? file.slice(0, index) : ''
}

/** Rank a log file within its session directory: generation first, then `.zstd` over plain. */
function logRank(file) {
  const index = Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/'))
  const name = index >= 0 ? file.slice(index + 1) : file
  const match = SESSION_LOG_RE.exec(name)
  if (!match) return -1
  return (Number(match[1]) || 0) * 2 + (name.endsWith('.zstd') ? 1 : 0)
}

/**
 * Every log file under `dir`, keeping only the newest generation per session
 * directory.
 *
 * A migrated session can leave older artifacts beside its current log; those are
 * generations of one session, not sessions to add up. Picking the highest
 * generation per directory is also what keeps a future `v3`/`v4` log correct
 * without a code change.
 */
export function listLogFiles(dir, root = dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) listLogFiles(full, root, out)
    else if (SESSION_LOG_RE.test(entry.name)) out.push(full)
  }
  if (dir === root) {
    const best = new Map()
    for (const file of out) {
      const parent = logParent(file)
      const current = best.get(parent)
      if (!current || logRank(file) > logRank(current)) best.set(parent, file)
    }
    return out.filter((file) => best.get(logParent(file)) === file)
  }
  return out
}

/** The session id a log path belongs to (its containing directory name). */
export function sessionIdFromLogPath(file) {
  const parts = file.split(/[\\/]/)
  return parts.length >= 2 ? parts[parts.length - 2] : file
}

function emptyBucket(provider, model) {
  return {
    provider,
    model,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    requests: 0,
    hourly: initHourly(),
    usageRecords: [],
  }
}

/**
 * Add `source` into `target`.
 *
 * A missing per-request list marks a legacy aggregate row: mixing one into a
 * bucket that has a list would silently drop the aggregate's share from the
 * context-tier price, so the list is dropped to `null` for the whole bucket
 * instead, and that bucket falls back to flat pricing. Appending is looped rather
 * than spread because one day bucket can hold hundreds of thousands of requests,
 * which would overflow the argument list long before it exhausted memory.
 */
function addBucket(target, source) {
  target.input += Number(source?.input) || 0
  target.cacheRead += Number(source?.cacheRead) || 0
  target.cacheWrite += Number(source?.cacheWrite) || 0
  target.output += Number(source?.output) || 0
  target.requests += Number(source?.requests) || 0
  if (!Array.isArray(target.hourly)) target.hourly = initHourly()
  if (Array.isArray(source?.hourly)) {
    for (let hour = 0; hour < 24; hour++) {
      const from = source.hourly[hour]
      const to = target.hourly[hour]
      if (!from || !to) continue
      to.input += Number(from.input) || 0
      to.cacheRead += Number(from.cacheRead) || 0
      to.cacheWrite += Number(from.cacheWrite) || 0
      to.output += Number(from.output) || 0
      to.requests += Number(from.requests) || 0
    }
  }
  if (!Array.isArray(target.usageRecords) || !Array.isArray(source?.usageRecords)) {
    target.usageRecords = null
  } else {
    for (const usage of source.usageRecords) {
      if (usage && typeof usage === 'object') target.usageRecords.push(usage)
    }
  }
}

/**
 * Fold one session log into per-day, per-route buckets.
 *
 * Route attribution follows the log's own control events: `request/header` (and
 * `request/context`) carry the provider and model, and each `assistant/message`
 * carries the provider-reported `usage` for one completed request. Requests are
 * stamped with the hour they were *sent* where the log allows it, because a
 * streaming call can cross a peak/valley boundary and filing it by completion
 * would price it in the wrong band.
 *
 * @returns {object|null} the session record, or null when the file is unreadable.
 */
export function foldSession(file, previous) {
  const sessionId = sessionIdFromLogPath(file)
  let stat
  try {
    stat = statSync(file)
  } catch {
    return null
  }
  let body
  try {
    body = readFileSync(file)
  } catch {
    return null
  }
  let text
  try {
    text = decodeLogBody(body)
  } catch {
    // An unreadable body keeps whatever this session contributed before, so a
    // transient decompression failure cannot erase history.
    return previous ?? null
  }

  const sessionDays = new Map()
  let provider = null
  let model = null
  let maxSeq = -1

  for (const line of text.split('\n')) {
    if (!line) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue // a torn tail line is expected on a log being appended
    }
    const seq = typeof ev?.seq === 'number' ? ev.seq : -1
    if (seq > maxSeq) maxSeq = seq
    const data = ev?.data ?? {}
    if (ev?.type === 'request/header') {
      const config = data.header?.config ?? {}
      provider = config.provider ?? data.provider ?? null
      model = config.model ?? data.model ?? null
    } else if (ev?.type === 'request/context') {
      provider = data.provider ?? provider
      model = data.model ?? model
    } else if (ev?.type === 'assistant/message') {
      const usage = data.usage
      if (!usage || typeof usage !== 'object') continue
      const pm = provider ?? UNKNOWN
      const mm = model ?? UNKNOWN
      const date = dayKey(ev.time ?? Date.now())
      let dayObj = sessionDays.get(date)
      if (!dayObj) {
        dayObj = new Map()
        sessionDays.set(date, dayObj)
      }
      const key = `${pm}|${mm}`
      const bucket = dayObj.get(key) ?? emptyBucket(pm, mm)
      const record = {
        input: Number(usage.inputTokens) || 0,
        cacheRead: Number(usage.cacheReadTokens) || 0,
        cacheWrite: Number(usage.cacheWriteTokens) || 0,
        output: Number(usage.outputTokens) || 0,
      }
      const hour = localHour(ev.time ?? Date.now())
      bucket.input += record.input
      bucket.cacheRead += record.cacheRead
      bucket.cacheWrite += record.cacheWrite
      bucket.output += record.output
      bucket.requests += 1
      if (Array.isArray(bucket.usageRecords)) bucket.usageRecords.push({ ...record, hour })
      const hourBucket = bucket.hourly[hour]
      hourBucket.input += record.input
      hourBucket.cacheRead += record.cacheRead
      hourBucket.cacheWrite += record.cacheWrite
      hourBucket.output += record.output
      hourBucket.requests += 1
      dayObj.set(key, bucket)
    }
  }

  return {
    sessionId,
    path: file,
    fileSize: stat.size,
    fileMtimeMs: stat.mtimeMs || 0,
    seq: maxSeq,
    provider,
    model,
    days: sessionDays,
  }
}

function serializeSession(record) {
  const days = {}
  for (const [date, dayObj] of record.days ?? []) {
    days[date] = {}
    for (const [key, bucket] of dayObj) days[date][key] = bucket
  }
  return {
    path: record.path,
    fileSize: record.fileSize,
    fileMtimeMs: record.fileMtimeMs,
    seq: record.seq,
    provider: record.provider,
    model: record.model,
    days,
  }
}

function deserializeSession(sessionId, record) {
  if (!record || typeof record !== 'object' || !record.days || typeof record.days !== 'object') return null
  const days = new Map()
  for (const [date, sourceDay] of Object.entries(record.days)) {
    if (!sourceDay || typeof sourceDay !== 'object') continue
    const dayObj = new Map()
    for (const [key, source] of Object.entries(sourceDay)) {
      if (!source || typeof source !== 'object') continue
      const bucket = emptyBucket(String(source.provider ?? UNKNOWN), String(source.model ?? UNKNOWN))
      addBucket(bucket, source)
      dayObj.set(key, bucket)
    }
    days.set(date, dayObj)
  }
  return {
    sessionId,
    path: String(record.path ?? ''),
    fileSize: Number(record.fileSize) || 0,
    fileMtimeMs: Number(record.fileMtimeMs) || 0,
    seq: Number(record.seq) || -1,
    provider: record.provider ?? null,
    model: record.model ?? null,
    days,
  }
}

/**
 * An incremental view over every session log.
 *
 * `refresh()` re-reads only logs whose size, mtime or path changed, so a steady
 * state costs one `stat` per session. The merged `days` map is rebuilt from the
 * per-session records on every refresh; that is deliberate, because rebuilding is
 * what makes a deleted log keep its cached contribution instead of erasing
 * history that the log no longer exists to prove.
 */
export function createAggregator({ sessionsRoot, cachePath, log = () => {} }) {
  const records = new Map()
  const cursors = new Map()
  let days = new Map()
  let saveTimer = null
  let lastRefresh = null

  function mergeDays() {
    const merged = new Map()
    for (const record of records.values()) {
      for (const [date, sourceDay] of record.days ?? []) {
        let dayObj = merged.get(date)
        if (!dayObj) {
          dayObj = new Map()
          merged.set(date, dayObj)
        }
        for (const [key, source] of sourceDay) {
          const target = dayObj.get(key) ?? emptyBucket(source.provider, source.model)
          addBucket(target, source)
          dayObj.set(key, target)
        }
      }
    }
    days = merged
  }

  function loadCache() {
    let raw
    try {
      raw = JSON.parse(readFileSync(cachePath, 'utf8'))
    } catch {
      return false
    }
    if (!raw || raw.version !== CACHE_VERSION || !raw.sessions || typeof raw.sessions !== 'object') return false
    for (const [sessionId, source] of Object.entries(raw.sessions)) {
      const record = deserializeSession(sessionId, source)
      if (!record) continue
      records.set(sessionId, record)
      cursors.set(sessionId, {
        seq: record.seq,
        provider: record.provider,
        model: record.model,
        fileSize: record.fileSize,
        fileMtimeMs: record.fileMtimeMs,
        path: record.path,
      })
    }
    mergeDays()
    log(`cache loaded: ${records.size} session(s)`)
    return true
  }

  function saveCache() {
    const sessions = {}
    for (const [sessionId, record] of records) sessions[sessionId] = serializeSession(record)
    // The temporary name carries pid, time and entropy so a restarted host can
    // never collide with a stale temp file another process still holds open.
    const temp = `${cachePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    try {
      mkdirSync(join(cachePath, '..'), { recursive: true })
      writeFileSync(temp, JSON.stringify({ version: CACHE_VERSION, sessions }))
      try {
        renameSync(temp, cachePath)
      } catch {
        // Windows cannot rename over an existing file; the complete temp file is
        // already on disk, so removing the old one first is safe here.
        try {
          unlinkSync(cachePath)
        } catch {
          // absent is fine
        }
        renameSync(temp, cachePath)
      }
    } catch (error) {
      try {
        unlinkSync(temp)
      } catch {
        // best-effort cleanup only
      }
      log(`cache save failed: ${error?.message ?? error}`)
    }
  }

  function scheduleCacheSave() {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveCache()
    }, 2000)
    saveTimer.unref?.()
  }

  /**
   * Fold every changed log.
   *
   * @returns {Promise<{files:number, folded:number, ms:number}>} what this pass did.
   */
  async function refresh() {
    const started = Date.now()
    const files = listLogFiles(sessionsRoot)
    const seen = new Set()
    let folded = 0
    let sinceYield = 0
    for (const file of files) {
      const sessionId = sessionIdFromLogPath(file)
      seen.add(sessionId)
      const cursor = cursors.get(sessionId)
      let stat
      try {
        stat = statSync(file)
      } catch {
        continue
      }
      if (cursor && cursor.fileSize === stat.size && cursor.fileMtimeMs === (stat.mtimeMs || 0) && cursor.path === file) {
        continue
      }
      const record = foldSession(file, records.get(sessionId))
      if (record) {
        records.set(sessionId, record)
        cursors.set(sessionId, {
          seq: record.seq,
          provider: record.provider,
          model: record.model,
          fileSize: record.fileSize,
          fileMtimeMs: record.fileMtimeMs,
          path: record.path,
        })
        folded++
      }
      if (++sinceYield >= YIELD_EVERY) {
        sinceYield = 0
        await new Promise((r) => setImmediate(r))
      }
    }
    // A session whose log disappeared keeps its record (and therefore its
    // history) but stops being refreshed.
    if (folded > 0) {
      mergeDays()
      scheduleCacheSave()
    }
    lastRefresh = { files: files.length, folded, ms: Date.now() - started, at: Date.now() }
    return lastRefresh
  }

  return {
    loadCache,
    refresh,
    saveCache,
    get days() {
      return days
    },
    get sessionCount() {
      return records.size
    },
    get lastRefresh() {
      return lastRefresh
    },
  }
}
