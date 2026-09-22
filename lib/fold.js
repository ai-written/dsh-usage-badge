/**
 * dsh-usage-badge — session-log folding.
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
 * Where the folded history lives between runs is `cache-store.js`'s business, not
 * this module's: a fold hands it one session at a time and asks it for the window
 * back.
 *
 * @module dsh-usage-badge/fold
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { addBucket, emptyBucket, UNKNOWN } from './buckets.js'
import { dayKey, localHour } from './pricing.js'

export { UNKNOWN }

/** Matches `session.jsonl`, `session.jsonl.zstd`, `session.v2.jsonl(.zstd)`, … */
const SESSION_LOG_RE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

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

/**
 * Merge session records into the per-day / per-route view the snapshot reads.
 *
 * Exported because a caller that reads a slice of history straight from the store (the year
 * view does) needs exactly this merge rather than a second implementation of it.
 *
 * @param {Iterable<object>} records - session records, each carrying a `days` map.
 */
export function mergeRecords(records) {
  const merged = new Map()
  for (const record of records) {
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
  return merged
}

/**
 * An incremental view over every session log.
 *
 * `refresh()` re-reads only logs whose size, mtime or path changed, so a steady
 * state costs one `stat` per session. The merged `days` map is rebuilt from the
 * per-session records on every refresh; that is deliberate, because rebuilding is
 * what makes a deleted log keep its cached contribution instead of erasing
 * history that the log no longer exists to prove.
 *
 * @param {{sessionsRoot:string, store:object, log?:Function}} options `store` is the cache
 *   from `cache-store.js`: a fold writes the sessions it changed and reads a window back.
 */
export function createAggregator({ sessionsRoot, store, log = () => {} }) {
  const records = new Map()
  const cursors = new Map()
  let days = new Map()
  let lastRefresh = null

  function mergeDays() {
    days = mergeRecords(records.values())
  }

  /**
   * Take back the stored history, oldest row first dropped into the window the panel can
   * show. Sessions whose days all fall outside the window still come back — with their
   * cursor, so their logs are never folded again — just without the buckets that no view
   * asks for. Their rows stay in the store.
   */
  function loadCache() {
    let loaded
    try {
      loaded = store.load()
    } catch (error) {
      log(`cache load failed: ${error?.message ?? error}`)
      return false
    }
    for (const record of loaded ?? []) {
      records.set(record.sessionId, record)
      cursors.set(record.sessionId, {
        seq: record.seq,
        provider: record.provider,
        model: record.model,
        fileSize: record.fileSize,
        fileMtimeMs: record.fileMtimeMs,
        path: record.path,
      })
    }
    mergeDays()
    log(`cache loaded: ${records.size} session(s) from ${store.kind}`)
    return records.size > 0
  }

  /** Write through anything the store is holding back; called on warm-up and on unload. */
  function flush() {
    store.flush()
  }

  /** Flush and release the store's handle. */
  function close() {
    store.close()
  }

  /**
   * Fold every changed log.
   *
   * A changed session is written back immediately, one session at a time: that is the whole
   * reason the store is not a single document, and it means there is no save timer to lose
   * work in and no moment where a burst of edits has to be batched.
   *
   * @returns {Promise<{files:number, folded:number, ms:number}>} what this pass did.
   */
  async function refresh() {
    const started = Date.now()
    const files = listLogFiles(sessionsRoot)
    let folded = 0
    let sinceYield = 0
    for (const file of files) {
      const sessionId = sessionIdFromLogPath(file)
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
      const previous = records.get(sessionId)
      const record = foldSession(file, previous)
      // `foldSession` hands the previous record straight back when it could not read the log, and
      // that record is already in the store — writing it again would replace the session's rows
      // with only the days this process happens to hold (the loading window), deleting the older
      // ones on the way past. Leaving the cursor untouched also means the next refresh retries the
      // fold, which is what a transient read failure wants.
      if (record && record !== previous) {
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
        // Written back one session at a time, right here: a save costs the changed session's
        // days, not the whole history, so there is nothing to batch and no timer to lose it in.
        try {
          store.put(record)
        } catch (error) {
          log(`cache write failed for ${sessionId}: ${error?.message ?? error}`)
        }
      }
      if (++sinceYield >= YIELD_EVERY) {
        sinceYield = 0
        await new Promise((r) => setImmediate(r))
      }
    }
    // A session whose log disappeared keeps its record (and therefore its history) but stops
    // being refreshed — and, because nothing writes it again, that history stays in the store
    // for good rather than being erased by the log's absence.
    if (folded > 0) mergeDays()
    lastRefresh = { files: files.length, folded, ms: Date.now() - started, at: Date.now() }
    return lastRefresh
  }

  return {
    loadCache,
    refresh,
    flush,
    close,
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
