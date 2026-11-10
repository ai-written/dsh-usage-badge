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

import { closeSync, openSync, readSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { addBucket, emptyBucket, LOCAL_SOURCE, resolveRows, UNKNOWN } from './buckets.js'
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
 * Read a log's tail without reading the whole file.
 *
 * The fold's cost is dominated by zstd decompression (measured on a real log: 12.7 MB took 775 ms
 * to decode against 133 ms of `JSON.parse`), so re-decoding a log whose only change is an appended
 * frame is the one thing worth avoiding. `from` is the byte offset the last fold consumed — which
 * is exactly the `fileSize` the cursor already stores, so this needs no new field.
 */
function readTail(file, from, size) {
  if (!(from > 0)) return readFileSync(file)
  const length = size - from
  if (!(length > 0)) return Buffer.alloc(0)
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(length)
    let read = 0
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, from + read)
      if (n <= 0) break
      read += n
    }
    return read === length ? buf : buf.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

/** Whether a fragment is exactly one complete JSON value — a torn append is not. */
function isCompleteJsonLine(fragment) {
  if (!fragment || !fragment.trim()) return false
  try {
    JSON.parse(fragment)
    return true
  } catch {
    return false
  }
}

/**
 * Split a plain-text log into newline-aligned slices.
 *
 * Sliced rather than handed over whole so a large `.jsonl` log cannot hold the event loop for a
 * second while the rest of the host waits. The final line may have no trailing newline yet — that
 * is how the last request of an idle log looks, and dropping it would under-count the badge
 * exactly where eyes are — so it counts when it parses, and a torn append is left for next time.
 */
function* plainChunks(text) {
  const SLICE = 1 << 20
  let offset = 0
  while (offset < text.length) {
    let end = Math.min(offset + SLICE, text.length)
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end - 1)
      end = nl >= offset ? nl + 1 : text.length
    }
    let piece = text.slice(offset, end)
    if (end >= text.length) {
      const nl = piece.lastIndexOf('\n')
      piece = piece.slice(0, nl + 1) + (isCompleteJsonLine(piece.slice(nl + 1)) ? piece.slice(nl + 1) : '')
      if (!piece) return
    }
    yield { bytes: Buffer.byteLength(piece, 'utf8'), text: piece }
    offset = end
  }
}

/**
 * The chunks of a body that may be folded, each carrying how many bytes it accounts for.
 *
 * A `.zstd` log is a sequence of independently decodable frames that DSH appends to, so "how much
 * can I fold" is a question about frames, not bytes: a frame that does not decode (the appender is
 * mid-write) or whose text stops mid-line is left for the next pass rather than folded half way.
 * Anything that does not begin with a frame magic is plain text, consumed up to its last newline.
 */
function* foldableChunks(buf) {
  const starts = []
  let i = 0
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) {
    starts.push(i)
    i += 1
  }
  if (starts.length === 0 || starts[0] !== 0) {
    yield* plainChunks(buf.toString('utf8'))
    return
  }
  if (typeof zstdDecompressSync !== 'function') {
    throw new Error('this Node build has no zlib.zstdDecompressSync; a zstd session log cannot be read')
  }
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    let piece
    try {
      piece = zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8')
    } catch {
      return // an unfinished frame: the next pass picks it up
    }
    if (!piece.endsWith('\n')) {
      // Only the last frame can be the end of a log, and then only when its final line is itself
      // complete JSON; anything else is a torn append.
      if (end === buf.length && isCompleteJsonLine(piece.slice(piece.lastIndexOf('\n') + 1))) {
        yield { bytes: end - starts[k], text: piece }
      }
      return
    }
    yield { bytes: end - starts[k], text: piece }
  }
}

/** A bucket copied deep enough that a fold can add to it without touching the stored record. */
function cloneBucket(bucket) {
  return {
    ...bucket,
    hourly: Array.isArray(bucket.hourly) ? bucket.hourly.map((hour) => ({ ...hour })) : bucket.hourly,
    usageRecords: Array.isArray(bucket.usageRecords) ? bucket.usageRecords.map((usage) => ({ ...usage })) : bucket.usageRecords,
  }
}

/**
 * Add one decoded chunk's events to the fold state.
 *
 * Events land in `state.fresh` rather than in the day maps the previous record handed over, so a
 * tail fold that has to be abandoned leaves that record exactly as it was.
 */
function foldText(text, state) {
  for (const line of text.split('\n')) {
    if (!line) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue // a torn tail line is expected on a log being appended
    }
    const seq = typeof ev?.seq === 'number' ? ev.seq : -1
    if (seq > state.seq) state.seq = seq
    const data = ev?.data ?? {}
    if (ev?.type === 'request/header') {
      const config = data.header?.config ?? {}
      state.provider = config.provider ?? data.provider ?? null
      state.model = config.model ?? data.model ?? null
    } else if (ev?.type === 'request/context') {
      state.provider = data.provider ?? state.provider
      state.model = data.model ?? state.model
    } else if (ev?.type === 'assistant/message') {
      const usage = data.usage
      if (!usage || typeof usage !== 'object') continue
      const pm = state.provider ?? UNKNOWN
      const mm = state.model ?? UNKNOWN
      const date = dayKey(ev.time ?? Date.now())
      state.dates.add(date)
      let dayObj = state.fresh.get(date)
      if (!dayObj) {
        dayObj = new Map()
        state.fresh.set(date, dayObj)
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
}

/** Commit this pass's own buckets into the record's days, cloning what it shares with the old one. */
function mergeFresh(state) {
  for (const [date, dayObj] of state.fresh) {
    const existing = state.days.get(date)
    const target = existing ? new Map(existing) : new Map()
    for (const [key, bucket] of dayObj) {
      const known = target.get(key)
      if (!known) {
        target.set(key, bucket)
        continue
      }
      const merged = cloneBucket(known)
      addBucket(merged, bucket)
      target.set(key, merged)
    }
    state.days.set(date, target)
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
 * **Only the new bytes are decoded.** `fromByte` is where the previous fold stopped (the cursor's
 * `fileSize`), and the tail is decoded on its own and merged into `previous`: re-decoding the whole
 * log for one appended frame is what made a start with 25 grown logs cost 3.6 s and a cold cache
 * 20 s. The returned `fileSize` is the offset this pass actually reached — a torn tail stays
 * unfolded and is retried next time for the price of the few bytes it holds.
 *
 * @param {string} file
 * @param {object|null} previous - the record this session already has; required for a tail fold.
 * @param {{fromByte?:number, yieldBytes?:number}} [options]
 * @returns {Promise<object|null>} the session record, or null when the file is unreadable.
 */
export async function foldSession(file, previous = null, { fromByte = 0, yieldBytes = 1 << 20 } = {}) {
  const sessionId = sessionIdFromLogPath(file)
  let stat
  try {
    stat = statSync(file)
  } catch {
    return null
  }
  const tail = fromByte > 0 && fromByte <= stat.size
  let body
  try {
    body = readTail(file, tail ? fromByte : 0, stat.size)
  } catch {
    return null
  }

  const state = {
    // A copy of the map, one level deep: `mergeFresh` replaces whole day entries and cloned
    // buckets, so an abandoned tail fold cannot leave a mark on the record this session already has.
    days: tail && previous?.days ? new Map(previous.days) : new Map(),
    fresh: new Map(),
    dates: new Set(),
    provider: tail ? previous?.provider ?? null : null,
    model: tail ? previous?.model ?? null : null,
    seq: tail ? previous?.seq ?? -1 : -1,
  }
  // `body` holds the tail alone, so offsets inside it are buffer-relative; `consumed` is reported
  // in file coordinates, which is what the cursor stores.
  const shift = tail ? fromByte : 0
  let consumed = shift
  let sinceYield = 0
  try {
    for (const chunk of foldableChunks(body)) {
      foldText(chunk.text, state)
      consumed += chunk.bytes
      // Yield on **bytes decoded**, not on a count of frames: a 12 MB log is ~34 000 frames, so
      // yielding per few frames cost more in `setImmediate` round-trips than the decoding did
      // (measured: a 338-log cold fold went from 21 s to 52 s). One megabyte is ~30 ms of zstd
      // work — small enough that the host keeps breathing, rare enough to be free.
      sinceYield += chunk.bytes
      if (sinceYield >= yieldBytes) {
        sinceYield = 0
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
  } catch {
    // An unreadable body keeps whatever this session contributed before, so a
    // transient decompression failure cannot erase history.
    return previous ?? null
  }
  mergeFresh(state)

  return {
    sessionId,
    path: file,
    fileSize: consumed,
    fileMtimeMs: stat.mtimeMs || 0,
    seq: state.seq,
    provider: state.provider,
    model: state.model,
    days: state.days,
    // Which days this pass itself added. A tail fold may add a day (a session running past
    // midnight does exactly that), but it may never add one *older* than the newest day the record
    // already holds: an append only moves forward, so an older day means the log was rewritten
    // rather than appended to, and the caller re-folds the session from the start.
    touchedDates: [...state.dates],
    foldedBytes: consumed,
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
  /**
   * Whether the stored history has been read into this process yet.
   *
   * `loadCache()` is deliberately **not** called when the plugin mounts: mounting happens inside DSH's
   * own startup, and reading 300+ sessions' payloads there put forty-odd milliseconds (more on a cold
   * disk, or under a virus scanner) on the host's boot path for numbers nothing has asked for yet.
   * The first `refresh()` — which is what the badge's first request runs — does it instead.
   */
  let loadedOnce = false

  function mergeDays() {
    days = mergeRecords(records.values())
  }

  /**
   * Take back the stored history, oldest row first dropped into the window the panel can
   * show. Sessions whose days all fall outside the window still come back — with their
   * cursor, so their logs are never folded again — just without the buckets that no view
   * asks for. Their rows stay in the store.
   *
   * The store has already resolved the copies it may hold for a `(session, date)` down to the
   * fuller log version; what arrives here is the merged view, with the raw `rows` alongside for
   * anything that needs to know where a day came from.
   *
   * It is also the only way rows that **arrived from another device** can enter this process: `refresh()`
   * walks the logs, and a synced row has no log here to be discovered by. That is why the host calls it
   * again after a sync run touches the store, and why that second call passes `quiet` — a reload is
   * bookkeeping, not news, and a line per sync would read like the cache was being rebuilt from scratch.
   *
   * @param {{quiet?:boolean}} [options] `quiet` suppresses the summary line (the reload after a sync).
   */
  function loadCache({ quiet = false } = {}) {
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
    if (!quiet) log(`cache loaded: ${records.size} session(s) from ${store.kind}`)
    loadedOnce = true
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
   * @returns {Promise<{files:number, folded:number, tailed:number, bytesRead:number, loadMs:number, listMs:number, ms:number}>} what this pass did.
   */
  async function refresh() {
    const started = Date.now()
    let loadMs = 0
    if (!loadedOnce) {
      // The first pass of a process is where the stored history comes in — see `loadedOnce`.
      const beforeLoad = Date.now()
      loadCache()
      loadMs = Date.now() - beforeLoad
    }
    const beforeList = Date.now()
    const files = listLogFiles(sessionsRoot)
    const listMs = Date.now() - beforeList
    let folded = 0
    let tailed = 0
    let bytesRead = 0
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
      // The cursor's `fileSize` is the byte offset the last fold consumed, so a log that only grew
      // is folded from there. Everything else — a shorter log, a different path, no cursor, no
      // record to fold into — is a full re-fold, because a tail read assumes the prefix is intact.
      const tailFrom =
        previous && cursor && cursor.path === file && cursor.fileSize > 0 && stat.size > cursor.fileSize
          ? cursor.fileSize
          : 0
      let record = await foldSession(file, tailFrom > 0 ? previous : null, { fromByte: tailFrom })
      let tail = tailFrom > 0 && Boolean(record)
      if (tail && record !== previous) {
        // A tail fold may add a day — a session running past midnight does exactly that — but the
        // days it adds cannot be *older* than the newest one already folded: an append only moves
        // forward. An older day means the file was rewritten in place, so the prefix this pass did
        // not look at is not the prefix the record was built from; fold that session from the start.
        let newest = ''
        for (const date of previous.days?.keys() ?? []) if (date > newest) newest = date
        const stale = newest !== '' && record.touchedDates?.some((date) => date < newest)
        if (stale) {
          record = await foldSession(file, previous, {})
          tail = false
        }
      } else if (!record) {
        tail = false
      }
      if (record) {
        bytesRead += tail && tailFrom > 0 ? Math.max(0, (record.fileSize ?? 0) - tailFrom) : (record.fileSize ?? 0)
        delete record.touchedDates
        delete record.foldedBytes
      }
      // `foldSession` hands the previous record straight back when it could not read the log, and
      // that record is already in the store — writing it again would replace the session's rows
      // with only the days this process happens to hold (the loading window), deleting the older
      // ones on the way past. Leaving the cursor untouched also means the next refresh retries the
      // fold, which is what a transient read failure wants.
      if (record && record !== previous) {
        folded++
        if (tail) tailed++
        // Written back one session at a time, right here: a save costs the changed session's
        // days, not the whole history, so there is nothing to batch and no timer to lose it in.
        //
        // What the store hands back is what this process must go on believing. It is normally
        // the fold just produced, but when the log got shorter the store keeps the fuller copy
        // it already had — and then *that* is the truth, because the whole point of the row
        // model is that a shortened log cannot make history disappear.
        //
        // `keepOtherDays` is what makes a tail fold safe to write: the record it carries covers
        // the loading window, not the session's whole history, so the days outside the window are
        // this process's blind spot rather than rows the log no longer has.
        let effective = record
        try {
          effective = store.put(record, { source: LOCAL_SOURCE, keepOtherDays: tail }) ?? record
        } catch (error) {
          log(`cache write failed for ${sessionId}: ${error?.message ?? error}`)
        }
        records.set(sessionId, effective)
        cursors.set(sessionId, {
          seq: record.seq,
          provider: record.provider,
          model: record.model,
          fileSize: record.fileSize,
          fileMtimeMs: record.fileMtimeMs,
          path: record.path,
        })
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
    lastRefresh = { files: files.length, folded, tailed, bytesRead, loadMs, listMs, ms: Date.now() - started, at: Date.now() }
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
