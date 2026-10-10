/**
 * dsh-usage-badge — the shard format and the two directions of a sync.
 *
 * The cache's own store stays local; this module is the **export/import boundary**. It lives apart
 * from the store because it needs two things the store must not know about:
 *
 *   - **a wire format.** One shard is one calendar month of one device's rows, as NDJSON compressed
 *     with `zstd` (`node:zlib`, already used to read `.jsonl.zstd` logs). A month is the granularity
 *     because a day would mean hundreds of files and a request each, while a year would mean
 *     re-uploading ~27 MB whenever any single day inside it changed.
 *   - **a manifest.** Each device publishes **its own** `index.json`, listing the shards it wrote
 *     with a sha256 each. There is deliberately no shared manifest: a file two devices both wrote
 *     would need locking, and this design has no locking.
 *
 * ## What a device must never publish
 *
 * Only rows with `source = local` are exported. A row that *arrived* from another device is stored so
 * the panel can count it, but exporting it back would make this device claim another's history — and
 * if that other device then deleted it, the copy here would resurrect it forever.
 *
 * `fallback` rows are not exported either: they are copies of a log version this device has already
 * moved past, kept as local insurance rather than as history to publish.
 *
 * ## The import side
 *
 * A shard's rows carry their own `source` (the id of the device that wrote them) and their own
 * stamp, and are handed to the store as they are. The store then applies the rule it applies to any
 * weak copy: a row that is not strictly fuller than the one already held for that `(session, date,
 * source, slot)` is dropped. That is what stops a machine whose logs were pruned from overwriting the
 * fuller history another machine still has.
 *
 * @module dsh-usage-badge/sync
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

import { CURRENT, FALLBACK, LOCAL_SOURCE, rowKind, rowSource } from './buckets.js'
import { WebDavClient } from './webdav.js'

/** The shard format this build writes. A shard of another version is refused, not guessed at. */
export const SHARD_VERSION = 1

/** The manifest format this build writes. */
export const MANIFEST_VERSION = 1

/** The file extension a shard carries; the file name is its month. */
export const SHARD_EXTENSION = '.ndjson.zst'

/** Everything this plugin owns on the server lives under this prefix. */
export const REMOTE_PREFIX = 'usage-badge/'

/**
 * A file beside each device's `index.json`.
 *
 * Apache's `PROPFIND` lists the collections under `usage-badge/`, which is how a device discovers
 * the others — but a collection holding only `index.json` may list without its `index.json` (the
 * server is free to omit a member), and discovery is the one thing that must not depend on which of
 * the two a reader happens to see. So each device directory also gets this small marker, created
 * right after the collection and never rewritten: if a reader can see the directory at all, it sees
 * the marker, and a directory without it is treated as half-created rather than as a device.
 */
export const DEVICE_MARKER = '.device'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/** The month a day key belongs to: `2026-09-14` → `2026-09`. */
export const monthOf = (date) => String(date ?? '').slice(0, 7)

/** One shard's path, given a device id and a month. */
export const shardPath = (device, key) => `${REMOTE_PREFIX}${device}/${key}${SHARD_EXTENSION}`

/** One device's manifest path. */
export const manifestPath = (device) => `${REMOTE_PREFIX}${device}/index.json`

/**
 * A device id as it may appear in a path: no slashes, no traversal, nothing exotic.
 *
 * `local` is refused on purpose. A device's own rows are stored with `source = 'local'` until they are
 * exported, and `chunkRows` decides ownership by that exact value — so a device *named* `local` would
 * make every other device mistake its rows for their own and re-publish them under their own name, after
 * which this device's own fold could delete them. The name is a path segment and an ownership tag; it
 * cannot be the tag that means "not from the sync".
 */
export const safeDeviceId = (device) => {
  const id = String(device ?? '').trim()
  if (id === LOCAL_SOURCE) throw new Error(`\`${LOCAL_SOURCE}\` is reserved for this machine's own rows and cannot be a device id`)
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || id === '.' || id === '..') {
    throw new Error(`a device id must be 1-64 of [A-Za-z0-9._-], got ${JSON.stringify(device)}`)
  }
  return id
}

/** A shard key as it may appear in a path: exactly one `YYYY-MM`. */
export const safeShardKey = (key) => {
  const value = String(key ?? '').trim()
  if (!/^\d{4}-\d{2}$/.test(value)) throw new Error(`a shard key must be YYYY-MM, got ${JSON.stringify(key)}`)
  return value
}

/**
 * One device's local rows grouped into month shards.
 *
 * Only this installation's own `current` rows are exported (`owns` selects them; it is a parameter so a
 * test can exercise the filter without pretending to be another device). Each row is copied out with its
 * `sessionId` attached, because a shard has to be able to rebuild a session record on the other side.
 *
 * `owns` is usually `'local'`, but it may be a **set** of names: after a rename, a device pulls its own
 * previous directory and imports those rows under the old name, and they are still this installation's
 * history. Leaving them out means the device counts them (they resolve like any other row) while never
 * publishing them, so a fresh machine sees less than its owner does — 18766 against 10000 in the case this
 * was found with. A name only gets here after being checked against this installation's `instanceId`, so
 * another machine's rows are never claimed.
 *
 * @param {object[]} records - records as `store.scan()` returns them, each with a `rows` array.
 * @param {{owns?:string|string[]}} [options]
 * @returns {Map<string, object[]>} shard key → rows, sorted by date then session.
 */
export function chunkRows(records, { owns = LOCAL_SOURCE } = {}) {
  const owners = new Set(Array.isArray(owns) ? owns : [owns])
  const shards = new Map()
  for (const record of records ?? []) {
    for (const row of record?.rows ?? []) {
      if (!owners.has(rowSource(row))) continue
      if (rowKind(row) === FALLBACK) continue
      const key = monthOf(row.date)
      if (!/^\d{4}-\d{2}$/.test(key)) continue
      let list = shards.get(key)
      if (!list) {
        list = []
        shards.set(key, list)
      }
      list.push({
        date: row.date,
        source: rowSource(row),
        kind: CURRENT,
        seq: Number(row.seq) || 0,
        fileSize: Number(row.fileSize) || 0,
        fileMtimeMs: Number(row.fileMtimeMs) || 0,
        at: Number(row.at) || 0,
        sessionId: String(record.sessionId ?? ''),
        path: String(record.path ?? ''),
        routes: row.routes ?? {},
      })
    }
  }
  for (const list of shards.values()) {
    list.sort((a, b) => (a.date === b.date ? (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0) : a.date < b.date ? -1 : 1))
  }
  return shards
}

/**
 * One shard's bytes: a header line, then one JSON row per line, compressed as a whole.
 *
 * Two properties are load-bearing:
 *
 *   - **the bytes are deterministic.** Nothing about *when* the shard was written goes into them, so
 *     the upload plan can decide "this month did not change" by comparing a content hash. If the
 *     timestamp were part of the payload, every re-plan would look like a new revision and every sync
 *     would re-upload everything. When a month was written is manifest metadata, not shard data.
 *   - **a row's `source` is rewritten to the publishing device.** A row stored here says
 *     `source = local`, meaning "this device folded it"; on the receiving side the same bytes must
 *     mean "device `<id>` published it". Carrying `local` across would make the receiver treat
 *     another machine's history as **its own** — it would then publish it onward under its own name,
 *     and a later fold here could delete rows it does not own.
 *
 *     For the same reason every **other** name of this installation is rewritten too: a device that has
 *     been renamed re-publishes rows it once imported under its old name, and they are published *now* by
 *     this name. Leaving the old name in them would put a source in the receiver's store that no directory
 *     on the server answers for.
 */
export function encodeShard(rows, { device }) {
  const id = safeDeviceId(device)
  const header = JSON.stringify({ v: SHARD_VERSION, device: id })
  // Everything in a shard was published by the device whose name is on it: `chunkRows` only ever hands over
  // this installation's own rows, so the source is stamped rather than inherited.
  const body = [header, ...rows.map((row) => JSON.stringify({ ...row, source: id }))].join('\n')
  const compressed = zstdCompressSync(Buffer.from(body, 'utf8'))
  return { body: compressed, sha256: sha256(compressed), rows: rows.length }
}

/**
 * Decode one shard.
 *
 * A shard whose version is not this build's is refused **by name** rather than parsed leniently: a
 * half-understood shard would be merged as if it were understood, and the result would be wrong
 * numbers that look right.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {{version:number, device:string, exportedAt:number, rows:object[]}}
 */
export function decodeShard(buffer) {
  let text
  try {
    text = zstdDecompressSync(buffer).toString('utf8')
  } catch (error) {
    throw new Error(`a shard could not be decompressed: ${error?.message ?? error}`)
  }
  const lines = text.split('\n')
  if (!lines[0]) throw new Error('a shard is empty')
  let header
  try {
    header = JSON.parse(lines[0])
  } catch (error) {
    throw new Error(`a shard header is not JSON: ${error?.message ?? error}`)
  }
  if (header?.v !== SHARD_VERSION) {
    throw new Error(`a shard is version ${String(header?.v)}, but this build writes version ${SHARD_VERSION}`)
  }
  const rows = []
  let malformed = 0
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue
    let row
    try {
      row = JSON.parse(lines[i])
    } catch {
      malformed++
      continue
    }
    if (typeof row?.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
      malformed++
      continue
    }
    rows.push({
      date: row.date,
      source: String(row.source ?? header.device ?? LOCAL_SOURCE),
      kind: row.kind === FALLBACK ? FALLBACK : CURRENT,
      seq: Number(row.seq) || 0,
      fileSize: Number(row.fileSize) || 0,
      fileMtimeMs: Number(row.fileMtimeMs) || 0,
      at: Number(row.at) || 0,
      sessionId: String(row.sessionId ?? ''),
      routes: row.routes && typeof row.routes === 'object' ? row.routes : {},
    })
  }
  return { version: header.v, device: String(header.device ?? ''), exportedAt: Number(header.at) || 0, rows, malformed }
}

/** One chunk's manifest entry, describing the bytes that were actually written. */
export function chunkEntry({ device, key, body, rows, at }) {
  const dates = rows.map((row) => row.date).sort()
  return {
    key,
    path: shardPath(device, key),
    from: dates[0] ?? '',
    to: dates[dates.length - 1] ?? '',
    bytes: body.length,
    sha256: sha256(body),
    rows: rows.length,
    at,
  }
}

/** A device's manifest: what this device has published. */
export function buildManifest({ device, label = '', chunks = {}, at = Date.now(), instanceId = '' }) {
  // `instanceId` is written so that the *other* installations can tell whether the name in this
  // directory is theirs. Two machines that both call themselves `office` would otherwise each overwrite
  // the other's month — the shard path is the same — and the rows would be gone with no warning at all.
  return { v: MANIFEST_VERSION, device, label, generatedAt: at, instanceId, chunks }
}

/** Parse a manifest, refusing a version this build does not write and a device id it cannot use. */
export function parseManifest(text) {
  let raw
  try {
    raw = typeof text === 'string' || Buffer.isBuffer(text) ? JSON.parse(text.toString('utf8')) : text
  } catch (error) {
    throw new Error(`the manifest is not JSON: ${error?.message ?? error}`)
  }
  if (raw?.v !== MANIFEST_VERSION) {
    throw new Error(`the manifest is version ${String(raw?.v)}, but this build writes version ${MANIFEST_VERSION}`)
  }
  const device = safeDeviceId(raw.device)
  const chunks = {}
  for (const [key, entry] of Object.entries(raw.chunks ?? {})) {
    if (!entry || typeof entry !== 'object' || typeof entry.sha256 !== 'string') continue
    chunks[key] = {
      key,
      path: String(entry.path ?? shardPath(device, key)),
      from: String(entry.from ?? ''),
      to: String(entry.to ?? ''),
      bytes: Number(entry.bytes) || 0,
      sha256: entry.sha256,
      rows: Number(entry.rows) || 0,
      at: Number(entry.at) || 0,
    }
  }
  return { version: raw.v, device, label: String(raw.label ?? ''), generatedAt: Number(raw.generatedAt) || 0, instanceId: String(raw.instanceId ?? ''), chunks }
}

/**
 * Decide what to upload: the shards whose bytes differ from what this device last published.
 *
 * The comparison is by **content hash**, not by date or mtime: the sync is incremental and has to
 * skip a month that has not changed, and a re-fold that reproduces identical bytes must not become
 * an upload just because it happened.
 *
 * @param {Map<string, object[]>} shards - as {@link chunkRows} returns.
 * @param {object} [previous] - the manifest this device published last time, or `{}`.
 * @returns {{pending: Array<{key:string, body:Buffer, entry:object, rows:number}>, manifest:object, unchanged:number}}
 */
export function planUpload(shards, previous = {}, { device, label = '', at = Date.now(), instanceId = '' } = {}) {
  const safeDevice = safeDeviceId(device)
  const chunks = { ...(previous?.chunks ?? {}) }
  const pending = []
  let unchanged = 0
  for (const [key, rows] of [...(shards ?? new Map())].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const { body } = encodeShard(rows, { device: safeDevice })
    const hash = sha256(body)
    const known = chunks[key]
    if (known?.sha256 === hash) {
      // Left exactly as published, timestamp included: re-stamping it would say the month changed.
      unchanged++
      continue
    }
    const entry = chunkEntry({ device: safeDevice, key, body, rows, at })
    chunks[key] = entry
    pending.push({ key, body, entry, rows: rows.length })
  }
  return { pending, unchanged, manifest: buildManifest({ device: safeDevice, label, chunks, at, instanceId }) }
}

/**
 * The shards a reader should fetch.
 *
 * `windowYears` bounds the **first** pull: a decade of history is real, but downloading all of it
 * before the panel shows anything would be the worst first impression this feature could make. The
 * bound applies to fetching, never to keeping — shards already held stay held, and each device's
 * manifest still lists everything it has.
 *
 * @param {{manifests:object[], held?:object, now?:number, windowYears?:number, except?:string}} options
 *   `held` maps `<device>/<key>` to the sha256 this reader already applied. `except` is the reader's
 *   own device id: its own manifest lists what it published, which is already in its store.
 */
export function planDownload({ manifests, held = {}, now = Date.now(), windowYears = 5, except = '' }) {
  const cutoff = `${new Date(now).getFullYear() - Math.max(0, windowYears) + 1}-01`
  const wanted = []
  for (const manifest of manifests ?? []) {
    if (except && manifest?.device === except) continue
    for (const [key, entry] of Object.entries(manifest?.chunks ?? {})) {
      if (!entry?.path || !entry?.sha256) continue
      if (windowYears > 0 && key < cutoff) continue
      if (held[`${manifest.device}/${key}`] === entry.sha256) continue
      wanted.push({ device: manifest.device, key, entry })
    }
  }
  wanted.sort((a, b) => (a.key === b.key ? (a.device < b.device ? -1 : 1) : a.key < b.key ? -1 : 1))
  return wanted
}

/**
 * Turn decoded shard rows into the records the store's import takes.
 *
 * Grouped by `(source, sessionId)` because that is the store's write unit, and every row keeps the
 * stamp it was written with: the receiving store compares those stamps to decide whether the
 * incoming copy is worth storing at all. The cursor fields on the record are the best stamp among
 * its rows, so a caller that only needs "the newest log version this device knows" can read them.
 */
export function rowsToRecords(rows) {
  const bySource = new Map()
  for (const row of rows ?? []) {
    if (!row?.sessionId) continue
    const key = `${row.source}\u0000${row.sessionId}`
    let record = bySource.get(key)
    if (!record) {
      record = { sessionId: row.sessionId, path: '', source: row.source, rows: [] }
      bySource.set(key, record)
    }
    record.rows.push(row)
  }
  for (const record of bySource.values()) {
    const best = record.rows.reduce((top, row) => (top === null || row.seq > top.seq || (row.seq === top.seq && row.fileSize > top.fileSize) ? row : top), null)
    record.seq = best?.seq ?? -1
    record.fileSize = best?.fileSize ?? 0
    record.fileMtimeMs = best?.fileMtimeMs ?? 0
  }
  return [...bySource.values()]
}

/** A short, display-safe prefix of a hash, for logs and the panel. */
export const shortHash = (hash) => String(hash ?? '').slice(0, 12)

// ── the price table: one shared file, and one copy per device ────────────────

/** The shared price table, which every device reads and the last writer wins. */
export const PRICING_FILE = `${REMOTE_PREFIX}pricing.json`

/** The price table this device wrote, kept so a conflict can always be resolved by hand. */
export const pricingDevicePath = (device) => `${REMOTE_PREFIX}${safeDeviceId(device)}/pricing-${safeDeviceId(device)}.json`

/** Byte-exact comparison, since the plan is about *whether* the file changed, not how. */
const sameBytes = (a, b) => (a === null || b === null ? a === b : Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0)

/**
 * Decide what to do about the shared price table.
 *
 * The price table is the one thing here that a human writes by hand, so it cannot be merged by a
 * rule — two people editing the same table is a decision only a person can make. What this can do is
 * tell the three cases apart without ever losing a version:
 *
 *   - **nothing changed** (`remote === baseline`) → do nothing, whichever device wrote last;
 *   - **only the remote moved** → take it;
 *   - **only we moved** → publish ours;
 *   - **both moved, differently** → a conflict: the remote is kept beside ours as
 *     `.conflict-pricing-<device>-<at>.json` before either wins, and the later `at` wins. Losing a
 *     price row silently is exactly the outcome this whole design is built to avoid.
 *
 * @param {{localBytes?:Buffer|null, remoteBytes?:Buffer|null, baseline?:string|null,
 *   localAt?:number, remoteAt?:number, device?:string, at?:number}} options
 * @returns {{action:'none'|'pull'|'push'|'conflict', winner:'local'|'remote'|null, conflictFile:string|null}}
 */
export function planPricing({ localBytes = null, remoteBytes = null, baseline = null, localAt = 0, remoteAt = 0, device = '', at = 0 } = {}) {
  const localHash = localBytes === null ? null : sha256(localBytes)
  const remoteHash = remoteBytes === null ? null : sha256(remoteBytes)
  // A missing local file means "we have not published anything yet", not "we changed something":
  // otherwise a fresh install calls the server's very first table a conflict. An *empty* file is a
  // different thing — it exists, and it is not what the server has.
  const localChanged = localHash === null ? baseline !== null : localHash !== baseline
  const remoteChanged = remoteHash !== null && remoteHash !== baseline

  // Nothing to take and nothing to publish: either both sides agree, or the file we published is
  // still the one on the server.
  if (!localChanged && !remoteChanged) return { action: 'none', winner: null, conflictFile: null }
  if (!localChanged && remoteChanged) return { action: 'pull', winner: 'remote', conflictFile: null }
  if (localChanged && !remoteChanged) return { action: 'push', winner: 'local', conflictFile: null }
  if (sameBytes(localBytes, remoteBytes)) return { action: 'none', winner: 'remote', conflictFile: null }

  // Both sides changed, and they disagree. Keep the one that would have been lost.
  const winner = remoteAt >= localAt ? 'remote' : 'local'
  const loserPath = remoteAt >= localAt ? localBytes : remoteBytes
  const conflictFile = device && loserPath !== null ? `.conflict-pricing-${safeDeviceId(device)}-${at || Date.now()}.json` : null
  return { action: 'conflict', winner, conflictFile }
}

// ── the data directory is owned by one process at a time ─────────────────────

/** The lock file a host holds while it may write this data directory. */
export const LOCK_FILE = 'host.lock'

/**
 * Whether the process that wrote a lock file is still alive.
 *
 * `process.kill(pid, 0)` is the portable probe: it sends no signal, and its failure modes separate
 * "no such process" (ESRCH — the lock is stale, take it) from "not allowed to signal it" (EPERM —
 * there *is* a process, and on Windows that is the normal answer for a process owned by another
 * session). Anything else is treated as "cannot tell", which means **not** taking the lock: a
 * second writer is worse than a read-only instance.
 */
export function processLooksAlive(pid) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return false
  if (value === process.pid) return true
  try {
    process.kill(value, 0)
    return true
  } catch (error) {
    const code = error?.code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    return true
  }
}

/**
 * Write the lock, and read back what a previous holder left.
 *
 * `process.pid` alone is not enough: pid reuse after a crash would make a live-looking lock out of a
 * dead process. Comparing the recorded process start time catches that, and the comparison is
 * deliberately lax — a mismatch in the *started* field only downgrades the lock to "someone else
 * holds it", which is the safe direction.
 */
export function readLock(dir) {
  const path = join(dir, LOCK_FILE)
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return {
      pid: Number(raw?.pid) || 0,
      startedAt: Number(raw?.startedAt) || 0,
      instanceId: String(raw?.instanceId ?? ''),
      hostname: String(raw?.hostname ?? ''),
      at: Number(raw?.at) || 0,
    }
  } catch {
    return null
  }
}

/** Whether a lock belongs to a process that is no longer running. */
export const lockIsStale = (lock) => lock === null || !processLooksAlive(lock.pid)

/** Just this process's own start, in epoch ms. */
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000)

/**
 * Try to take ownership of a data directory.
 *
 * Ownership decides who may *write*: the cache, the fold, and the sync all need one writer, and the
 * sync needs it most — two processes sharing a `deviceId` would each believe the same remote shard is
 * theirs to overwrite. The caller that fails here is not broken and does not refuse to start: it
 * uses the cache read-only and skips syncing, which is what the design promises for this case.
 *
 * @returns {{acquired:boolean, owner?:object, reason?:string}}
 */
export function acquireLock(dir, { instanceId, log = () => {} } = {}) {
  try {
    // Creating the data directory is part of taking the lock, and it can fail for reasons that have
    // nothing to do with a lock: a read-only home, or a `storages` that turned out to be a file. Those are
    // reported like any other "cannot write here" — an exception escaping here reached the panel as a 500
    // with no explanation.
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    return { acquired: false, owner: null, reason: `the data directory cannot be created: ${error?.message ?? error}` }
  }
  const path = join(dir, LOCK_FILE)
  const existing = readLock(dir)
  if (existing && !lockIsStale(existing)) {
    return {
      acquired: false,
      owner: existing,
      reason: `this data directory is open by another DSH instance (pid ${existing.pid} on ${existing.hostname || 'this host'})`,
    }
  }
  if (existing) log(`taking over a stale ${LOCK_FILE} left by pid ${existing.pid}`)
  const body = { pid: process.pid, startedAt: PROCESS_STARTED_AT, instanceId, hostname: hostname(), at: Date.now() }
  try {
    writeFileSync(path, JSON.stringify(body))
  } catch (error) {
    return { acquired: false, owner: null, reason: `could not write ${LOCK_FILE}: ${error?.message ?? error}` }
  }
  return { acquired: true, owner: body }
}

/** Release the lock, but only if this process is the one holding it. */
export function releaseLock(dir) {
  const existing = readLock(dir)
  if (!existing || existing.pid !== process.pid) return false
  try {
    unlinkSync(join(dir, LOCK_FILE))
    return true
  } catch {
    return false
  }
}

// ── sync.json: what the user configured, and what the last run learned ───────

/** The file holding the sync configuration and the last run's state. */
export const SYNC_FILE = 'sync.json'

/** The defaults a sync configuration starts from. */
export const defaultSyncConfig = () => ({
  enabled: false,
  url: '',
  username: '',
  realm: '',
  ha1: '',
  allowInsecureTls: false,
  deviceId: '',
  deviceLabel: hostname(),
  instanceId: '',
  windowYears: 5,
})

/** Read `sync.json`, or a default document when it is missing or unreadable. */
export function readSyncDocument(dir, log = () => {}) {
  const path = join(dir, SYNC_FILE)
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (!raw || typeof raw !== 'object') return { ...defaultSyncConfig(), state: {}, known: {} }
    return { ...defaultSyncConfig(), ...raw }
  } catch (error) {
    if (error?.code !== 'ENOENT') log(`${SYNC_FILE} could not be read (${error?.message ?? error}); using the defaults`)
    return { ...defaultSyncConfig(), state: {}, known: {} }
  }
}

/** Write `sync.json` atomically, so a crash cannot leave a half-written configuration. */
export function writeSyncDocument(dir, document) {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, SYNC_FILE)
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, JSON.stringify(document, null, 2))
  try {
    renameSync(temp, path)
  } catch {
    try {
      unlinkSync(path)
    } catch {
      // absent is fine
    }
    renameSync(temp, path)
  }
  return path
}

// ── the orchestration: discover, pull, push ──────────────────────────────────

/**
 * One device's view of the whole remote, kept between runs.
 *
 * `known.shards` maps `<device>/<key>` to the sha256 already applied, which is what makes a second
 * run cheap: it is also the record that proves a shard was read rather than merely listed. It is
 * rebuilt from the remote on every run, so losing it costs a re-download and nothing else.
 */
export const defaultSyncState = () => ({
  lastSyncAt: 0,
  lastResult: 'never',
  message: '',
  held: {},
  published: {},
})

/**
 * The remote orchestration.
 *
 * It owns the order of operations, because the order is the correctness argument: take the lock,
 * **pull before pushing** (so a shard this device is about to overwrite is already accounted for),
 * import into the store, publish only what changed, and write the manifest last — a manifest that
 * names a shard which is not there yet would send every other device after a 404.
 */
export class SyncEngine {
  /**
   * @param {{dataDir:string, store?:object, log?:Function, client?:object, now?:Function,
   *   config?:object, state?:object, instanceId?:string}} options
   *   `store` may be null: a sync without a store still publishes and reads manifests, which is what
   *   the first step's live check exercises.
   */
  constructor({ dataDir, store = null, log = () => {}, client = null, now = Date.now, config = null, state = null, instanceId = '' }) {
    this.dataDir = dataDir
    this.store = store
    this.log = log
    this.now = now
    const document = config ? { ...defaultSyncConfig(), ...config } : readSyncDocument(dataDir, log)
    this.config = document
    this.state = state ?? { ...defaultSyncState(), ...(document.state ?? {}) }
    this.instanceId = instanceId || document.instanceId || `${hostname()}-${process.pid}`
    this.client = client
    this.lock = null
    this.ownsLock = false
  }

  /**
   * Give up ownership of the data directory.
   *
   * Called on unload by the host half, and by anything embedding this engine for one run. It only
   * removes a lock this engine took: a lock handed in by the caller belongs to the caller.
   */
  release() {
    if (!this.ownsLock) return false
    const released = releaseLock(this.dataDir)
    this.ownsLock = false
    return released
  }

  get deviceId() {
    return this.config.deviceId
  }

  /** Persist the configuration (and the latest state) to `sync.json`. */
  save({ config = {}, state = {} } = {}) {
    this.config = { ...this.config, ...config, instanceId: this.instanceId }
    this.state = { ...this.state, ...state }
    writeSyncDocument(this.dataDir, { ...this.config, state: this.state })
    return this.config
  }

  /** A WebDAV client for the configured server, or a clear failure. */
  connect() {
    if (this.client) return this.client
    const { url, username, ha1 } = this.config
    if (!url) throw new Error('no WebDAV URL is configured')
    if (!username) throw new Error('no WebDAV username is configured')
    if (!ha1) throw new Error('no WebDAV credential is configured')
    return new WebDavClient({
      baseUrl: url,
      username,
      // The stored secret is the digest HA1 — `MD5(user:realm:pass)`, exactly what the server keeps in
      // its own password file. Passing it as `passwordHash` means the plaintext never has to be
      // written down here, and the response is still the one the server expects.
      passwordHash: ha1,
      allowInsecureTls: Boolean(this.config.allowInsecureTls),
    })
  }

  /**
   * The device directories under `usage-badge/`.
   *
   * It lists the `usage-badge/` collection itself rather than the root: the root's children include
   * the collection's own name, and treating that as a device would send this sync after
   * `usage-badge/usage-badge/index.json`. A collection that does not exist yet means an empty list —
   * the first device to sync creates it.
   */
  async discover(client) {
    let entries
    try {
      entries = await client.propfind(REMOTE_PREFIX)
    } catch (error) {
      // `PROPFIND` answers 404 for a path that has no collection yet; that is "nothing here", not a
      // failure to talk to the server.
      if (/answered 404/.test(String(error?.message ?? ''))) return []
      throw new Error(`could not list ${REMOTE_PREFIX}: ${error?.message ?? error}`)
    }
    const devices = []
    for (const entry of entries) {
      if (!entry.collection) continue
      const name = String(entry.path ?? entry.name).replace(/\/+$/, '').split('/').pop() ?? ''
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(name) || name === '.' || name === '..') continue
      devices.push(name)
    }
    return devices
  }

  /** Read one device's manifest, or null when it has none yet. */
  async readManifest(client, device) {
    const body = await client.get(manifestPath(device))
    if (body === null) return null
    try {
      return parseManifest(body)
    } catch (error) {
      // A manifest that cannot be parsed is reported and skipped: refusing the whole sync over one
      // unreadable device would stop the devices that are fine.
      this.log(`manifest of ${device} could not be read: ${error?.message ?? error}`)
      return null
    }
  }

  /** Everything the remote knows, as manifests. */
  async readManifests(client) {
    const devices = await this.discover(client)
    const manifests = []
    for (const device of devices) {
      const manifest = await this.readManifest(client, device)
      if (manifest) manifests.push(manifest)
    }
    return manifests
  }

  /**
   * Pull: fetch the shards this device does not already hold, and store their rows.
   *
   * @returns {{fetched:number, rows:number, failed:Array<{path:string, error:string}>}}
   */
  async pull(client, manifests) {
    const wanted = planDownload({
      manifests,
      held: this.state.held ?? {},
      now: this.now(),
      windowYears: Number(this.config.windowYears) || 0,
      // This device's own manifest is not something to fetch: it lists the shards this device
      // published, and its rows are already in this store under their local source. Reading them back
      // would re-attribute them to this device's id and import duplicates of what is already here.
      //
      // Unless that directory is **someone else's**, which is the name clash: the shards in it are then a
      // history this machine does not have, and it is exactly the history a reinstalled machine came
      // back for. Importing them is safe — the merge key is the session, not the device — and the
      // alternative is an empty panel until the user resolves a naming question they may not understand.
      //
      // The decision comes from **this run's** finding, never from the persisted `state.collision`: a
      // refusal can stay recorded for months, and reading one's own directory because of a stale note
      // means re-fetching one's own shards — including the half-written one that caused the refusal.
      except: this.pullOwnDirectory ? '' : this.deviceId,
    })
    let rows = 0
    let fetched = 0
    const failed = []
    for (const item of wanted) {
      let body
      try {
        body = await client.get(item.entry.path)
      } catch (error) {
        failed.push({ path: item.entry.path, error: String(error?.message ?? error) })
        continue
      }
      if (body === null) {
        failed.push({ path: item.entry.path, error: 'the manifest lists a shard the server does not have' })
        continue
      }
      let decoded
      try {
        decoded = decodeShard(body)
      } catch (error) {
        failed.push({ path: item.entry.path, error: String(error?.message ?? error) })
        continue
      }
      // A shard whose hash does not match its manifest is not stored: the store keeps whatever is
      // newer, so importing a truncated month could not be undone by re-importing the good one.
      if (item.entry.sha256 && item.entry.sha256 !== sha256(body)) {
        failed.push({ path: item.entry.path, error: 'the shard does not match the hash its manifest advertises' })
        continue
      }
      // A shard that does not decode into every row its manifest advertises is **not** remembered as
      // applied. The good rows are still imported (that is idempotent), but advancing `held` would mark the
      // month done forever while some of it was silently dropped — the row count and the manifest disagree,
      // and the honest answer is to keep asking. This build never writes such a shard; an older one or a
      // hand-made file can.
      if (decoded.malformed > 0 || (item.entry.rows > 0 && decoded.rows.length !== item.entry.rows)) {
        this.store?.intakeRows(decoded.rows)
        failed.push({
          path: item.entry.path,
          error: `the shard holds ${decoded.rows.length} of the ${item.entry.rows || decoded.rows.length} rows its manifest names` + (decoded.malformed ? ` (${decoded.malformed} unreadable line(s))` : ''),
        })
        continue
      }
      if (this.store) {
        this.store.intakeRows(decoded.rows)
        // `held` is only advanced once the rows are in the store: if the import throws, the shard
        // must be fetched again rather than remembered as applied.
        this.state.held = { ...(this.state.held ?? {}), [`${item.device}/${item.key}`]: item.entry.sha256 }
      }
      rows += decoded.rows.length
      fetched++
    }
    return { fetched, rows, failed }
  }

  /**
   * Push: publish this device's changed months, then its manifest.
   *
   * The manifest is written **last** on purpose. A manifest naming a shard that has not landed yet
   * would send every other device after a 404 on their next run.
   */
  async push(client) {
    if (!this.store) return { uploaded: 0, unchanged: 0, bytes: 0, shards: [], refused: null }
    // Whose name is this? The shard path is `usage-badge/<device>/<month>`, so a second installation
    // using the same device name does not merge with the first — it **overwrites** its months, and the
    // rows are gone. Nothing about the bytes reveals that, so it has to be caught here, where the answer
    // is "do not write" rather than "write and hope".
    //
    // The owner is recorded in the directory's own manifest. A directory with no recorded owner is one
    // published by a build that did not write the field (or the first publish of anything), and adopting
    // it is what makes an upgrade work; an owner that is a *different* installation is a real clash.
    const discovered = await this.readManifests(client)
    const remote = discovered.find((manifest) => manifest.device === this.deviceId)
    // **This installation**, not this name. A rename leaves the previous directory behind with its own
    // manifest, and every reader treats every manifest it finds as authoritative — so a month withdrawn
    // after a rename would come straight back through the old name. The `instanceId` is what identifies the
    // installation across names; two installations never share one, and a manifest without one is not ours
    // to speak for.
    const mine = this.instanceId ? discovered.filter((manifest) => manifest.instanceId === this.instanceId) : []
    if (remote && remote.instanceId && remote.instanceId !== this.instanceId) {
      this.state.collision = { device: this.deviceId, owner: remote.instanceId, at: this.now() }
      this.log(
        `not publishing: usage-badge/${this.deviceId}/ was published by another installation ` +
          `(${remote.instanceId}, this one is ${this.instanceId}). Pulling is unaffected — everything on the ` +
          `server is merged into this device's history. To publish from this machine, give it a device name ` +
          `that is not already there; "usage-badge/${this.deviceId}/" only decides where new months are written.`,
      )
      return { uploaded: 0, unchanged: 0, bytes: 0, shards: [], refused: 'collision' }
    }
    if (remote && !remote.instanceId && !this.instanceId) {
      // No owner on either side: there is no way to tell the two installations apart, and the whole point
      // of the check is not to guess.
      this.state.collision = { device: this.deviceId, owner: null, at: this.now() }
      this.log(`refusing to publish: usage-badge/${this.deviceId}/ exists and neither side has an identity to compare`)
      return { uploaded: 0, unchanged: 0, bytes: 0, shards: [], refused: 'unidentified' }
    }
    delete this.state.collision

    const rows = chunkRows(this.store.scan(), { owns: [LOCAL_SOURCE, this.deviceId, ...mine.map((manifest) => manifest.device)] })
    // `state.published` is the manifest's **chunks map**, so it is wrapped back into a manifest shape
    // here. Passing the map itself would leave `previous.chunks` empty, and every run would re-upload
    // every month while looking perfectly healthy.
    const { pending, unchanged, manifest } = planUpload(rows, { chunks: this.state.published ?? {} }, {
      device: this.deviceId,
      label: this.config.deviceLabel ?? '',
      at: this.now(),
      instanceId: this.instanceId,
    })

    // Is the directory still saying what we last put there? An identity check cannot answer this: a
    // directory copied to another machine carries `sync.json` with it, `instanceId` included, so that
    // machine passes every owner check and then `MOVE`s its months over this one's. The **bytes** answer
    // it — a month we recorded at one hash and the server now holds at another was written by something
    // that was not us, and we have nothing of our own to put there.
    const diverged = Object.entries(this.state.published ?? {}).find(([key, known]) => {
      const remoteEntry = remote?.chunks?.[key]
      if (!remoteEntry || remoteEntry.sha256 === known.sha256) return false
      return !pending.some((item) => item.key === key)
    })
    if (diverged) {
      const [key] = diverged
      this.state.collision = { device: this.deviceId, owner: remote?.instanceId || 'unknown', kind: 'diverged', month: key, at: this.now() }
      this.log(
        `not publishing: usage-badge/${this.deviceId}/${key}.ndjson.zst is not the shard this device last published, ` +
          `and this device has no change of its own for that month — another installation is writing into this directory`,
      )
      return { uploaded: 0, unchanged: 0, bytes: 0, shards: [], refused: 'diverged' }
    }

    // The collection comes **before** anything is written into it. `mod_dav_fs` refuses a write whose
    // parent does not exist (403/409, not the 404 an HTTP client might expect), so creating it on the
    // way past would fail the first publish of a device — and mkcol is idempotent anyway, so it costs
    // nothing to do it here.
    await client.mkcol(`${REMOTE_PREFIX}${this.deviceId}/`)
    let bytes = 0
    const shards = []
    for (const item of pending) {
      // Upload under a temporary name and rename: a crash mid-upload leaves a name nobody reads,
      // instead of a shard that looks complete and is half a month.
      const temp = `${item.entry.path}.upload-${process.pid}-${Math.random().toString(16).slice(2, 8)}`
      await client.put(temp, item.body, { contentType: 'application/octet-stream' })
      try {
        await client.move(temp, item.entry.path, { overwrite: true })
      } catch (error) {
        // Leave no debris behind if the rename fails; a leftover temp file is harmless but untidy.
        await client.delete(temp).catch(() => {})
        throw error
      }
      bytes += item.body.length
      shards.push({ key: item.key, bytes: item.body.length, rows: item.rows })
    }
    // The marker exists before the manifest names the directory a device, and the manifest is written
    // **last** on purpose: a manifest naming a shard that has not landed yet would send every other
    // device after a 404 on their next run.
    await client.put(`${REMOTE_PREFIX}${this.deviceId}/${DEVICE_MARKER}`, Buffer.from(`${this.deviceId}\n`))
    // ── what every other name of this installation must stop claiming ──────────
    //
    // A rename leaves the previous directory behind, and **every reader treats every manifest it finds as
    // authoritative**. So a month that was corrected or dropped after a rename keeps feeding readers its old
    // rows through the old name: the fix is that this installation's own months live in exactly one
    // directory, and every other directory of ours is brought in line with what we actually hold.
    //
    // The comparison is by content hash, not by month: a month can stay while one of its rows goes away
    // (a log version that no longer covers that day), and that difference is invisible to a key-vs-key test.
    // A key we no longer publish at all is simply missing from the current chunks, which is the same test.
    //
    // The current name's manifest is the one `planUpload` built; the others are rebuilt through
    // `buildManifest` — **not** written back as parsed. A parsed manifest carries `version` while the file
    // format is `v`, so writing one back produces a manifest no reader can parse, which would hide that
    // directory's shards from everyone instead of correcting them.
    const targets = new Map([[this.deviceId, manifest]])
    for (const other of mine) {
      if (targets.has(other.device)) continue
      targets.set(other.device, buildManifest({ device: other.device, label: other.label, chunks: { ...other.chunks }, at: other.generatedAt || this.now(), instanceId: other.instanceId }))
    }
    const withdrawals = []
    for (const [key, entry] of Object.entries(manifest.chunks)) {
      if (rows.has(key)) continue
      withdrawals.push({ key, device: this.deviceId, manifest, path: entry.path ?? shardPath(this.deviceId, key) })
    }
    for (const [device, target] of targets) {
      if (device === this.deviceId) continue
      for (const [key, entry] of Object.entries(target.chunks)) {
        const current = manifest.chunks[key]
        if (current && current.sha256 === entry.sha256) continue
        withdrawals.push({ key, device, manifest: target, path: entry.path ?? shardPath(device, key) })
      }
    }
    // **Delete first, then write.** Each deletion is recorded, and a month whose shard could not be removed
    // stays in the manifest that lists it — so the claim and the bytes never disagree, and the failure is
    // retried on the next run instead of being half-recorded.
    let withdrawn = 0
    const withdrawnKeys = []
    const withdrawErrors = []
    for (const item of withdrawals) {
      try {
        // Gone from the manifest *and* from the server: leaving the bytes behind while dropping the claim
        // would leave a shard nobody lists. These shards are this installation's own, which is the one
        // direction where deleting is not the remote deciding anything.
        await client.delete(item.path)
        delete item.manifest.chunks[item.key]
        withdrawn++
        if (!withdrawnKeys.includes(item.key)) withdrawnKeys.push(item.key)
        this.log(`withdrew ${item.key} from ${item.device}/: this device publishes it under ${this.deviceId}/ or no longer holds it`)
      } catch (error) {
        withdrawErrors.push(`could not withdraw ${item.key} from ${item.device}/: ${error?.message ?? error}`)
      }
    }
    // Written even when a withdrawal failed: the manifests now say exactly what the server holds, and the
    // current one still names every shard that was uploaded above (so `uploaded` is not an exaggeration).
    for (const [device, target] of targets) {
      await client.put(manifestPath(device), Buffer.from(JSON.stringify(target, null, 2)), { contentType: 'application/json' })
    }
    return { uploaded: pending.length, unchanged, bytes, shards, manifest, withdrawn, withdrawnKeys, withdrawErrors }
  }

  /**
   * Reconcile the shared price table.
   *
   * Runs after the shards, because losing a price row is worse than a delayed month: whatever this
   * does, it happens while the shard sync is already recorded as done. The device copy is published
   * first, so that even a conflict the user never looks at leaves both versions on the server.
   *
   * @returns {{action:string, status:string}}
   */
  async syncPricing(client) {
    const localPath = join(this.dataDir, 'pricing.json')
    // A table this device pulled is still "ours" for the next comparison, so local edits are stamped
    // by the file's own mtime rather than by when the last sync happened — otherwise taking a remote
    // copy would make the *next* run see a local change that nobody made.
    const localStamp = () => {
      try {
        return Math.round(statSync(localPath).mtimeMs) || 0
      } catch {
        return 0
      }
    }
    let localBytes = null
    try {
      localBytes = readFileSync(localPath)
    } catch {
      // No price table of our own: the built-in template is in force, and there is nothing to publish.
      localBytes = null
    }
    let remoteBytes = null
    try {
      remoteBytes = await client.get(PRICING_FILE)
    } catch (error) {
      this.log(`the shared price table could not be read (${error?.message ?? error}); leaving ours alone`)
      return { action: 'none', status: 'unreadable' }
    }

    const known = this.state.pricing ?? {}
    const remoteHash = remoteBytes === null ? null : sha256(remoteBytes)
    const plan = planPricing({
      localBytes,
      remoteBytes,
      baseline: known.baseline ?? null,
      localAt: localStamp(),
      remoteAt: known.remoteAt ?? 0,
      device: this.deviceId,
      at: this.now(),
    })

    if (plan.action === 'none') {
      // `baseline` records what the server had when this device last looked. It is only meaningful
      // when there *is* a remote file: writing the hash of nothing would make the next run treat the
      // baseline as a real version and call a fresh install's first sight of the table a conflict.
      this.state.pricing = remoteHash === null ? { ...known, remoteHash } : { ...known, baseline: remoteHash, remoteHash }
      // In step, but the file on disk may not match — a device that has no table of its own, or whose
      // last run left the server's copy as a conflict file, still needs it written out.
      if (remoteBytes !== null && !sameBytes(localBytes, remoteBytes)) {
        writeFileSync(localPath, remoteBytes)
        return { action: 'pull', status: 'took the server’s copy' }
      }
      return { action: plan.action, status: plan.winner ?? 'in step' }
    }

    if (plan.conflictFile) {
      // Written locally, not remotely: a conflict copy is for whoever opens this machine. The losing
      // side is always written, and the winner is never applied over a person's edit — the table is
      // hand-written, so a silent overwrite is the one outcome this must not produce.
      const losing = plan.winner === 'remote' ? localBytes ?? Buffer.alloc(0) : remoteBytes ?? Buffer.alloc(0)
      writeFileSync(join(this.dataDir, plan.conflictFile), losing)
      this.log(`the price table changed on both sides; kept the copy that would have been lost as ${plan.conflictFile}`)
      if (plan.winner === 'local') {
        // Ours is the later write, so it is the one that gets published — and the server's copy has
        // just been saved beside it, so nothing was lost either way.
        if (localBytes !== null) {
          await client.put(pricingDevicePath(this.deviceId), localBytes, { contentType: 'application/json' })
          await client.put(PRICING_FILE, localBytes, { contentType: 'application/json' })
          const hash = sha256(localBytes)
          this.state.pricing = { ...known, baseline: hash, remoteHash: hash, remoteAt: this.now() }
          return { action: plan.action, status: 'published ours' }
        }
      }
      // The server's version is the later write. It is **not** applied over the user's file: their
      // edit stays where it is, and the server's copy is the conflict file that was just written.
      this.state.pricing = { ...known, baseline: remoteHash, remoteHash, remoteAt: this.now() }
      return { action: plan.action, status: 'kept the server’s copy as a conflict file' }
    }

    if (plan.winner === 'remote') {
      writeFileSync(localPath, remoteBytes ?? Buffer.alloc(0))
      this.state.pricing = { ...known, baseline: remoteHash, remoteHash, remoteAt: this.now() }
      return { action: plan.action, status: 'took the server’s copy' }
    }

    if (localBytes !== null) {
      await client.put(pricingDevicePath(this.deviceId), localBytes, { contentType: 'application/json' })
      await client.put(PRICING_FILE, localBytes, { contentType: 'application/json' })
      const hash = sha256(localBytes)
      this.state.pricing = { ...known, baseline: hash, remoteHash: hash, remoteAt: this.now() }
      return { action: plan.action, status: 'published ours' }
    }
    return { action: plan.action, status: 'nothing to publish' }
  }

  /**
   * Publish only the price table, taking and giving the lock itself.
   *
   * This is what the host half calls a moment after an edit. It is deliberately **not** a full run: a
   * price edit has nothing to do with shards, and a full run would drag the whole remote listing along
   * with it. The lock is taken because the edit can land while a full run is in flight, and two writers
   * on one data directory is the case the lock exists for.
   *
   * @param {{lock?:object, instanceId?:string}} [options]
   * @returns {{result:string, status:string, action?:string, message:string}}
   */
  async pushPricing({ lock = null, instanceId = this.instanceId } = {}) {
    if (!this.config.enabled || !this.config.url || !this.config.ha1) {
      return { result: 'skipped', status: 'sync is off or unconfigured', message: 'sync is off or unconfigured' }
    }
    const held = lock ?? acquireLock(this.dataDir, { instanceId, log: this.log })
    if (!held.acquired) return { result: 'locked', status: held.reason, message: held.reason }
    let client
    try {
      client = this.connect()
    } catch (error) {
      const message = String(error?.message ?? error)
      return { result: 'failed', status: message, message }
    }
    try {
      const pricing = await this.syncPricing(client)
      const message = `prices: ${pricing.status}`
      // `unreadable` is not a successful reconcile: the shared table could not be read, so whether this
      // device's edit is safe to publish is unknown — and it is deliberately not published. Recording it
      // as `ok` would tell the panel everything went fine at the exact moment nothing could be checked.
      const failed = pricing.status === 'unreadable' || pricing.action === 'failed'
      this.state.lastSyncAt = this.now()
      this.state.lastResult = failed ? 'failed' : 'ok'
      this.state.message = message
      writeSyncDocument(this.dataDir, { ...this.config, instanceId, state: this.state })
      return { result: failed ? 'failed' : 'ok', status: pricing.status, action: pricing.action, message }
    } catch (error) {
      const message = String(error?.message ?? error)
      this.log(`pricing push failed: ${message}`)
      this.state.lastResult = 'failed'
      this.state.message = `prices: ${message}`
      writeSyncDocument(this.dataDir, { ...this.config, instanceId, state: this.state })
      return { result: 'failed', status: message, message }
    }
  }

  /**
   * One sync: lock, discover, pull, push, price table, record.
   *
   * Every failure is caught and turned into `state.lastResult`, never into a thrown error the caller
   * has to interpret: the panel shows the sentence, and the local cache is untouched either way.
   */
  async run({ lock = null } = {}) {
    const started = this.now()
    if (!this.config.enabled) {
      return this.finish('skipped', 'sync is turned off', { started })
    }
    this.lock = lock ?? acquireLock(this.dataDir, { instanceId: this.instanceId, log: this.log })
    this.ownsLock = lock === null
    if (!this.lock.acquired) {
      // `locked` is not a failure of the sync; it is this process not being the writer. The previous
      // run's timestamp is deliberately left alone, so the panel does not claim a sync just happened.
      this.state.lastResult = 'locked'
      this.state.message = this.lock.reason
      try {
        writeSyncDocument(this.dataDir, { ...this.config, instanceId: this.instanceId, state: this.state })
      } catch (error) {
        this.log(`sync state could not be saved: ${error?.message ?? error}`)
      }
      return { result: 'locked', message: this.lock.reason, ms: this.now() - started }
    }
    let client
    try {
      client = this.connect()
    } catch (error) {
      return this.finish('failed', String(error?.message ?? error), { started })
    }

    try {
      const manifests = await this.readManifests(client)
      // **Pull first, refuse only the push.** An installation whose device name is taken still wants the
      // history back, and that is the case the feature exists for (reinstall, another machine): the name
      // is what is in the way, not the data. So the clash is noted here — which is what tells `pull` to
      // take that directory's shards instead of skipping them as its own — and the refusal itself is
      // `push`'s, where the decision to write is actually made.
      const clash = manifests.find((manifest) => manifest.device === this.deviceId && manifest.instanceId && manifest.instanceId !== this.instanceId)
      if (clash) this.state.collision = { device: this.deviceId, owner: clash.instanceId, at: this.now() }
      else if (this.state.collision && this.state.collision.device !== this.deviceId) delete this.state.collision
      // Read the clashing directory only when the clash is a *name* clash. A directory that merely
      // disagrees with what we recorded is our own, and pulling it back would import a shard we are
      // refusing to publish — the one case where the two readings of `collision` differ.
      this.pullOwnDirectory = Boolean(clash)
      const pulled = await this.pull(client, manifests)
      this.pullOwnDirectory = false
      const pushed = await this.push(client)
      if (pushed.manifest) this.state.published = pushed.manifest.chunks
      // The price table last: it is the only hand-written thing here, and it should not be touched by
      // a run that failed to move the usage it was about to move.
      const pricing = await this.syncPricing(client)
      const parts = [
        `pulled ${pulled.fetched} shard(s) / ${pulled.rows} row(s)`,
        `pushed ${pushed.uploaded} shard(s) / ${Math.round(pushed.bytes / 1024)} KB`,
        `${pushed.unchanged} month(s) unchanged`,
      ]
      if (pushed.refused) {
        // Not `ok`: the months this device folded are not on the server. It is not `failed` either —
        // the pull worked and nothing was lost. Naming it is what lets the panel say what to do.
        parts.push(`nothing published: device name "${this.deviceId}" is being written by another installation`)
      }
      for (const error of pushed.withdrawErrors ?? []) parts.push(error)
      if (pushed.withdrawn) parts.push(`withdrew ${pushed.withdrawn} month(s) this device no longer holds`)
      if (pricing.action !== 'none') parts.push(`prices: ${pricing.status}`)
      if (pulled.failed.length > 0) parts.push(`${pulled.failed.length} shard(s) failed`)
      const message = parts.join(', ')
      this.log(`sync: ${message}`)
      // Four outcomes, each meaning a different thing to the person reading the panel: `ok` moved
      // everything, `partial` moved almost everything, `clash` deliberately published nothing and needs a
      // decision from them, `failed` is a problem with the server or the network.
      const incomplete = pulled.failed.length > 0 || (pushed.withdrawErrors?.length ?? 0) > 0
      const result = pushed.refused ? 'clash' : incomplete ? 'partial' : 'ok'
      return this.finish(result, message, {
        started,
        extra: {
          pulled: pulled.fetched,
          rows: pulled.rows,
          pushed: pushed.uploaded,
          bytes: pushed.bytes,
          pricing: pricing.action,
          failed: pulled.failed,
          refused: pushed.refused ?? null,
          withdrawn: pushed.withdrawn ?? 0,
        },
      })
    } catch (error) {
      const message = String(error?.message ?? error)
      this.log(`sync failed: ${message}`)
      return this.finish('failed', message, { started })
    }
  }

  /**
   * Record the outcome, persist the state, and return it.
   *
   * The state object is **mutated, not replaced**: {@link pull} and {@link push} hold a reference to
   * it while they work, so assigning a fresh object here would silently drop everything they recorded
   * — which is exactly how a sync ends up re-importing every shard on every run.
   */
  finish(result, message, { started, extra = {} } = {}) {
    // `skipped` (sync turned off between scheduling and running) deliberately leaves the timestamp alone:
    // nothing was synced, and stamping it would show "上次同步：刚刚" for a run that never happened. `locked`
    // returns before this, for the same reason.
    if (result !== 'skipped') this.state.lastSyncAt = this.now()
    this.state.lastResult = result
    this.state.message = message
    try {
      writeSyncDocument(this.dataDir, { ...this.config, instanceId: this.instanceId, state: this.state })
    } catch (error) {
      this.log(`sync state could not be saved: ${error?.message ?? error}`)
    }
    return { result, message, ms: this.now() - started, ...extra }
  }
}
