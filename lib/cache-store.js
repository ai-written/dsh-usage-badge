/**
 * dsh-usage-badge — where the folded history is kept between runs.
 *
 * The folder hands this layer one session at a time and asks nothing about storage. Two
 * backends sit behind that interface:
 *
 *   - **sqlite** (default). One row per (session, date) **copy**. A fold compares the session
 *     against its stored rows and writes only the days whose payload actually changed — measured
 *     0.12 ms for a one-day session, and 4.98 ms for a 400-day one (the comparison still reads
 *     those rows, so the cost tracks the changed session's size, not the table's). Loading takes
 *     only the window the panel can show, which bounds resident memory the same way. Older rows
 *     stay on disk, which is the point: history is never deleted, it is just not all held in
 *     memory at once. It uses `node:sqlite`, which ships inside Node itself — no dependency to
 *     install, nothing to compile, no external tool for a user to run.
 *   - **json**: the original single-document cache, kept as the fallback for a runtime without
 *     `node:sqlite` and reachable on purpose with `DSH_USAGE_BADGE_CACHE=json`. It rewrites the
 *     whole document on every save and loads all of it, which is exactly the shape SQLite exists
 *     to avoid — so it is a compatibility path, not the recommended one.
 *
 * Both backends keep whatever they are given: neither ever deletes a day on its own. A day goes
 * away only when the folder folds a session whose log no longer contains it — and even then only
 * if the fold is not *smaller* than what is stored, because a shorter fold is the signature of a
 * shortened log or a restored backup and must not erase a fuller copy. A shorter fold is stored
 * **beside** the fuller row (the rule and its reasoning live in `buckets.js`), and `resolveRows`
 * picks the winner when reading.
 *
 * ## What a record looks like on the way in and out
 *
 * In: `{sessionId, path, fileSize, fileMtimeMs, seq, provider, model, days: Map<date, Map<key, bucket>>}`
 * as the folder builds it.
 *
 * Out of `load()`: the same record with its rows **resolved** — one bucket map per date, the
 * fuller log version having won — plus `rows`, every copy the store holds, each with its own
 * `date`, `seq`, `fileSize`, `fileMtimeMs`, `source` and `at`. `scan()` is the same shape without
 * resolution: it exists for the sync layer, which exports the local copies and must not export one
 * it merely downloaded.
 *
 * Resolving inside the store rather than at the call site is what keeps the copies invisible to
 * everything that only wants usage numbers: the folder, the snapshot and the year view all read
 * `record.days` and know nothing about sources.
 *
 * Beyond `put`/`load` they answer two questions the panel needs: `years()` — which calendar years
 * the stored history covers, so the year picker is built from the data and a new year appears the
 * first day it has a request, with nothing to configure — and a bounded range read
 * (`load({ since, until })`) for reproducing one of those years. A range read is a reporting path:
 * it never feeds a write back, which is what keeps the window optimisation safe.
 *
 * @module dsh-usage-badge/cache-store
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { CURRENT, FALLBACK, LOCAL_SOURCE, legacyDayRows, normalizeRows, resolveRows, rowIsNewerOrEqual, rowIsStrictlyNewer, rowKind, rowSource, rowsOf } from './buckets.js'
import { dayKey } from './pricing.js'

/**
 * How much history is read back into memory at once, in calendar days.
 *
 * Wider than what the snapshot asks for (`DAYS_KEPT` in `index.js` is 400 *days that have usage*,
 * which can reach further back than 400 calendar days), so the window never truncates a day the
 * snapshot would have wanted. Older rows are not deleted — only left on disk until a caller asks
 * for them, which is what the year view does.
 */
export const CACHE_WINDOW_DAYS = 430

/** The document version this backend writes. Version 1 is the pre-row shape, still read. */
const JSON_CACHE_VERSION = 2

/**
 * The SQLite schema version, kept in `PRAGMA user_version`.
 *
 * Version 2 added the row model: `source` (which device a row came from), `kind` (whether the row
 * is the fold the cursor stands on or a superseded copy kept beside it), `at` (the fold time, the
 * tie-break between two copies of the same log version) and `seq` / `file_size` / `file_mtime_ms`
 * on the day row itself, so a **fallback** row keeps the stamp of the log version it was folded
 * from even after the session cursor has moved on.
 */
const SQLITE_SCHEMA_VERSION = 2

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_mtime_ms REAL NOT NULL,
  seq INTEGER NOT NULL,
  provider TEXT,
  model TEXT
);
CREATE TABLE IF NOT EXISTS days (
  session_id TEXT NOT NULL,
  date TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  seq INTEGER NOT NULL,
  file_size INTEGER NOT NULL,
  file_mtime_ms REAL NOT NULL,
  at REAL NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, date, source, kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS days_by_date ON days (date);
`

/** The oldest day key a caller may ask for, given a window in days. */
const windowStart = (days, now = Date.now()) => dayKey(now - days * 86400000)

/**
 * Resolve the bounds `load` accepts.
 *
 * Two kinds, deliberately named apart because confusing them is silent: `windowDays` is
 * relative ("the last N days", what the folder loads) while `since`/`until` are absolute day
 * keys ("that calendar year", what the year view asks for). `absolute` says which kind was
 * used, because a backend that cannot window without losing history must ignore a relative
 * bound and return everything.
 */
function resolveBounds({ windowDays, since, until } = {}) {
  return {
    // An absolute upper bound with no lower bound means "everything up to then"; defaulting the
    // lower bound to the loading window would quietly hide older days from a range read.
    from: since ?? (until ? '0000-01-01' : windowStart(windowDays ?? CACHE_WINDOW_DAYS)),
    until: until ?? '9999-12-31',
    absolute: since !== undefined || until !== undefined,
  }
}

/** A session's rows restricted to `[since, until]`, both optional. */
function within(rows, since, until) {
  if (since === undefined && until === undefined) return rows
  return rows.filter((row) => (since === undefined || row.date >= since) && (until === undefined || row.date <= until))
}

/**
 * Parse one stored payload into a row, or null when it is not readable as one.
 *
 * The stored payload **is** the route map, so it is handed to `normalizeRows` under `routes`
 * explicitly. Passing it as the row itself would send the normalizer looking for a `date` field
 * inside a bucket, find none, and quietly drop every day.
 */
function parseRow(source, date, raw, meta = {}) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return normalizeRows(source, [{ date, routes: parsed, ...meta }], { at: meta.at ?? 0 })[0] ?? null
  } catch {
    // A malformed row is skipped rather than losing the whole session.
    return null
  }
}

/** Read a JSON cache document, or null when it is missing or of an unknown version. */
function readJsonDocument(path) {
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (!raw || (raw.version !== JSON_CACHE_VERSION && raw.version !== 1) || !raw.sessions || typeof raw.sessions !== 'object') return null
  return raw
}

/** A numeric field stored as JSON, keeping a legitimate `0` (and its sign) instead of `-1`. */
const storedNumber = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)

/** One stored session document → the record shape the folder works with. */
function documentToRecord(sessionId, source) {
  if (!source || typeof source !== 'object') return null
  const stamp = {
    seq: storedNumber(source.seq, -1),
    fileSize: Number(source.fileSize) || 0,
    fileMtimeMs: Number(source.fileMtimeMs) || 0,
  }
  // Version 1 kept a single `{date: {key: bucket}}` map with one stamp per session. Its days become
  // rows carrying that stamp, which is what lets an upgrade keep reading them.
  const rows = Array.isArray(source.days)
    ? source.days.flatMap((row) => normalizeRows(stamp, [row]))
    : legacyDayRows(source.days ?? {}, stamp)
  return {
    sessionId,
    path: String(source.path ?? ''),
    ...stamp,
    provider: source.provider ?? null,
    model: source.model ?? null,
    rows,
  }
}

/**
 * The original single-document cache.
 *
 * `load()` returns everything it holds: it cannot answer a window without losing the rest,
 * because a save rewrites the document from what was loaded. That is the trade the SQLite
 * backend removes, and the only reason it is still here is runtimes without `node:sqlite`.
 */
function createJsonStore({ path, log }) {
  let document = null
  let dirty = false
  let timer = null

  const write = () => {
    dirty = false
    const temp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    try {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(temp, JSON.stringify(document))
      try {
        renameSync(temp, path)
      } catch {
        // Windows cannot rename over an existing file; the complete temp file is already on
        // disk, so removing the old one first loses nothing.
        try {
          unlinkSync(path)
        } catch {
          // absent is fine
        }
        renameSync(temp, path)
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

  /** Cancel the pending batch, if any, and write now. */
  const flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (dirty) write()
  }

  /**
   * Move an unreadable `cache.json` aside, once, instead of overwriting it.
   *
   * A cache file this build cannot parse — a torn write, a hand-edit gone wrong, a document from
   * a newer version — would otherwise be replaced by the first save, losing whatever it held for
   * no reason. The SQLite side already keeps such a file; this is the same promise for the
   * fallback. A file that does not exist is nothing to preserve.
   */
  const quarantine = () => {
    if (!existsSync(path)) return
    const aside = `${basename(path)}.corrupt-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    try {
      renameSync(path, join(path, '..', aside))
      log(`${basename(path)} could not be parsed as a cache document; moved it aside as ${aside} and started a fresh one`)
    } catch (error) {
      log(`${basename(path)} could not be parsed and could not be moved aside (${error?.message ?? error}); it will be replaced on the next save`)
    }
  }

  /**
   * The document this store holds, read from disk the first time.
   *
   * Kept in memory across `put` calls while a write is pending: re-reading here would discard the
   * fold that `put` just accepted, because the pending timer would then write that stale copy
   * back. This is also why an absolute range read (the year view) must not reload — it is a
   * reporting read, not a refresh.
   */
  const ensureDocument = () => {
    if (document && dirty) return document
    const loaded = readJsonDocument(path)
    if (loaded) document = loaded
    else {
      quarantine()
      document = { version: JSON_CACHE_VERSION, sessions: {} }
    }
    return document
  }

  return {
    kind: 'json',
    path,
    load(bounds = {}) {
      const { from, until, absolute } = resolveBounds(bounds)
      const doc = ensureDocument()
      const records = Object.entries(doc.sessions)
        .map(([sessionId, source]) => documentToRecord(sessionId, source))
        .filter(Boolean)
      // This backend writes back exactly what it holds, so it cannot honour a *relative* window
      // without dropping history on the next save: it returns everything. An absolute range is a
      // reporting read and safe to filter.
      if (!absolute) return resolveRows(records)
      return resolveRows(records.map((record) => ({ ...record, rows: within(record.rows, from, until) })))
    },
    scan() {
      const doc = ensureDocument()
      return Object.entries(doc.sessions)
        .map(([sessionId, source]) => documentToRecord(sessionId, source))
        .filter(Boolean)
    },
    years() {
      const years = new Set()
      for (const source of Object.values(document?.sessions ?? {})) {
        const dates = Array.isArray(source?.days) ? source.days.map((row) => row?.date) : Object.keys(source?.days ?? {})
        for (const date of dates) if (date) years.add(String(date).slice(0, 4))
      }
      return [...years].filter((year) => /^\d{4}$/.test(year)).sort().reverse()
    },
    /**
     * Drop one device's whole month — the reading side of a **tombstone**. Only that device's rows go:
     * never this device's own fold, and never another device's rows.
     *
     * @returns {number} how many rows were removed.
     */
    dropSourceMonth(source, month) {
      if (!source || !/^\d{4}-\d{2}$/.test(String(month))) return 0
      const doc = ensureDocument()
      let removed = 0
      for (const [sessionId, entry] of Object.entries(doc.sessions ?? {})) {
        const record = documentToRecord(sessionId, entry)
        if (!record) continue
        const keep = record.rows.filter((row) => !(rowSource(row) === source && String(row.date).startsWith(month)))
        removed += record.rows.length - keep.length
        // A session left with **no rows keeps its entry**, empty. The SQLite backend's `sessions` row
        // survives the same delete (`DELETE FROM days`), and the two backends have to answer this question
        // the same way: `load()` returning a session with no rows means "this session is now empty", while
        // dropping the entry means "there was never such a session" — and a reader that merges what it is
        // given instead of replacing its world with it cannot tell those apart. The host's `loadCache` is
        // exactly that reader (it must not drop a fold the store could not accept — a read-only store's
        // `put` returns null, and the fold in memory is then the only copy), so a dropped entry here left
        // the withdrawn month counted in memory until the host restarted.
        entry.days = keep.map((row) => ({ ...row }))
      }
      if (removed > 0) {
        dirty = true
        flush()
      }
      return removed
    },
    /**
     * Store one fold and hand back the resolved view of that session.
     *
     * The return value matters: a fold that covered **less** than what was already stored leaves
     * the fuller copy in place, and the caller must go on showing the fuller one rather than the
     * short fold it just produced. Returning the resolved record is what makes "the cache kept
     * it" true in memory as well as on disk.
     *
     * The rules are the SQLite backend's, expressed on the document: a fold replaces its own
     * `current` rows, a weaker fold lands in the `fallback` slot instead of over the fuller copy,
     * another source's rows are never a fold's to judge, and a date the log no longer covers is
     * dropped only when the log version is not itself weaker than what is stored (a shortened log is
     * a rollback, not a deletion).
     */
    put(record, options = {}) {
      const doc = ensureDocument()
      const at = options.at ?? Date.now()
      const previous = documentToRecord(record.sessionId, doc.sessions[record.sessionId])
      const incoming = rowsOf(record, { source: LOCAL_SOURCE, at })
      const incomingKeys = new Set(incoming.map((row) => `${row.date}\u0000${row.source}`))
      const cursor = { seq: record.seq ?? -1, fileSize: record.fileSize ?? 0 }
      const kept = []
      for (const row of previous?.rows ?? []) {
        const key = `${row.date}\u0000${rowSource(row)}`
        // A row survives the fold unless the fold is entitled to remove it:
        //   - another source's copy is never a fold's to judge, and neither is a `fallback` copy —
        //     that is a log version the cursor has moved past, kept on purpose;
        //   - its own `current` row the fold still covers is replaced by the incoming copy below;
        //   - its own `current` row the fold does **not** cover goes only if this log version still
        //     reaches back to it. A row older than the incoming cursor was folded from a fuller log
        //     — a shorter one now, or a restored backup — and it is all that is left of those days.
        const theirs = rowSource(row) !== LOCAL_SOURCE || rowKind(row) === FALLBACK
        const keep = theirs || incomingKeys.has(key) || !rowIsNewerOrEqual(cursor, row)
        if (keep) kept.push(row)
      }
      // Grouped by `(date, source, kind)`: the `current` and `fallback` copies of one date share a
      // date and a source but are different rows, and a map keyed without the slot would let one
      // silently overwrite the other.
      const group = (rows) => new Map(rows.map((row) => [`${row.date}\u0000${row.source}\u0000${rowKind(row)}`, row]))
      const merged = group(kept)
      for (const row of incoming) {
        const key = `${row.date}\u0000${row.source}\u0000${CURRENT}`
        const existing = merged.get(key) ?? null
        if (!rowIsStrictlyNewer(row, existing)) {
          // A short fold goes into the `fallback` slot beside the fuller copy rather than replacing
          // it — that copy is the log's own current truth, and all that is left if the fuller one
          // ever goes away.
          merged.set(`${row.date}\u0000${row.source}\u0000${FALLBACK}`, { ...row, kind: FALLBACK })
          continue
        }
        merged.set(key, row)
      }
      kept.length = 0
      kept.push(...merged.values())
      doc.sessions[record.sessionId] = {
        path: record.path,
        fileSize: record.fileSize,
        fileMtimeMs: record.fileMtimeMs,
        seq: record.seq,
        provider: record.provider,
        model: record.model,
        days: kept.map((row) => ({
          date: row.date,
          routes: row.routes,
          seq: row.seq,
          fileSize: row.fileSize,
          fileMtimeMs: row.fileMtimeMs,
          source: rowSource(row),
          kind: rowKind(row),
          at: row.at ?? 0,
        })),
      }
      dirty = true
      if (!timer) {
        // Batched, because this backend pays for the whole history on every save.
        timer = setTimeout(() => {
          timer = null
          if (dirty) write()
        }, 2000)
        timer.unref?.()
      }
      return resolveRows([documentToRecord(record.sessionId, doc.sessions[record.sessionId])])[0] ?? null
    },
    /**
     * Store rows that came from another device, and hand back how many were new.
     *
     * The SQLite backend's rules on the document: never delete **another device's** rows, and store a row
     * only when it is strictly fuller than the one already held for that `(session, date, source, slot)`.
     * Grouped by session because a shard's rows arrive together but a document is edited per session.
     *
     * With `replace`, that device's own rows for one month are treated as *its* statement about that month:
     * rows it no longer lists are removed. That is not the same as letting another machine erase this one's
     * history — the rows removed belong to the device that is speaking, which is the only party entitled to
     * say what it holds.
     */
    intakeRows(rows, { replace = null } = {}) {
      const doc = ensureDocument()
      const bySession = new Map()
      const incoming = new Set()
      for (const row of rows ?? []) {
        if (!row?.sessionId || typeof row.date !== 'string') continue
        incoming.add(`${row.sessionId}\u0000${row.date}\u0000${rowSource(row)}\u0000${rowKind(row)}`)
        let list = bySession.get(row.sessionId)
        if (!list) {
          list = []
          bySession.set(row.sessionId, list)
        }
        list.push(row)
      }
      let written = 0
      for (const [sessionId, arriving] of bySession) {
        const existing = documentToRecord(sessionId, doc.sessions[sessionId])
        const merged = new Map((existing?.rows ?? []).map((row) => [`${row.date}\u0000${rowSource(row)}\u0000${rowKind(row)}`, row]))
        for (const row of arriving) {
          const kind = rowKind(row) === FALLBACK ? FALLBACK : CURRENT
          const key = `${row.date}\u0000${row.source}\u0000${kind}`
          const known = merged.get(key)
          if (known) {
            if (JSON.stringify(known.routes ?? {}) === JSON.stringify(row.routes ?? {})) continue
            // See the SQLite backend: replace mode takes the publisher's word for its own month, while a
            // plain import only lets a strictly fuller copy through.
            if (!replace && !rowIsStrictlyNewer(row, known)) continue
          }
          merged.set(key, { ...row, kind })
          written++
        }
        if (replace) {
          for (const [key, row] of [...merged]) {
            if (rowSource(row) !== replace.source) continue
            if (!String(row.date).startsWith(replace.month)) continue
            if (incoming.has(`${sessionId}\u0000${key}`)) continue
            merged.delete(key)
            written++
          }
        }
        const rows_ = [...merged.values()]
        const fullest = rows_.reduce((top, row) => (top === null || rowIsStrictlyNewer(row, top) ? row : top), null)
        const previous = doc.sessions[sessionId]
        // The cursor has to exist for the days to be readable at all (`readRecords` walks the
        // sessions and hangs the days off them), and it must never regress: it is the stamp the fold
        // path compares its own log version against.
        const keepCursor = previous && !rowIsStrictlyNewer(fullest ?? {}, previous)
        doc.sessions[sessionId] = {
          path: previous?.path ?? '',
          fileSize: keepCursor ? previous.fileSize : fullest?.fileSize ?? 0,
          fileMtimeMs: keepCursor ? previous.fileMtimeMs : fullest?.fileMtimeMs ?? 0,
          seq: keepCursor ? previous.seq : fullest?.seq ?? -1,
          provider: previous?.provider ?? null,
          model: previous?.model ?? null,
          days: rows_.map((row) => ({
            date: row.date,
            routes: row.routes,
            seq: row.seq,
            fileSize: row.fileSize,
            fileMtimeMs: row.fileMtimeMs,
            source: rowSource(row),
            kind: rowKind(row),
            at: row.at ?? 0,
          })),
        }
      }
      if (written > 0) {
        dirty = true
        if (!timer) {
          timer = setTimeout(() => {
            timer = null
            if (dirty) write()
          }, 2000)
          timer.unref?.()
        }
      }
      return written
    },
    flush,
    // The same thing here, and a plain function rather than `this.flush()`, so a caller that
    // pulled it off the object still closes cleanly.
    close: flush,
  }
}

/**
 * Open a database, apply the pragmas and bring the schema up to this version.
 *
 * Anything that can fail here — the file is not a database, it is truncated, it is locked by
 * another program — closes the handle before rethrowing, so a caller that decides to give up on
 * the file does not leave it locked (on Windows that would also stop a user deleting it).
 *
 * The schema version is read **before** any write pragma runs, for two reasons: `journal_mode =
 * WAL` is persistent (running it on a newer version's file would modify a database this build
 * does not understand), and on a read-only file it fails with a message that would otherwise be
 * mistaken for corruption — and be "repaired" by throwing the user's history away.
 *
 * @returns {{db:object, version:number, writable:boolean}} the open handle, the schema version it
 *   declared, and whether this build may write to it.
 */
function openDatabase(DatabaseSync, path, log) {
  const closeQuietly = (handle) => {
    try {
      handle?.close()
    } catch {
      // the handle is already unusable
    }
  }

  const probe = new DatabaseSync(path)
  let version
  try {
    version = Number(probe.prepare('PRAGMA user_version').get()?.user_version ?? 0)
  } catch (error) {
    closeQuietly(probe)
    throw error
  }

  if (version > SQLITE_SCHEMA_VERSION) {
    // A downgrade. This handle is read-only from the start, so nothing here — not even a pragma —
    // changes a byte of a file written by a version that knows more than this one does.
    closeQuietly(probe)
    const db = new DatabaseSync(path, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 3000')
    log(`cache ${basename(path)} was written by a newer version (schema ${version}); using it read-only`)
    return { db, version, writable: false }
  }

  try {
    // Before `journal_mode`: a lock held by another host must be waited out, not read as a
    // failure to open (which used to end in the file being moved aside).
    probe.exec('PRAGMA busy_timeout = 3000')
    probe.exec('PRAGMA journal_mode = WAL')
    // A cache does not need full durability: the WAL survives a process crash, and a power loss
    // can only cost the last few folded days, which the session logs can supply again.
    probe.exec('PRAGMA synchronous = NORMAL')
    migrateSchema(probe, version, log)
    probe.exec(SCHEMA)
    if (version !== SQLITE_SCHEMA_VERSION) probe.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`)
    return { db: probe, version, writable: true }
  } catch (error) {
    closeQuietly(probe)
    throw error
  }
}

/**
 * Bring a database written by an older build up to this schema.
 *
 * Checked by asking the file which columns it has, not by trusting `user_version` alone: a file
 * whose version number was rewritten, or whose `days` table predates the stamp columns, must be
 * migrated rather than hit with an INSERT naming columns it does not have. The old rows are
 * brought across rather than dropped — an upgrade that silently emptied the cache would look
 * exactly like a bug.
 */
function migrateSchema(db, version, log) {
  const columns = (table) => {
    try {
      return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name))
    } catch {
      return []
    }
  }
  const dayColumns = columns('days')
  if (dayColumns.length === 0 || dayColumns.includes('kind')) return

  log(`cache schema ${version} predates the row model; migrating its days table`)
  const previous = []
  try {
    for (const row of db.prepare('SELECT session_id, date, payload FROM days').all()) {
      const cursor = db.prepare('SELECT seq, file_size, file_mtime_ms FROM sessions WHERE id = ?').get(row.session_id) ?? {}
      previous.push({
        sessionId: row.session_id,
        date: row.date,
        source: LOCAL_SOURCE,
        kind: CURRENT,
        seq: storedNumber(cursor.seq, -1),
        fileSize: Number(cursor.file_size) || 0,
        fileMtimeMs: Number(cursor.file_mtime_ms) || 0,
        payload: row.payload,
      })
    }
  } catch (error) {
    log(`cache migration could not read the old rows (${error?.message ?? error}); the days table starts fresh`)
    previous.length = 0
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('DROP TABLE IF EXISTS days')
    db.exec(SCHEMA)
    const insert = db.prepare('INSERT OR REPLACE INTO days (session_id, date, source, kind, seq, file_size, file_mtime_ms, at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const row of previous) {
      insert.run(row.sessionId, row.date, row.source, row.kind, row.seq, row.fileSize, row.fileMtimeMs, 0, row.payload)
    }
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // the transaction is already gone
    }
    throw error
  }
}

/**
 * Whether a failure means "these bytes are not a database", as opposed to "this process may not
 * use this database right now". Only the first is worth repairing by moving the file aside.
 */
function isUnreadableFile(error) {
  const code = Number(error?.errcode)
  if (code === 11 || code === 26) return true // SQLITE_CORRUPT, SQLITE_NOTADB
  return /not a database|malformed|file is encrypted/i.test(String(error?.message ?? ''))
}

/** Open a database read-only, or null when even that is not possible. */
function openReadOnly(DatabaseSync, path, log) {
  try {
    const db = new DatabaseSync(path, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 3000')
    return db
  } catch (error) {
    log(`cache ${basename(path)} could not be opened read-only either: ${error?.message ?? error}`)
    return null
  }
}

/**
 * The SQLite backend. Opens (creating if needed), migrates an old `cache.json` into it once,
 * and refuses to write to a database written by a newer schema version rather than guessing.
 *
 * A failure thrown out of here carries `cacheKeepFile` when the file itself is fine but this
 * build cannot use it, which tells the caller not to touch it.
 */
function createSqliteStore({ path, jsonPath, log, DatabaseSync, db: given = null, writable: givenWritable = null }) {
  mkdirSync(join(path, '..'), { recursive: true })
  const opened = given ? { db: given, writable: givenWritable, version: null } : openDatabase(DatabaseSync, path, log)
  const { db } = opened
  const writable = opened.writable !== false

  const prepare = (sql) => {
    try {
      return db.prepare(sql)
    } catch (error) {
      try {
        db.close()
      } catch {
        // nothing else to do
      }
      error.cacheKeepFile = true
      throw error
    }
  }

  /**
   * A statement that may be impossible against this file's schema, or null.
   *
   * This exists for the read-only path: a database written by a newer version may have moved a
   * column this build's queries name, and the alternative would be to give up on the file
   * entirely — which the design refuses to do, because a downgrade must not cost the user their
   * history. A query that cannot run is skipped, so such a file reads as far as it can be read
   * and is then left untouched.
   */
  const tryPrepare = (sql) => {
    try {
      return db.prepare(sql)
    } catch {
      return null
    }
  }
  const all = (statement, ...args) => (statement ? statement.all(...args) : [])
  const get = (statement, ...args) => (statement ? statement.get(...args) : undefined)

  const selectSessions = tryPrepare('SELECT id, path, file_size, file_mtime_ms, seq, provider, model FROM sessions')
  const selectDays = tryPrepare('SELECT session_id, date, source, kind, seq, file_size, file_mtime_ms, at, payload FROM days WHERE date >= ? AND date <= ? ORDER BY date')
  const selectSessionDays = tryPrepare('SELECT date, source, kind, seq, file_size, file_mtime_ms, at, payload FROM days WHERE session_id = ?')
  const selectEveryDay = tryPrepare('SELECT session_id, date, source, kind, seq, file_size, file_mtime_ms, at, payload FROM days')
  // Which years exist is a question only the store can answer: the folder holds a window, not
  // the whole history, and the panel's year list has to include years older than that window.
  const selectYears = tryPrepare("SELECT DISTINCT substr(date, 1, 4) AS year FROM days WHERE date GLOB '[0-9][0-9][0-9][0-9]-*' ORDER BY year DESC")
  const countSessions = tryPrepare('SELECT COUNT(*) AS n FROM sessions')
  const selectCursor = tryPrepare('SELECT seq, file_size, file_mtime_ms FROM sessions WHERE id = ?')
  const insertRow = writable
    ? prepare('INSERT OR REPLACE INTO days (session_id, date, source, kind, seq, file_size, file_mtime_ms, at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    : null
  const deleteRow = writable ? prepare('DELETE FROM days WHERE session_id = ? AND date = ? AND source = ? AND kind = ?') : null
  /** Every row one device claims for one month — what a replacing import has to compare against. */
  const selectSourceMonth = tryPrepare('SELECT session_id, date, kind, payload FROM days WHERE source = ? AND substr(date, 1, 7) = ?')
  /** Drop one device's whole month: what a device's own "I no longer hold this" means to a reader. */
  const deleteSourceMonth = writable ? prepare("DELETE FROM days WHERE source = ? AND substr(date, 1, 7) = ?") : null
  const upsertSession = writable
    ? prepare(
        `INSERT INTO sessions (id, path, file_size, file_mtime_ms, seq, provider, model)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           path = excluded.path, file_size = excluded.file_size, file_mtime_ms = excluded.file_mtime_ms,
           seq = excluded.seq, provider = excluded.provider, model = excluded.model`,
      )
    : null

  /**
   * Every row a session holds, or every row in the store when no session is named, in whatever
   * schema the file turned out to have.
   */
  const readSessionRows = (sessionId, { source, kind } = {}) =>
    (sessionId === undefined ? all(selectEveryDay) : all(selectSessionDays, sessionId))
      .filter((row) => (source === undefined || row.source === source) && (kind === undefined || (row.kind ?? CURRENT) === kind))
      .map((row) => ({
        sessionId: row.session_id ?? sessionId,
        date: row.date,
        source: row.source,
        kind: row.kind ?? CURRENT,
        seq: storedNumber(row.seq, 0),
        fileSize: Number(row.file_size) || 0,
        fileMtimeMs: Number(row.file_mtime_ms) || 0,
        at: Number(row.at) || 0,
        payload: String(row.payload ?? ''),
      }))

  /**
   * Store one row.
   *
   * `INSERT OR REPLACE` rather than a delete-then-insert pair: the primary key is
   * `(session, date, source)`, and a second copy for the same key is the local fold's own
   * superseded row set — exactly the case a plain `INSERT` fails on. Failing there would roll the
   * whole fold back, which is the loudest possible way to lose the shortened fold this model exists
   * to keep.
   */
  const writeRow = (sessionId, row) =>
    insertRow.run(sessionId, row.date, row.source, row.kind ?? CURRENT, row.seq, row.fileSize, row.fileMtimeMs, row.at ?? 0, JSON.stringify(row.routes ?? {}))

  /** Store a session's cursor: the log version this device last folded it from. */
  const writeCursor = (record) =>
    upsertSession.run(
      record.sessionId,
      record.path ?? '',
      record.fileSize ?? 0,
      record.fileMtimeMs ?? 0,
      record.seq ?? -1,
      record.provider ?? null,
      record.model ?? null,
    )

  /** A session's stored cursor, as a stamp the row comparisons understand. */
  const readCursor = (sessionId) => {
    const row = get(selectCursor, sessionId)
    return row ? { seq: storedNumber(row.seq, -1), fileSize: Number(row.file_size) || 0, fileMtimeMs: Number(row.file_mtime_ms) || 0 } : null
  }

  /**
   * Write one session's fold.
   *
   * Three rules, all about not losing history:
   *
   *   - a fold owns **its own** rows only. A day the log no longer has is deleted from this device's
   *     `current` rows and from nowhere else — a row that arrived from another device is not the
   *     folder's to remove;
   *   - a `current` row is replaced only when the new fold describes **at least as much** of the
   *     session (higher `seq`, or equal `seq` and no smaller file). A shorter fold goes to the
   *     `fallback` slot beside the fuller copy instead of over it;
   *   - when the fold is shorter *and* drops a day, the day is rolled back rather than deleted —
   *     this is what a restored backup looks like, and it is the case the whole row model exists for.
   */
  const writeSession = (record, { source = LOCAL_SOURCE, at = Date.now() } = {}) => {
    writeCursor(record)
    const cursor = readCursor(record.sessionId)
    const incoming = rowsOf(record, { source, at })
    const stored = new Map(readSessionRows(record.sessionId, { source, kind: CURRENT }).map((row) => [row.date, row]))
    for (const row of incoming) {
      const known = stored.get(row.date)
      if (known) stored.delete(row.date)
      if (known && !rowIsNewerOrEqual(row, known)) {
        // The fold covers less than the copy already stored for that day. The fuller copy keeps the
        // `current` slot — the log has been shortened, but that is no reason to forget what it said —
        // and this short fold is written as the `fallback`: it is what is left if the fuller copy is
        // ever gone (the machine is restored from the same backup, say).
        if (known.payload !== JSON.stringify(row.routes)) writeRow(record.sessionId, { ...row, kind: FALLBACK })
        continue
      }
      if (known && known.payload === JSON.stringify(row.routes)) continue
      if (known) deleteRow.run(record.sessionId, row.date, source, CURRENT)
      writeRow(record.sessionId, row)
    }
    // A date this device folded before, that the record no longer covers at all, is gone from the
    // log. Its `current` row goes with it — unless this log version is itself weaker than the copy
    // already stored, in which case a shortened log is treated as a rollback rather than as a
    // deletion, and the day is kept.
    for (const row of stored.values()) {
      if (cursor && !rowIsNewerOrEqual(cursor, row)) continue
      deleteRow.run(record.sessionId, row.date, source, CURRENT)
    }
  }

  /**
   * Take rows that came from somewhere other than this device's own fold.
   *
   * This is the **sync import path**, and it takes rows rather than records because an incoming row
   * carries its own stamp and its own slot: a shard is a set of rows, not a session's current fold.
   * Two rules, both about not losing history:
   *
   *   - it never deletes. Only this device's own fold may remove this device's rows; a machine whose
   *     logs were pruned must not be able to erase what another machine published;
   *   - a row is stored only when it is **strictly fuller** than the one already held for that
   *     `(date, source, slot)`. An equal-stamp copy is the same bytes and is left as it is; a weaker
   *     one is a worse answer to the same question.
   *
   * With `replace`, one device's rows for one month are taken as *that device's own statement* about the
   * month, so rows it no longer lists are removed. Without it, two machines that both pulled a month keep
   * different totals forever: the publisher drops a row, republishes, and every reader keeps the old one,
   * because an import only ever adds. The rows removed belong to the device that is speaking, which is the
   * only party entitled to say what it holds — not the "another machine erased my history" case the first
   * rule forbids.
   *
   * @param {object[]} rows
   * @param {{replace?:{source:string, month:string}}} [options]
   * @returns {number} how many rows were written or removed.
   */
  const intakeRows = (rows, { replace = null } = {}) => {
    const known = new Map(readSessionRows(undefined).map((row) => [`${row.sessionId}\u0000${row.date}\u0000${row.source}\u0000${row.kind}`, row]))
    let written = 0
    const arriving = new Set()
    for (const row of rows ?? []) {
      if (!row?.sessionId || typeof row.date !== 'string') continue
      const kind = rowKind(row) === FALLBACK ? FALLBACK : CURRENT
      arriving.add(`${row.sessionId}\u0000${row.date}\u0000${row.source}\u0000${kind}`)
      // The day rows are only reachable through a session row (`readRecords` walks `sessions` and
      // hangs the days off it), so an import has to make sure one exists — otherwise the history is
      // written into a table nothing reads.
      const existing = known.get(`${row.sessionId}\u0000${row.date}\u0000${row.source}\u0000${kind}`)
      const payload = JSON.stringify(row.routes ?? {})
      if (existing) {
        // Same bytes: nothing to write, and nothing to argue about.
        if (existing.payload === payload) continue
        // Outside replace mode only a **strictly fuller** copy may overwrite what is held — that is what
        // keeps a shorter log from erasing a longer one. In replace mode the incoming shard is the
        // publisher's own statement about that month, so it wins even at the same log version: a corrected
        // day (100 → 400) carries the same stamp, and vetoing it would leave the two machines disagreeing.
        if (!replace && !rowIsStrictlyNewer(row, existing)) continue
        deleteRow.run(row.sessionId, row.date, row.source, kind)
      }
      writeRow(row.sessionId, { ...row, kind })
      written++
    }
    if (replace && writable) {
      // Everything this device used to claim for the month that it does not claim now. Deleting only its
      // own rows is what makes this safe: this device's own fold and every other device's rows are untouched.
      for (const row of all(selectSourceMonth, replace.source, replace.month)) {
        const kind = row.kind ?? CURRENT
        if (arriving.has(`${row.session_id}\u0000${row.date}\u0000${replace.source}\u0000${kind}`)) continue
        deleteRow.run(row.session_id, row.date, replace.source, kind)
        written++
      }
    }
    // One cursor per session that arrived, from the fullest row that arrived for it.
    const bySession = new Map()
    for (const row of rows ?? []) {
      if (!row?.sessionId) continue
      const best = bySession.get(row.sessionId)
      if (!best || rowIsStrictlyNewer(row, best)) bySession.set(row.sessionId, row)
    }
    for (const [sessionId, best] of bySession) {
      const cursor = readCursor(sessionId)
      if (!cursor || rowIsStrictlyNewer(best, cursor)) {
        writeCursor({ sessionId, path: '', fileSize: best.fileSize, fileMtimeMs: best.fileMtimeMs, seq: best.seq })
      }
    }
    return written
  }

  /** Bring an existing JSON cache across, once, keeping the old file for inspection. */
  const migrateFromJson = () => {
    // Only into an empty database, and only when there is something to bring across. A
    // database that already has rows is never re-read from the JSON file, so a failed rename
    // below cannot cause the same history to be folded in twice.
    if (!writable) return
    if ((get(countSessions)?.n ?? 0) > 0) {
      // Rows already exist, so this JSON file is a leftover — from a run that used the JSON
      // backend deliberately, from a period spent on the fallback, or from an older host that
      // wrote it after the migration. Those folds are not merged (a day-by-day merge of two
      // generations of the same session could double count), but silently ignoring history is
      // exactly what this project does not do, so it is said out loud.
      if (existsSync(jsonPath)) {
        log(
          `note: ${basename(jsonPath)} sits beside a non-empty ${basename(path)} and is not read; ` +
            'its days are either already in the database or re-foldable from the session logs, and it can be deleted',
        )
      }
      return
    }
    if (!existsSync(jsonPath)) return
    const document = readJsonDocument(jsonPath)
    if (!document) return
    const records = Object.entries(document.sessions)
      .map(([sessionId, source]) => documentToRecord(sessionId, source))
      .filter(Boolean)
    if (records.length === 0) return
    // The rows are written directly rather than through `writeSession`: a migrated record is
    // already row-shaped (version 1's day map was turned into rows with the session's stamp on
    // the way in), and re-deriving rows from a `days` Map there is not would import nothing.
    try {
      db.exec('BEGIN IMMEDIATE')
      for (const record of records) {
        writeCursor(record)
        for (const row of record.rows) writeRow(record.sessionId, row)
      }
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // the transaction is already gone
      }
      log(`cache migration failed, keeping the JSON cache: ${error?.message ?? error}`)
      return
    }
    const kept = `${jsonPath}.migrated`
    // Fold the migrated rows out of the write-ahead log and into the database file, so the
    // result of a migration is one file a user can look at rather than a large `-wal` beside it.
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // A checkpoint that does not happen now will happen on the next open.
    }
    try {
      renameSync(jsonPath, kept)
      log(`cache migrated into ${basename(path)} (${records.length} session(s)); the old file is kept as ${basename(kept)}`)
    } catch {
      // Non-fatal: the database is no longer empty, so the JSON file will not be read again.
      log(`cache migrated into ${basename(path)}; ${basename(jsonPath)} could not be renamed and is now ignored`)
    }
  }
  migrateFromJson()

  /** Every session, with the rows inside `[from, until]`. */
  const readRecords = (from, until) => {
    const byId = new Map()
    for (const row of all(selectSessions)) {
      byId.set(row.id, {
        sessionId: row.id,
        path: row.path,
        fileSize: Number(row.file_size) || 0,
        fileMtimeMs: Number(row.file_mtime_ms) || 0,
        seq: storedNumber(row.seq, -1),
        provider: row.provider ?? null,
        model: row.model ?? null,
        rows: [],
      })
    }
    for (const row of all(selectDays, from, until)) {
      const record = byId.get(row.session_id)
      if (!record) continue
      const parsed = parseRow(record, row.date, row.payload, {
        seq: Number(row.seq) || 0,
        fileSize: Number(row.file_size) || 0,
        fileMtimeMs: Number(row.file_mtime_ms) || 0,
        source: row.source,
        kind: row.kind ?? CURRENT,
        at: Number(row.at) || 0,
      })
      if (!parsed) continue
      record.rows.push(parsed)
    }
    return [...byId.values()]
  }

  return {
    kind: 'sqlite',
    path,
    writable,
    load(bounds = {}) {
      const { from, until } = resolveBounds(bounds)
      return resolveRows(readRecords(from, until))
    },
    scan() {
      return readRecords('0000-01-01', '9999-12-31')
    },
    years() {
      return all(selectYears).map((row) => String(row.year))
    },
    /**
     * Drop one device's whole month.
     *
     * This is what a **tombstone** means on the reading side: the device that published the month says it
     * no longer holds any of it, so the copy this store imported is no longer backed by anything. Only that
     * device's rows go — never this device's own fold, and never another device's rows.
     *
     * @returns {number} how many rows were removed.
     */
    dropSourceMonth(source, month) {
      if (!writable || !source || !/^\d{4}-\d{2}$/.test(String(month))) return 0
      try {
        const result = deleteSourceMonth.run(String(source), String(month))
        return Number(result?.changes) || 0
      } catch (error) {
        log(`could not drop ${source}/${month}: ${error?.message ?? error}`)
        return 0
      }
    },
    /**
     * Store one fold and hand back the resolved view of that session.
     *
     * The return value matters: a fold that covered **less** than what was already stored leaves
     * the fuller copy in place, and the caller must go on showing the fuller one rather than the
     * short fold it just produced. Returning the resolved record is what makes "the cache kept it"
     * true in memory as well as on disk.
     */
    put(record, { at = Date.now() } = {}) {
      if (!writable) return null
      try {
        db.exec('BEGIN IMMEDIATE')
        writeSession(record, { source: LOCAL_SOURCE, at })
        db.exec('COMMIT')
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // the transaction is already gone
        }
        log(`cache write failed for ${record.sessionId}: ${error?.message ?? error}`)
        return null
      }
      return resolveRows(readRecords('0000-01-01', '9999-12-31').filter((row) => row.sessionId === record.sessionId))[0] ?? null
    },
    /**
     * Store rows that came from another device, and hand back how many were new.
     *
     * Wrapped in one transaction: an imported shard is a month of somebody's history, and a partial
     * month would leave the two devices disagreeing about which days exist.
     */
    intakeRows(rows, options) {
      if (!writable) return 0
      try {
        db.exec('BEGIN IMMEDIATE')
        const written = intakeRows(rows, options)
        db.exec('COMMIT')
        return written
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // the transaction is already gone
        }
        log(`cache import failed: ${error?.message ?? error}`)
        return 0
      }
    },
    flush() {
      // Every put is already committed; nothing is batched.
    },
    close() {
      try {
        db.close()
      } catch {
        // closing twice, or a database already closed with the host, is not an error here
      }
    },
  }
}

/**
 * Open the cache store this runtime should use.
 *
 * Several different failures can stop the SQLite backend, and they are answered differently rather
 * than under one message:
 *
 *   - **the module is missing** (a runtime without `node:sqlite`): fall back to the JSON cache;
 *   - **the file is not a database** (a torn write, another program's file, a half-copied backup):
 *     move it aside once, bytes intact, and start a fresh one. History is re-derivable from the
 *     session logs, so this is a repair rather than a loss — and it is the difference between one
 *     bad start and paying the slow backend on every start from then on;
 *   - **the file cannot be written** (permissions, a lock, read-only media, a restored backup whose
 *     ACLs did not come with it): use it **read-only** and leave it exactly where it is. Rotating a
 *     healthy database aside to fix a permission problem would throw the history away;
 *   - **the file is a newer version's**: same answer — read-only, untouched — because a downgrade
 *     must not destroy data it does not understand.
 *
 * @param {{dir:string, log?:Function, env?:object}} options
 * @returns {{kind:string, path:string, load:Function, scan:Function, years:Function, put:Function, flush:Function, close:Function}}
 */
export function createCacheStore({ dir, log = () => {}, env = process.env }) {
  const jsonPath = join(dir, 'cache.json')
  const sqlitePath = join(dir, 'cache.sqlite')
  const preference = String(env.DSH_USAGE_BADGE_CACHE ?? '').trim().toLowerCase()
  const jsonFallback = () => createJsonStore({ path: jsonPath, log })
  if (preference === 'json') return jsonFallback()

  let DatabaseSync
  try {
    // Touching the module is the availability check: an older runtime that cannot load it falls
    // back below rather than failing the host half.
    ;({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'))
  } catch (error) {
    log(
      preference === 'sqlite'
        ? `the sqlite cache was requested but node:sqlite could not be loaded (${error?.message ?? error}); using the JSON cache`
        : `node:sqlite is unavailable here (${error?.message ?? error}); using the JSON cache`,
    )
    return jsonFallback()
  }

  try {
    return createSqliteStore({ path: sqlitePath, jsonPath, log, DatabaseSync })
  } catch (error) {
    // Not being able to *write* a database is not the same as the file being broken, and the
    // difference decides whether the user's history survives: permissions, a lock held by another
    // host, read-only media or a restored backup are all "cannot use it right now". Repairing
    // those by moving the file aside would throw away years of history to fix an ACL, so the file
    // is left alone and read read-only instead.
    if (!isUnreadableFile(error)) {
      if (error?.cacheKeepFile) {
        log(`cache ${basename(sqlitePath)} belongs to a newer version of this plugin and cannot be read here; leaving it untouched and using the JSON cache`)
        return jsonFallback()
      }
      const db = openReadOnly(DatabaseSync, sqlitePath, log)
      if (db) {
        log(`cache ${basename(sqlitePath)} could not be opened for writing (${error?.message ?? error}); using it read-only and leaving it alone`)
        try {
          return createSqliteStore({ path: sqlitePath, jsonPath, log, DatabaseSync, db, writable: false })
        } catch (readOnlyError) {
          log(`cache ${basename(sqlitePath)} could not be used read-only either (${readOnlyError?.message ?? readOnlyError})`)
        }
      }
      log(`cache ${basename(sqlitePath)} could not be opened (${error?.message ?? error}); leaving it alone and using the JSON cache`)
      return jsonFallback()
    }

    // Genuinely not a database: repair it once, keeping the bytes for inspection. The name
    // carries pid, time and entropy so two rotations cannot collide.
    const aside = `${basename(sqlitePath)}.corrupt-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    try {
      renameSync(sqlitePath, join(dir, aside))
      for (const sibling of ['-wal', '-shm']) {
        try {
          renameSync(`${sqlitePath}${sibling}`, join(dir, `${aside}${sibling}`))
        } catch {
          // Usually absent; a leftover one is ignored by SQLite when the header does not match.
        }
      }
      log(`cache ${basename(sqlitePath)} could not be read (${error?.message ?? error}); moved it aside as ${aside} and started a fresh one`)
      return createSqliteStore({ path: sqlitePath, jsonPath, log, DatabaseSync })
    } catch (retryError) {
      log(
        `cache ${basename(sqlitePath)} could not be read (${error?.message ?? error}) and could not be moved aside ` +
          `(${retryError?.message ?? retryError}); using the JSON cache`,
      )
      return jsonFallback()
    }
  }
}
