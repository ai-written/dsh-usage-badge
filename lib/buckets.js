/**
 * dsh-usage-badge — the token bucket model, its stored rows, and how rows resolve.
 *
 * A bucket is one (provider, model) route on one day: token totals, a 24-slot hourly
 * breakdown for the day chart, and the raw per-request records that let the pricing layer
 * apply a different multiplier to each request rather than pricing a day flat.
 *
 * This module owns two things that two very different places must agree on:
 *
 *   1. **the bucket shape and its JSON form** — the folder builds buckets while reading
 *      session logs, and the cache store moves them in and out;
 *   2. **row identity and the resolve rule** — because a day can exist in more than one copy
 *      (a session folded before its log was shortened, or history synced in from another
 *      device), and which copy counts has to be decided in exactly one place.
 *
 * ## Why rows, and why they can be plural
 *
 * A **row** is one `(session, date)` fold: the buckets for that day, plus the stamp of the log
 * version it came from. The stamp must travel *with the row* rather than be read from the
 * session cursor, because a later fold of the same session overwrites that cursor.
 *
 * A fold normally **replaces** the row for a date it folded: a log that grows produces a
 * strictly larger fold, and keeping every generation of a day would cost a full day's
 * per-request records per fold — measured at ~75 KB for a thousand requests, and a long-lived
 * session is re-folded daily. A row is kept as *superseded* only when the new fold is
 * **smaller**, which is exactly the signal of a shortened log, a restored backup, or a renamed
 * session directory. That keeps the normal path free of duplicates while making the loss of a
 * log non-destructive: the fuller fold stays until something fuller still arrives.
 *
 * `resolveRows` then collapses the copies per `(session, date)`: the more complete log version
 * wins (higher `seq`, then larger `fileSize`). The tie-break is "last fold wins", because two
 * folds of an identical stamp are the same bytes, and preferring the freshest keeps the result
 * stable rather than dependent on insertion order.
 *
 * @module dsh-usage-badge/buckets
 */

import { initHourly } from './pricing.js'

/** Bucket key and display name used when a log records no provider/model. */
export const UNKNOWN = 'unknown'

/** A fresh, empty bucket for one route. */
export function emptyBucket(provider, model) {
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
export function addBucket(target, source) {
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
 * One day, as storable JSON: `{ routeKey: bucket }`.
 *
 * The bucket objects are handed over by reference; every store either stringifies the slice
 * immediately or replaces the whole entry, and the folder never mutates a bucket it has
 * already handed over (a re-fold builds fresh ones), so aliasing is safe and avoids copying
 * a day's worth of per-request records on every save.
 */
export function serializeDay(dayObj) {
  const routes = {}
  for (const [key, bucket] of dayObj ?? []) routes[key] = bucket
  return routes
}

/** The inverse of {@link serializeDay}, rebuilding the buckets' invariants as it goes. */
export function deserializeDay(routes) {
  const dayObj = new Map()
  for (const [key, source] of Object.entries(routes ?? {})) {
    if (!source || typeof source !== 'object') continue
    const bucket = emptyBucket(String(source.provider ?? UNKNOWN), String(source.model ?? UNKNOWN))
    addBucket(bucket, source)
    dayObj.set(key, bucket)
  }
  return dayObj
}

/** A whole session's days, as storable JSON: `{ date: { routeKey: bucket } }`. */
export function serializeDays(days) {
  const plain = {}
  for (const [date, dayObj] of days ?? []) plain[date] = serializeDay(dayObj)
  return plain
}

/** The inverse of {@link serializeDays}. */
export function deserializeDays(plain) {
  const days = new Map()
  for (const [date, routes] of Object.entries(plain ?? {})) {
    if (!routes || typeof routes !== 'object') continue
    days.set(date, deserializeDay(routes))
  }
  return days
}

// ── rows and resolution ──────────────────────────────────────────────────────

/** Where a row came from: this device's own fold, or history synced in from another. */
export const LOCAL_SOURCE = 'local'

/**
 * Which copy of a `(session, date, source)` a row is.
 *
 * `current` is the fold the stored cursor stands on — the one that answers the question "what does
 * this session's log say about that day". `fallback` is a copy that was folded from a log version
 * the cursor has since moved past: a shorter log, a restored backup, a session directory that got
 * renamed. Two copies of the same key must be able to coexist (a full one and a short one), which is
 * why the slot is part of the row key rather than something inferred at read time — inferring it
 * would mean an unsatisfiable "insert a second row for this key" during a fold.
 */
export const CURRENT = 'current'
export const FALLBACK = 'fallback'

/**
 * The stamp a row carries: which log version this fold was made from.
 *
 * `seq` is the largest event sequence number seen in the log. It, not `mtime`, is the
 * cross-machine arbiter: a file's mtime moves for reasons that have nothing to do with its
 * content (a restore, a copy, a cloud client touching it), and clocks differ between machines,
 * while `seq` comes from the log itself.
 */
export const stampOf = (record) => ({
  seq: Number(record?.seq ?? -1) || 0,
  fileSize: Number(record?.fileSize ?? 0) || 0,
  fileMtimeMs: Number(record?.fileMtimeMs ?? 0) || 0,
})

/** The stamp stored on a row, so it stays readable after the session cursor moves on. */
export const rowStamp = (row) => ({
  seq: Number(row?.seq ?? -1) || 0,
  fileSize: Number(row?.fileSize ?? 0) || 0,
  fileMtimeMs: Number(row?.fileMtimeMs ?? 0) || 0,
})

/**
 * Whether `candidate` describes at least as much of the session as `incumbent`.
 *
 * Strictly greater on `seq`, or an equal `seq` with a file at least as large. Equal stamps
 * describe equal folds; the caller decides those by recency.
 */
export function rowIsNewerOrEqual(candidate, incumbent) {
  if (!incumbent) return true
  const a = rowStamp(candidate)
  const b = rowStamp(incumbent)
  if (a.seq !== b.seq) return a.seq > b.seq
  return a.fileSize >= b.fileSize
}

/** A row's `source`, defaulting to this device for anything stored before rows existed. */
export const rowSource = (row) => String(row?.source ?? LOCAL_SOURCE)

/** A row's slot: `current` for the fold the cursor stands on, `fallback` for a superseded copy. */
export const rowKind = (row) => (String(row?.kind ?? CURRENT) === FALLBACK ? FALLBACK : CURRENT)

/**
 * Whether `candidate` describes a **strictly** more complete fold than `incumbent`.
 *
 * The distinction from {@link rowIsNewerOrEqual} is what keeps resolution from depending on arrival
 * order: two copies of the same log version are the same bytes, so neither should replace the other
 * on sight — the tie belongs to the later fold's `at`, decided in one place by the resolver.
 */
export function rowIsStrictlyNewer(candidate, incumbent) {
  if (!incumbent) return true
  const a = rowStamp(candidate)
  const b = rowStamp(incumbent)
  if (a.seq !== b.seq) return a.seq > b.seq
  return a.fileSize > b.fileSize
}

/**
 * The rows a session record stands for: one per date, all carrying the record's stamp.
 *
 * `at` is the fold time. It is the tie-break when two copies describe the same log version —
 * the same bytes folded twice — where "the last one to arrive wins" keeps the outcome from
 * depending on insertion order.
 */
export function rowsOf(record, { source = LOCAL_SOURCE, at = Date.now(), kind = CURRENT } = {}) {
  const stamp = stampOf(record)
  const rows = []
  for (const [date, dayObj] of record?.days ?? []) {
    rows.push({ date, routes: serializeDay(dayObj), ...stamp, source, kind, at })
  }
  return rows
}

/**
 * Normalize whatever a backend read into rows.
 *
 * Legacy shapes are accepted rather than rejected: a row with no stamp takes the session
 * cursor's, and a row whose buckets are nested under `payload` (or which *is* the bucket map)
 * is read as-is. Every field is optional because the point is to keep an older database
 * readable, not to enforce a schema at read time.
 */
export function normalizeRows(record, rows, { source = LOCAL_SOURCE, at = 0 } = {}) {
  const fallback = stampOf(record)
  const out = []
  for (const row of rows ?? []) {
    if (!row || typeof row !== 'object') continue
    const date = row.date ?? row.day
    if (typeof date !== 'string' || date === '') continue
    const rawRoutes = row.routes ?? row.payload ?? row
    out.push({
      date,
      routes: rawRoutes && typeof rawRoutes === 'object' ? rawRoutes : {},
      seq: row.seq ?? fallback.seq,
      fileSize: row.fileSize ?? fallback.fileSize,
      fileMtimeMs: row.fileMtimeMs ?? fallback.fileMtimeMs,
      source: row.source ?? source,
      kind: rowKind(row),
      at: Number(row.at ?? at) || 0,
    })
  }
  return out
}

/**
 * Collapse each session's rows to one row per date, and rebuild the `days` maps the rest of
 * the plugin expects.
 *
 * Resolution is per `(session, date)` and never across sessions: two different sessions on the
 * same day are two different pieces of usage and are summed by `mergeRecords`, while two copies
 * of the *same* session's day are the same usage seen twice and must not be.
 *
 * @param {Iterable<object>} records - records whose `rows` arrays may hold several copies.
 * @returns {object[]} records with a resolved `days` Map and their winning stamp.
 */
export function resolveRows(records) {
  const sessions = new Map()
  for (const record of records ?? []) {
    const sessionId = String(record?.sessionId ?? '')
    let entry = sessions.get(sessionId)
    if (!entry) {
      entry = { sessionId, path: record?.path ?? '', provider: record?.provider ?? null, model: record?.model ?? null, rows: [], winners: new Map(), fileSize: record?.fileSize, fileMtimeMs: record?.fileMtimeMs, seq: record?.seq }
      sessions.set(sessionId, entry)
    }
    for (const row of normalizeRows(record, record?.rows)) {
      entry.rows.push(row)
      // A `fallback` copy never competes: it is kept for the day the fuller copy is gone, not to
      // argue with it. It still travels in `rows`, because the sync layer exports copies.
      if (rowKind(row) === FALLBACK) continue
      const incumbent = entry.winners.get(row.date)
      // A fuller log version wins outright; between two copies of the same version (the same
      // bytes folded twice) the later fold wins, so the result does not depend on read order.
      const equalVersion = incumbent !== undefined && rowStamp(row).seq === rowStamp(incumbent).seq && rowStamp(row).fileSize === rowStamp(incumbent).fileSize
      const wins = incumbent === undefined
        || (rowIsNewerOrEqual(row, incumbent) && (equalVersion ? (row.at ?? 0) >= (incumbent.at ?? -1) : true))
      if (wins) entry.winners.set(row.date, row)
    }
  }

  const resolved = []
  for (const entry of sessions.values()) {
    const days = new Map()
    const byDate = [...entry.winners.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    for (const row of byDate) days.set(row.date, deserializeDay(row.routes))
    const winner = byDate[0] ?? null
    resolved.push({
      sessionId: entry.sessionId,
      path: entry.path,
      fileSize: winner?.fileSize ?? entry.fileSize ?? 0,
      fileMtimeMs: winner?.fileMtimeMs ?? entry.fileMtimeMs ?? 0,
      seq: winner?.seq ?? entry.seq ?? -1,
      provider: entry.provider,
      model: entry.model,
      days,
      rows: entry.rows,
    })
  }
  return resolved
}

/** One row restricted to `[since, until]`, both optional and both inclusive day keys. */
export const rowWithin = (row, since, until) =>
  (since === undefined || row.date >= since) && (until === undefined || row.date <= until)

/** Keep only the rows whose date falls inside the bounds. */
export function filterRows(rows, since, until) {
  if (since === undefined && until === undefined) return rows ?? []
  return (rows ?? []).filter((row) => rowWithin(row, since, until))
}

/**
 * Bring a day map written in the pre-row storage format in as rows.
 *
 * The old document kept `{ date: { routeKey: bucket } }` with one stamp per session, so every
 * date it holds becomes a row carrying that stamp. Those rows contain no unresolved
 * duplicates, which is why an upgrade can import them unchanged.
 */
export function legacyDayRows(days, stamp = {}) {
  const rows = []
  for (const [date, routes] of Object.entries(days ?? {})) {
    if (!routes || typeof routes !== 'object') continue
    rows.push({
      date,
      routes,
      seq: stamp.seq ?? -1,
      fileSize: stamp.fileSize ?? 0,
      fileMtimeMs: stamp.fileMtimeMs ?? 0,
      source: LOCAL_SOURCE,
      at: 0,
    })
  }
  return rows
}
