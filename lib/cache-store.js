/**
 * dsh-usage-badge — where the folded history is kept between runs.
 *
 * The folder hands this layer one session at a time and asks nothing about storage. Two
 * backends sit behind that interface:
 *
 *   - **sqlite** (default). One row per (session, day). A fold compares the session against its
 *     stored rows and writes only the days whose payload actually changed — measured 0.12 ms for a
 *     one-day session, and 4.98 ms for a 400-day one (the comparison still reads those rows, so the
 *     cost tracks the changed session's size, not the table's). Loading takes only the window the
 *     panel can show, which bounds resident memory the same way. Older rows stay on disk, which is
 *     the point: history is never deleted, it is just not all held in memory at once.
 *     It uses `node:sqlite`, which ships inside Node itself — no dependency to install, nothing
 *     to compile, no external tool for a user to run.
 *   - **json**: the original single-document cache, kept as the fallback for a runtime without
 *     `node:sqlite` and reachable on purpose with `DSH_USAGE_BADGE_CACHE=json`. It rewrites the
 *     whole document on every save and loads all of it, which is exactly the shape SQLite exists
 *     to avoid — so it is a compatibility path, not the recommended one.
 *
 * Both backends keep whatever they are given: neither ever deletes history on its own. The only
 * thing that removes a day is the folder folding a session whose log no longer contains it.
 *
 * Beyond `put`/`load` they answer two questions the panel needs: `years()` — which calendar
 * years the stored history covers, so the year picker is built from the data and a new year
 * appears the first day it has a request, with nothing to configure — and a bounded range read
 * (`load({ until })`) for reproducing one of those years. A range read is a reporting path: it
 * never feeds a write back, which is what keeps the window optimisation safe.
 *
 * @module dsh-usage-badge/cache-store
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { deserializeDay, deserializeDays, serializeDay, serializeDays } from './buckets.js'
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

/** The document version the JSON backend writes; the original cache format, unchanged. */
const JSON_CACHE_VERSION = 1

/** The SQLite schema version, kept in `PRAGMA user_version`. */
const SQLITE_SCHEMA_VERSION = 1

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
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, date)
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

/** A session's days restricted to `[since, until]`, both optional. */
function filterDays(days, since, until) {
  if (since === undefined && until === undefined) return days
  const kept = new Map()
  for (const [date, dayObj] of days) {
    if (since !== undefined && date < since) continue
    if (until !== undefined && date > until) continue
    kept.set(date, dayObj)
  }
  return kept
}

/** Read a JSON cache document, or null when it is missing or of an unknown version. */
function readJsonDocument(path) {
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (!raw || raw.version !== JSON_CACHE_VERSION || !raw.sessions || typeof raw.sessions !== 'object') return null
  return raw
}

/** A numeric field stored as JSON, keeping a legitimate `0` (and its sign) instead of `-1`. */
const storedNumber = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)

/** One stored session document → the record shape the folder works with. */
function documentToRecord(sessionId, source) {
  if (!source || typeof source !== 'object') return null
  return {
    sessionId,
    path: String(source.path ?? ''),
    fileSize: Number(source.fileSize) || 0,
    fileMtimeMs: Number(source.fileMtimeMs) || 0,
    seq: storedNumber(source.seq, -1),
    provider: source.provider ?? null,
    model: source.model ?? null,
    days: deserializeDays(source.days),
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

  return {
    kind: 'json',
    path,
    load(bounds = {}) {
      const { from, until, absolute } = resolveBounds(bounds)
      // Keep the document this store already holds while a write is pending: re-reading the file
      // here would silently discard the fold that `put` just accepted, because the pending timer
      // would then write that stale copy back. This is why an absolute range read (the year view)
      // must not reload either — it is a reporting read, not a refresh.
      if (!document || !dirty) {
        const loaded = readJsonDocument(path)
        if (loaded) document = loaded
        else {
          quarantine()
          document = { version: JSON_CACHE_VERSION, sessions: {} }
        }
      }
      const records = Object.entries(document.sessions)
        .map(([sessionId, source]) => documentToRecord(sessionId, source))
        .filter(Boolean)
      // This backend writes back exactly what it holds, so it cannot honour a *relative* window
      // without dropping history on the next save: it returns everything. An absolute range is a
      // reporting read and safe to filter.
      if (!absolute) return records
      return records.map((record) => ({ ...record, days: filterDays(record.days, from, until) }))
    },
    years() {
      const years = new Set()
      for (const source of Object.values(document?.sessions ?? {})) {
        for (const date of Object.keys(source?.days ?? {})) years.add(String(date).slice(0, 4))
      }
      return [...years].filter((year) => /^\d{4}$/.test(year)).sort().reverse()
    },
    put(record) {
      if (!document) document = { version: JSON_CACHE_VERSION, sessions: {} }
      document.sessions[record.sessionId] = {
        path: record.path,
        fileSize: record.fileSize,
        fileMtimeMs: record.fileMtimeMs,
        seq: record.seq,
        provider: record.provider,
        model: record.model,
        days: serializeDays(record.days),
      }
      dirty = true
      if (timer) return
      // Batched, because this backend pays for the whole history on every save.
      timer = setTimeout(() => {
        timer = null
        if (dirty) write()
      }, 2000)
      timer.unref?.()
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
    probe.exec(SCHEMA)
    if (version !== SQLITE_SCHEMA_VERSION) probe.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`)
    return { db: probe, version, writable: true }
  } catch (error) {
    closeQuietly(probe)
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

  /** Prepare, marking any failure as "do not touch this file" — it opened, so it is a database. */
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

  const selectSessions = prepare('SELECT id, path, file_size, file_mtime_ms, seq, provider, model FROM sessions')
  const selectDays = prepare('SELECT session_id, date, payload FROM days WHERE date >= ? AND date <= ? ORDER BY date')
  // Which years exist is a question only the store can answer: the folder holds a window, not
  // the whole history, and the panel's year list has to include years older than that window.
  const selectYears = prepare("SELECT DISTINCT substr(date, 1, 4) AS year FROM days WHERE date GLOB '[0-9][0-9][0-9][0-9]-*' ORDER BY year DESC")
  const countSessions = prepare('SELECT COUNT(*) AS n FROM sessions')
  const upsertSession = prepare(
    `INSERT INTO sessions (id, path, file_size, file_mtime_ms, seq, provider, model)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       path = excluded.path, file_size = excluded.file_size, file_mtime_ms = excluded.file_mtime_ms,
       seq = excluded.seq, provider = excluded.provider, model = excluded.model`,
  )
  const selectSessionDays = prepare('SELECT date, payload FROM days WHERE session_id = ?')
  const deleteDay = prepare('DELETE FROM days WHERE session_id = ? AND date = ?')
  const insertDay = prepare('INSERT INTO days (session_id, date, payload) VALUES (?, ?, ?)')

  /**
   * Write one session: its cursor row, plus only the days whose stored payload really differs.
   *
   * The folder hands over a whole session, so the day *set* is authoritative — a day the record no
   * longer has is deleted, which is how a log that shrank behaves (exactly as it did when this was
   * one JSON document). But a day that did not change is not rewritten: a long-lived session is
   * re-folded on every poll that sees its log grow, and re-inserting its whole history each time
   * would make a save cost grow with that session's age.
   */
  const writeSession = (record) => {
    upsertSession.run(
      record.sessionId,
      record.path,
      record.fileSize,
      record.fileMtimeMs,
      record.seq,
      record.provider,
      record.model,
    )
    const stored = new Map(selectSessionDays.all(record.sessionId).map((row) => [row.date, row.payload]))
    for (const [date, dayObj] of record.days ?? []) {
      const payload = JSON.stringify(serializeDay(dayObj))
      const known = stored.get(date)
      stored.delete(date)
      if (known === payload) continue
      if (known !== undefined) deleteDay.run(record.sessionId, date)
      insertDay.run(record.sessionId, date, payload)
    }
    // Whatever is left was stored and is not in the record any more.
    for (const date of stored.keys()) deleteDay.run(record.sessionId, date)
  }

  /** Bring an existing JSON cache across, once, keeping the old file for inspection. */
  const migrateFromJson = () => {
    // Only into an empty database, and only when there is something to bring across. A
    // database that already has rows is never re-read from the JSON file, so a failed rename
    // below cannot cause the same history to be folded in twice.
    if (!writable) return
    if ((countSessions.get()?.n ?? 0) > 0) {
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
    try {
      db.exec('BEGIN IMMEDIATE')
      for (const record of records) writeSession(record)
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

  return {
    kind: 'sqlite',
    path,
    writable,
    load(bounds = {}) {
      const { from, until } = resolveBounds(bounds)
      const byId = new Map()
      for (const row of selectSessions.all()) {
        byId.set(row.id, {
          sessionId: row.id,
          path: row.path,
          fileSize: Number(row.file_size) || 0,
          fileMtimeMs: Number(row.file_mtime_ms) || 0,
          seq: storedNumber(row.seq, -1),
          provider: row.provider ?? null,
          model: row.model ?? null,
          days: new Map(),
        })
      }
      for (const row of selectDays.all(from, until)) {
        const record = byId.get(row.session_id)
        if (!record) continue
        try {
          record.days.set(row.date, deserializeDay(JSON.parse(row.payload)))
        } catch {
          // A malformed row is skipped rather than losing the whole session.
        }
      }
      return [...byId.values()]
    },
    years() {
      return selectYears.all().map((row) => String(row.year))
    },
    put(record) {
      if (!writable) return
      try {
        db.exec('BEGIN IMMEDIATE')
        writeSession(record)
        db.exec('COMMIT')
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // the transaction is already gone
        }
        log(`cache write failed for ${record.sessionId}: ${error?.message ?? error}`)
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
 * @returns {{kind:string, path:string, load:Function, years:Function, put:Function, flush:Function, close:Function}}
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
