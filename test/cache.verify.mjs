/**
 * Cache-store verification.
 *
 * The store is what makes history outlive the session logs, so it is checked on two fronts:
 * the contract both backends owe the folder, and the behaviour that only shows up across a
 * restart. The interesting cases are all about what happens when something disappears —
 * a session log, a day outside the loading window, an old JSON cache — because "the log is
 * gone but the numbers are still there" is the whole reason this layer exists.
 *
 * Both backends are exercised: `sqlite` (the default) and `json` (the fallback, forced with
 * `DSH_USAGE_BADGE_CACHE=json`). The contract assertions run against whichever one is in play,
 * so a backend cannot quietly stop honouring the interface.
 *
 * Usage:
 *   node test/cache.verify.mjs
 */

import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { CACHE_WINDOW_DAYS, createCacheStore } from '../lib/cache-store.js'
import { rowKind } from '../lib/buckets.js'
import { createChecker, makeHome, mount, summaryFor, writePricing, writeSession } from './helpers.mjs'

const { check, finish } = createChecker('CACHE VERIFY')

const storeRoot = (root) => join(root, 'storages', 'usage-badge')
const dayKeyOf = (offset) => {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** One bucket as the stores hold it: plain JSON, with the shapes the folder produces. */
const bucket = (provider, model, input, output = 0) => ({
  provider,
  model,
  input,
  cacheRead: 0,
  cacheWrite: 0,
  output,
  requests: 1,
  hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, input: hour === 10 ? input : 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: hour === 10 ? 1 : 0 })),
  usageRecords: [{ input, cacheRead: 0, cacheWrite: 0, output, hour: 10 }],
})

/** A record in the shape the folder hands the store: Maps, one day per entry. */
const recordOf = (sessionId, days, extra = {}) => ({
  sessionId,
  path: `/logs/${sessionId}/session.jsonl`,
  fileSize: 100,
  fileMtimeMs: 200,
  seq: 7,
  provider: 'p',
  model: 'm',
  days: new Map(days.map(([date, entries]) => [date, new Map(entries.map(([key, plain]) => [key, { ...plain }]))])),
  ...extra,
})

// ── 1. the contract, against both backends ───────────────────────────────────
for (const kind of ['sqlite', 'json']) {
  const root = makeHome(`store-${kind}`)
  const dir = storeRoot(root)
  mkdirSync(dir, { recursive: true })
  const env = kind === 'json' ? { DSH_USAGE_BADGE_CACHE: 'json' } : {}
  const today = dayKeyOf(0)
  const recent = dayKeyOf(-10)
  const ancient = dayKeyOf(-CACHE_WINDOW_DAYS - 70)

  {
    const store = createCacheStore({ dir, log: () => {}, env })
    check(`${kind}: the requested backend is the one opened`, store.kind === kind, store.kind)
    store.load()
    store.put(
      recordOf('s1', [
        [today, [['p|m', bucket('p', 'm', 1_000_000, 2_000_000)]]],
        [recent, [['p|m', bucket('p', 'm', 500, 600)]]],
        [ancient, [['p|m', bucket('p', 'm', 42)]]],
      ]),
    )
    store.flush()
    store.close()
  }

  {
    // Reopened: this is what a host restart does.
    const store = createCacheStore({ dir, log: () => {}, env })
    const loaded = store.load()
    const session = loaded.find((row) => row.sessionId === 's1')
    check(`${kind}: a session comes back with its cursor`, Boolean(session) && session.seq === 7 && session.path.endsWith('session.jsonl'), JSON.stringify(session && { seq: session.seq, path: session.path }))
    const todayBucket = session?.days.get(today)?.get('p|m')
    check(
      `${kind}: the bucket round-trips, hourly slots and per-request records included`,
      todayBucket?.input === 1_000_000 && todayBucket?.output === 2_000_000 && todayBucket?.requests === 1 &&
        todayBucket?.hourly[10]?.input === 1_000_000 && todayBucket?.usageRecords?.[0]?.hour === 10,
      JSON.stringify(todayBucket && { input: todayBucket.input, hour10: todayBucket.hourly[10].input, records: todayBucket.usageRecords.length }),
    )
    check(`${kind}: a recent day inside the window is loaded`, session?.days.has(recent) === true)
    // Which years exist is a store question, not a snapshot question: the panel's year picker is
    // built from this list, so a year the folder no longer holds in memory still appears.
    check(
      `${kind}: the store lists the years it holds, newest first`,
      JSON.stringify(store.years()) === JSON.stringify([today.slice(0, 4), ancient.slice(0, 4)]),
      store.years().join(','),
    )
    const range = store.load({ since: '2000-01-01', until: `${ancient.slice(0, 4)}-12-31` }).find((row) => row.sessionId === 's1')
    check(
      `${kind}: a bounded range read returns that year and not the others`,
      range?.days.get(ancient)?.get('p|m')?.input === 42 && range?.days.has(today) === false,
      [...(range?.days.keys() ?? [])].join(','),
    )
    // The window is a *loading* decision, never a deletion: the JSON backend keeps the whole
    // document, and SQLite keeps the row while simply not reading it back yet.
    if (kind === 'sqlite') {
      check('sqlite: a day older than the window is left on disk, not loaded', session?.days.has(ancient) === false, [...(session?.days.keys() ?? [])].join(','))
      const again = createCacheStore({ dir, log: () => {}, env })
      const wider = again.load({ windowDays: CACHE_WINDOW_DAYS + 200 }).find((row) => row.sessionId === 's1')
      check('sqlite: ...and asking for a wider window still finds it', wider?.days.get(ancient)?.get('p|m')?.input === 42, `${[...(wider?.days.keys() ?? [])].join(',')}`)
      again.close()
    } else {
      check('json: the whole document comes back, window or not', session?.days.get(ancient)?.get('p|m')?.input === 42)
    }

    // A session is written as a whole: a day a **fuller** log no longer has disappears with it —
    // the same semantics the single-document cache always had. The stamp has to be fuller for that
    // to apply, which is the distinction the row model introduces (see section 8): an equal or
    // weaker rewrite is a rollback, not a deletion.
    store.put(recordOf('s1', [[today, [['p|m', bucket('p', 'm', 5, 5)]]]], { fileSize: 200, seq: 9 }))
    store.flush()
    const after = store.load().find((row) => row.sessionId === 's1')
    check(`${kind}: a fuller rewrite replaces its day set`, after?.days.get(today)?.get('p|m')?.input === 5 && after?.days.has(recent) === false, [...(after?.days.keys() ?? [])].join(','))
    store.close()
  }
}

// ── 2. an old JSON cache migrates once, and keeps the old file ───────────────
{
  const root = makeHome('migrate')
  const dir = storeRoot(root)
  mkdirSync(dir, { recursive: true })
  const today = dayKeyOf(0)
  const legacy = {
    version: 1,
    sessions: {
      old1: { path: '/logs/old1/session.jsonl', fileSize: 10, fileMtimeMs: 20, seq: 4, provider: 'p', model: 'm', days: { [today]: { 'p|m': bucket('p', 'm', 777, 888) } } },
    },
  }
  writeFileSync(join(dir, 'cache.json'), JSON.stringify(legacy))

  const store = createCacheStore({ dir, log: () => {}, env: {} })
  check('migration: the sqlite backend is used even though a JSON cache existed', store.kind === 'sqlite', store.kind)
  const loaded = store.load().find((row) => row.sessionId === 'old1')
  check('migration: the old history is in the database', loaded?.days.get(today)?.get('p|m')?.input === 777 && loaded?.seq === 4, JSON.stringify(loaded?.days.get(today)?.get('p|m')?.input))
  store.close()

  const files = readdirSync(dir)
  check('migration: the old cache is renamed, not deleted', files.includes('cache.json.migrated') && !files.includes('cache.json'), files.join(','))
  check('migration: the database is where the data now lives', files.includes('cache.sqlite'), files.join(','))

  // Opening again must not read the renamed file back in (the rows are already there).
  const again = createCacheStore({ dir, log: () => {}, env: {} })
  const rows = again.load()
  check('migration: a second open does not migrate again', rows.length === 1 && rows[0].days.get(today)?.get('p|m')?.input === 777, `${rows.length} session(s)`)
  again.close()
}

// ── 3. a broken cache file is repaired; a newer one is left alone ───────────
{
  // Unreadable (a torn write, another program's file, a half-copied backup): moved aside once and
  // replaced, rather than degrading to the slow backend on every future start.
  const root = makeHome('broken-cache')
  writePricing(root, {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    multiplier: 1,
    default: { inputPerMillion: 1e6, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: 'cny' },
    overrides: {},
  })
  writeSession(root, 's1', { provider: 'p', model: 'm', time: Date.now() - 60_000, input: 1000 })
  const dir = storeRoot(root)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cache.sqlite'), 'not a database')

  const host = await mount(root, 'broken-cache')
  const summary = (await host.call('GET', '/usage-badge/summary')).body
  const config = (await host.call('GET', '/usage-badge/config')).body
  const files = readdirSync(dir)
  const aside = files.find((name) => name.startsWith('cache.sqlite.corrupt-'))
  check(
    'an unreadable cache file is moved aside and replaced, not fallen back from',
    config.paths.cacheKind === 'sqlite' && summary.today.amount === 1000 && Boolean(aside) && files.includes('cache.sqlite'),
    files.join(','),
  )
  check(
    'the unreadable file is kept for inspection, not deleted',
    aside ? readFileSync(join(dir, aside), 'utf8') === 'not a database' : false,
    'the original bytes survive',
  )
}

{
  // A newer schema's database: read it if it can be read, never write it, never move it — a
  // downgrade must not destroy data it does not understand.
  const root = makeHome('newer-schema')
  writePricing(root, {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    multiplier: 1,
    default: { inputPerMillion: 1e6, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: 'cny' },
    overrides: {},
  })
  writeSession(root, 's1', { provider: 'p', model: 'm', time: Date.now() - 60_000, input: 1000 })
  const dir = storeRoot(root)
  mkdirSync(dir, { recursive: true })
  const { DatabaseSync } = await import('node:sqlite')
  const seed = new DatabaseSync(join(dir, 'cache.sqlite'))
  seed.exec(
    `CREATE TABLE sessions (id TEXT PRIMARY KEY, path TEXT NOT NULL, file_size INTEGER NOT NULL, file_mtime_ms REAL NOT NULL, seq INTEGER NOT NULL, provider TEXT, model TEXT);
     CREATE TABLE days (session_id TEXT NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, seq INTEGER NOT NULL, file_size INTEGER NOT NULL, file_mtime_ms REAL NOT NULL, at REAL NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (session_id, date, source, kind)) WITHOUT ROWID;
     PRAGMA user_version = 99;`,
  )
  seed.close()

  const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
  const files = readdirSync(dir)
  const before = { hash: digest(join(dir, 'cache.sqlite')), mtime: statSync(join(dir, 'cache.sqlite')).mtimeMs, files: [...files].sort().join(',') }

  const host = await mount(root, 'newer-schema')
  const config = (await host.call('GET', '/usage-badge/config')).body
  const after = { hash: digest(join(dir, 'cache.sqlite')), mtime: statSync(join(dir, 'cache.sqlite')).mtimeMs, files: readdirSync(dir).sort().join(',') }
  check(
    'a newer schema is used read-only and never moved aside',
    config.paths.cacheKind === 'sqlite' && after.files.includes('cache.sqlite') && !after.files.includes('corrupt'),
    after.files,
  )
  // "Left exactly as it is" has to mean the bytes: `journal_mode = WAL` is persistent, so opening
  // it read-write would rewrite a file this build does not understand and add -wal/-shm beside it.
  check(
    'a database written by a newer version comes back byte-for-byte unchanged',
    after.hash === before.hash && after.mtime === before.mtime && after.files === before.files,
    `hash ${before.hash.slice(0, 8)}→${after.hash.slice(0, 8)}, files ${before.files} → ${after.files}`,
  )
  const probe = new DatabaseSync(join(dir, 'cache.sqlite'))
  const rows = probe.prepare('SELECT COUNT(*) AS n FROM sessions').get().n
  probe.close()
  check('nothing is written into a newer version’s database', rows === 0, `${rows} row(s)`)
}

// ── 4. failures that only show up when something is wrong ───────────────────
{
  // A pending JSON save must survive the year view's range read. That read used to reload the
  // document from disk, and the pending timer then wrote that stale copy back — silently losing
  // the fold `put` had just accepted (and, if the log was deleted meanwhile, the history with it).
  const root = makeHome('json-pending')
  const dir = storeRoot(root)
  mkdirSync(dir, { recursive: true })
  const env = { DSH_USAGE_BADGE_CACHE: 'json' }
  const store = createCacheStore({ dir, log: () => {}, env })
  const today = dayKeyOf(0)
  store.load()
  store.put(recordOf('kept', [[today, [['p|m', bucket('p', 'm', 7)]]]]))
  store.load({ since: `${today.slice(0, 4)}-01-01`, until: `${today.slice(0, 4)}-12-31` })
  store.flush()

  const reopened = createCacheStore({ dir, log: () => {}, env })
  const rows = reopened.load()
  check(
    'a pending JSON save survives a range read (the year view performs one)',
    rows.length === 1 && rows[0].days.get(today)?.get('p|m')?.input === 7,
    `${rows.length} session(s) on disk after the flush`,
  )
  reopened.close()
  store.close()
}

{
  // A log that cannot be decoded must not delete the days the folder did not load: `foldSession`
  // hands the previous record back, and writing it again replaces that session's rows with just the
  // loading window — the very path that exists to protect history, destroying it.
  const root = makeHome('undecodable')
  writePricing(root, {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    multiplier: 1,
    default: { inputPerMillion: 1e6, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: 'cny' },
    overrides: {},
  })
  const oldYear = new Date().getFullYear() - 3
  writeSession(root, 's1', { provider: 'p', model: 'm', time: new Date(oldYear, 5, 15, 10, 0, 0).getTime(), input: 2000 })
  const first = await mount(root, 'undecodable-1')
  const before = (await first.call('GET', `/usage-badge/year?year=${oldYear}`)).body
  check(
    'undecodable: the session is stored to begin with',
    before.total.amount === 2000 && before.days === 1,
    JSON.stringify({ amount: before.total.amount, days: before.days }),
  )

  // Replace the log with the zstd magic followed by rubbish: the folder recognises the frame, fails
  // to decompress it, and keeps what it already had.
  const logDir = join(root, 'sessions', 's1')
  rmSync(join(logDir, 'session.jsonl'), { force: true })
  writeFileSync(join(logDir, 'session.jsonl.zstd'), Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('torn frame')]))

  const second = await mount(root, 'undecodable-2')
  const after = (await second.call('GET', `/usage-badge/year?year=${oldYear}`)).body
  check(
    'an unreadable log does not delete days it could not have loaded',
    after.total.amount === 2000 && after.days === 1,
    JSON.stringify({ amount: after.total.amount, days: after.days }),
  )
}

{
  // A database that cannot be written is used read-only, never "repaired": rotating a healthy file
  // aside to fix a permission problem throws away the user's history.
  const root = makeHome('readonly-cache')
  writePricing(root, {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    multiplier: 1,
    default: { inputPerMillion: 1e6, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: 'cny' },
    overrides: {},
  })
  writeSession(root, 's1', { provider: 'p', model: 'm', time: Date.now() - 60_000, input: 1000 })
  const first = await mount(root, 'readonly-1')
  await first.call('GET', '/usage-badge/summary')

  const dir = storeRoot(root)
  const dbPath = join(dir, 'cache.sqlite')
  chmodSync(dbPath, 0o444)
  try {
    const host = await mount(root, 'readonly-2')
    const summary = (await host.call('GET', '/usage-badge/summary')).body
    const config = (await host.call('GET', '/usage-badge/config')).body
    const files = readdirSync(dir)
    check(
      'a cache that cannot be written is used read-only, not moved aside',
      config.paths.cacheKind === 'sqlite' && !files.some((name) => name.includes('corrupt')) && files.includes('cache.sqlite'),
      files.join(','),
    )
    check('and its history is still reported', summary.today.amount === 1000, `amount ${summary.today.amount}`)
  } finally {
    chmodSync(dbPath, 0o666)
  }
}

{
  // A stale JSON cache beside a non-empty database is ignored — but not silently.
  const root = makeHome('stale-json')
  const dir = storeRoot(root)
  mkdirSync(dir, { recursive: true })
  const store = createCacheStore({ dir, log: () => {}, env: {} })
  store.load()
  store.put(recordOf('s1', [[dayKeyOf(0), [['p|m', bucket('p', 'm', 1)]]]]))
  store.flush()
  store.close()
  writeFileSync(join(dir, 'cache.json'), JSON.stringify({ version: 1, sessions: {} }))

  const notes = []
  const again = createCacheStore({ dir, log: (message) => notes.push(message), env: {} })
  again.load()
  again.close()
  check(
    'a leftover cache.json beside a non-empty database is reported, not silently dropped',
    notes.some((message) => message.includes('cache.json') && message.includes('not read')),
    notes.join(' | ') || '(nothing logged)',
  )
}

{
  // An unparsable cache.json is kept, the way the SQLite side keeps one.
  const root = makeHome('corrupt-json')
  const dir = storeRoot(root)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cache.json'), '{ this is not json')
  const store = createCacheStore({ dir, log: () => {}, env: { DSH_USAGE_BADGE_CACHE: 'json' } })
  store.load()
  check(
    'an unparsable cache.json is moved aside instead of being overwritten',
    readdirSync(dir).some((name) => name.startsWith('cache.json.corrupt-')),
    readdirSync(dir).join(','),
  )
  store.close()
}

{
  // The small contract details that would otherwise rot silently.
  const root = makeHome('store-details')
  const dir = storeRoot(root)
  mkdirSync(dir, { recursive: true })
  const today = dayKeyOf(0)
  const old = dayKeyOf(-800)

  const store = createCacheStore({ dir, log: () => {}, env: {} })
  store.load()
  // `seq: 0` is a legitimate sequence number, not a missing value.
  store.put(recordOf('zero', [[today, [['p|m', bucket('p', 'm', 3)]]]], { seq: 0 }))
  store.put(recordOf('old', [[old, [['p|m', bucket('p', 'm', 5)]]]]))
  store.flush()

  const zero = store.load().find((row) => row.sessionId === 'zero')
  check('a sequence number of 0 survives the round trip', zero?.seq === 0, String(zero?.seq))
  const untilOnly = store.load({ until: old }).find((row) => row.sessionId === 'old')
  check(
    'an upper bound with no lower bound means everything up to then',
    untilOnly?.days.has(old) === true,
    [...(untilOnly?.days.keys() ?? [])].join(','),
  )
  // The store's own close must not depend on being called as a method.
  const { close } = store
  let threw = false
  try {
    close()
  } catch (error) {
    threw = String(error?.message ?? error)
  }
  check('close() works when it is pulled off the store', threw === false, String(threw))
}

{
  // An oversized body is the caller's mistake, so it is a 413 rather than a 500.
  const root = makeHome('oversize')
  writePricing(root, {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    multiplier: 1,
    default: { inputPerMillion: 1e6, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: 'cny' },
    overrides: {},
  })
  const host = await mount(root, 'oversize')
  const huge = { overrides: { [`k${'x'.repeat(300_000)}`]: { inputPerMillion: 1 } } }
  const response = await host.call('PUT', '/usage-badge/config', huge)
  check('an oversized request body is rejected as 413', response.status === 413, `${response.status} ${JSON.stringify(response.body).slice(0, 80)}`)
}

// ── 5. through the host half: a deleted log must not take its history ────────
{
  const root = makeHome('deleted-log')
  writePricing(root, {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    multiplier: 1,
    default: { inputPerMillion: 1e6, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: 'cny' },
    overrides: {},
  })
  writeSession(root, 'gone-soon', { provider: 'p', model: 'm', time: Date.now() - 60_000, input: 1000 })

  // One mounted host for the write-behaviour checks, so the only thing that could touch the
  // file between the two stats is the refresh itself.
  const host = await mount(root, 'deleted-log')
  const first = (await host.call('GET', '/usage-badge/summary')).body
  check('host: the session is folded and counted', first.status.sessions === 1 && first.today.amount === 1000, JSON.stringify({ sessions: first.status.sessions, amount: first.today.amount }))

  const storeFile = join(storeRoot(root), 'cache.sqlite')
  const settled = statSync(storeFile)
  // Past the snapshot TTL, so the second call really does run another fold instead of
  // answering from the payload the first one built.
  await new Promise((resolve) => setTimeout(resolve, 2200))
  const idle = (await host.call('GET', '/usage-badge/summary')).body
  const afterIdle = statSync(storeFile)
  check(
    'host: a refresh with nothing changed writes nothing',
    idle.status.folded === 0 && afterIdle.mtimeMs === settled.mtimeMs && afterIdle.size === settled.size,
    `folded ${idle.status.folded}, ${settled.size}B@${settled.mtimeMs} → ${afterIdle.size}B@${afterIdle.mtimeMs}`,
  )

  // The question this whole layer exists to answer: the log disappears, the numbers do not.
  // A fresh mount is what a host restart does, so this is the persisted path, not a live cache.
  rmSync(join(root, 'sessions'), { recursive: true, force: true })
  const after = await summaryFor(root, 'deleted-log-restart')
  check(
    'host: deleting every session log leaves the history intact across a restart',
    after.today.amount === 1000 && after.status.files === 0,
    JSON.stringify({ amount: after.today.amount, files: after.status.files, sessions: after.status.sessions }),
  )
  check('host: the deleted session is still counted', after.status.sessions === 1, String(after.status.sessions))
  check('host: the day still carries its tokens', after.today.input === 1000, String(after.today.input))
}

// ── 6. the JSON fallback still runs the whole plugin ────────────────────────
{
  const root = makeHome('json-fallback')
  writePricing(root, {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    multiplier: 1,
    default: { inputPerMillion: 1e6, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: 'cny' },
    overrides: {},
  })
  writeSession(root, 'fallback', { provider: 'p', model: 'm', time: Date.now() - 60_000, input: 2000 })

  const previous = process.env.DSH_USAGE_BADGE_CACHE
  process.env.DSH_USAGE_BADGE_CACHE = 'json'
  try {
    const host = await mount(root, 'json-fallback')
    const snapshot = (await host.call('GET', '/usage-badge/summary')).body
    const config = (await host.call('GET', '/usage-badge/config')).body
    check('fallback: the host reports the JSON store', config.paths.cacheKind === 'json' && config.paths.cache.endsWith('cache.json'), JSON.stringify({ kind: config.paths.cacheKind, path: config.paths.cache }))
    check('fallback: amounts are the same as with sqlite', snapshot.today.amount === 2000, String(snapshot.today.amount))
    check('fallback: the file it wrote is the JSON cache', readdirSync(storeRoot(root)).includes('cache.json'), readdirSync(storeRoot(root)).join(','))
  } finally {
    if (previous === undefined) delete process.env.DSH_USAGE_BADGE_CACHE
    else process.env.DSH_USAGE_BADGE_CACHE = previous
  }
}

// ── 7. the year view: the year list is the data's, not a list in the code ────
{
  const root = makeHome('year-view')
  writePricing(root, {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    multiplier: 1,
    default: { inputPerMillion: 1e6, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: 'cny' },
    overrides: {},
  })
  // Three years back is outside the loading window whatever today is, so this pins the case the
  // year view exists for: history the folder does not hold in memory but the store still does.
  const oldYear = String(new Date().getFullYear() - 3)
  const thisYear = String(new Date().getFullYear())
  writeSession(root, 'this-year', { provider: 'p', model: 'm', time: Date.now() - 60_000, input: 1000 })
  writeSession(root, 'old-year', { provider: 'p', model: 'm', time: new Date(Number(oldYear), 5, 15, 10, 0, 0).getTime(), input: 2000 })

  const host = await mount(root, 'year-view')
  const snapshot = (await host.call('GET', '/usage-badge/summary')).body
  check(
    'year: the picker list comes from the store, newest first, gaps and all',
    JSON.stringify(snapshot.years) === JSON.stringify([thisYear, oldYear]),
    JSON.stringify(snapshot.years),
  )
  // Both days are in the snapshot here, and that is correct: `DAYS_KEPT` keeps the newest 400
  // days *that have usage*, not the last 400 calendar days, so a history this short fits whole.
  // The year route reads the store rather than the snapshot anyway, which is what makes it work
  // once the history is longer than that — pinned in the contract section above, where a day
  // outside the loading window is on disk but not loaded and a range read finds it.
  check('year: a short history fits in the snapshot whole', snapshot.days.length === 2, `${snapshot.days.length} day(s)`)

  const year = (await host.call('GET', `/usage-badge/year?year=${oldYear}`)).body
  check('year: twelve natural months, always', year.year === Number(oldYear) && year.months.length === 12, `${year.months?.length} month(s)`)
  const june = year.months.find((month) => month.month === `${oldYear}-06`)
  check(
    'year: the month with usage carries its totals',
    june?.amount === 2000 && june?.requests === 1 && june?.input === 2000,
    JSON.stringify(june && { amount: june.amount, requests: june.requests, input: june.input }),
  )
  check(
    'year: the other eleven months are present and empty',
    year.months.filter((month) => month.amount === 0).length === 11 && year.total.amount === 2000 && year.days === 1,
    `${year.months.filter((month) => month.amount === 0).length} empty, total ${year.total.amount}, days ${year.days}`,
  )
  check(
    'year: each month carries per-provider rows, so the provider filter keeps working',
    june?.providers?.find((row) => row.provider === 'p')?.amount === 2000,
    JSON.stringify(june?.providers),
  )
  // The heatmap next to the monthly chart draws the calendar year, so it needs the days that
  // had usage — with their marks, which is the only way a past holiday can be shaded.
  const oldJune = `${oldYear}-06-15`
  check(
    'year: the payload carries the year’s days for the heatmap',
    year.daily?.length === 1 && year.daily[0].date === oldJune && year.daily[0].amount === 2000 &&
      year.daily[0].dayClass === 'normal' &&
      year.daily[0].providers?.find((row) => row.provider === 'p')?.amount === 2000,
    JSON.stringify(year.daily?.[0]),
  )

  const empty = (await host.call('GET', '/usage-badge/year?year=1999')).body
  check(
    'year: a year with no data is twelve empty months, not an error',
    empty.months.length === 12 && empty.total.amount === 0 && empty.days === 0,
    JSON.stringify({ days: empty.days, amount: empty.total.amount }),
  )
  const bad = await host.call('GET', '/usage-badge/year?year=nope')
  check('year: a malformed year is rejected', bad.status === 400 && typeof bad.body.error === 'string', `${bad.status} ${bad.body?.error}`)

  // The route must read the **store**, not the in-memory window. With the logs deleted a remounted
  // host cannot have that year's days in memory at all, so a memory-backed `/year` would go blank
  // while the numbers are still sitting in the database.
  rmSync(join(root, 'sessions'), { recursive: true, force: true })
  const afterLogs = await mount(root, 'year-view-nologs')
  const summaryAfter = (await afterLogs.call('GET', '/usage-badge/summary')).body
  const yearAfter = (await afterLogs.call('GET', `/usage-badge/year?year=${oldYear}`)).body
  check(
    'year: it still answers after the logs are gone, where the snapshot cannot',
    summaryAfter.days.some((day) => day.date.startsWith(oldYear)) === false &&
      yearAfter.days === 1 &&
      yearAfter.total.amount === 2000,
    `snapshot has the year: ${summaryAfter.days.some((day) => day.date.startsWith(oldYear))}, /year days ${yearAfter.days}`,
  )
}

// ── 8. the loading window is wider than what the snapshot can ask for ───────
{
  const hostSource = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const daysKept = Number(/const DAYS_KEPT = (\d+)/.exec(hostSource)?.[1])
  // Both numbers count different things — the window bounds *calendar* days read back from disk,
  // `DAYS_KEPT` bounds the newest days *that have usage* — so this is a sanity bound rather than an
  // exact containment proof: the window must not be the smaller of the two.
  check(
    'the store’s calendar-day window is at least as wide as the snapshot’s day count',
    Number.isFinite(daysKept) && CACHE_WINDOW_DAYS > daysKept,
    `window ${CACHE_WINDOW_DAYS} calendar days vs DAYS_KEPT ${daysKept} usage days`,
  )
}

// ── 8. rows: a shortened log does not erase history, and does not bloat either ─────
//
// The row model exists for one measured failure and must not introduce a second one:
//
//   - a session log that gets shorter (a restored backup, a pruned log, a renamed session
//     directory) used to rewrite that session's day set smaller, so the cached history shrank with
//     it — the exact moment the cache is the only copy left;
//   - "keep every fold" would fix that by storing a full day's per-request records per fold, and a
//     long-lived session is re-folded every day it is used (~75 KB a time for a thousand requests).
//
// So both halves are asserted here, against both backends: the fuller copy survives, and repeated
// folds of a growing log do not accumulate copies.
for (const kind of ['sqlite', 'json']) {
  const root = makeHome(`rows-${kind}`)
  const dir = storeRoot(root)
  mkdirSync(dir, { recursive: true })
  const env = kind === 'json' ? { DSH_USAGE_BADGE_CACHE: 'json' } : {}
  const day = dayKeyOf(0)
  const other = dayKeyOf(-3)
  const store = createCacheStore({ dir, log: () => {}, env })

  const fold = (days, stamp) => {
    const record = recordOf('s1', days, stamp)
    const resolved = store.put(record, { source: 'local', at: stamp.fileMtimeMs })
    return resolved ?? store.load().find((row) => row.sessionId === 's1')
  }
  /** The copies the store is actually holding, as rows (what the sync layer would export). */
  const copies = () => store.scan().find((row) => row.sessionId === 's1')?.rows ?? []

  // A log that grows: the same day, folded ten times with a higher seq and a bigger file.
  for (let i = 1; i <= 10; i++) {
    fold([[day, [['p|m', bucket('p', 'm', i * 1000)]]]], { fileSize: i * 1000, fileMtimeMs: i, seq: i })
  }
  const grown = store.load().find((row) => row.sessionId === 's1')
  check(`${kind}: ten folds of a growing log leave one row per day, not ten`, copies().length === 1, `${copies().length} row(s)`)
  check(`${kind}: ...and the day holds the newest fold`, grown?.days.get(day)?.get('p|m')?.input === 10000, String(grown?.days.get(day)?.get('p|m')?.input))

  // The log is restored from an older backup: same date, smaller file, lower seq.
  const shorter = fold([[day, [['p|m', bucket('p', 'm', 500)]]]], { fileSize: 500, fileMtimeMs: 11, seq: 3 })
  check(`${kind}: the shortened fold does not erase the fuller day`, shorter?.days.get(day)?.get('p|m')?.input === 10000, String(shorter?.days.get(day)?.get('p|m')?.input))
  check(`${kind}: the short fold is kept beside it as a fallback`, copies().length === 2, `${copies().length} row(s)`)
  check(`${kind}: ...and the resolver picked the fuller one`, copies().filter((row) => row.seq === 10).length === 1)

  // The log comes back: a fuller fold covers both days again and replaces the copies.
  const restored = fold([[day, [['p|m', bucket('p', 'm', 20000)]]], [other, [['p|m', bucket('p', 'm', 7)]]]], { fileSize: 9000, fileMtimeMs: 99, seq: 40 })
  check(
    `${kind}: a fuller log replaces the fallback copies`,
    restored?.days.get(day)?.get('p|m')?.input === 20000 && restored?.days.get(other)?.get('p|m')?.input === 7,
    `day ${restored?.days.get(day)?.get('p|m')?.input}, other ${restored?.days.get(other)?.get('p|m')?.input}`,
  )
  check(`${kind}: ...and the short fold's copy is still held as a fallback`, copies().length === 3, `${copies().length} row(s)`)

  // The log trims a day away while still growing: a *fuller* fold whose day set no longer has it.
  // That day is genuinely gone from the log, so this device's row for it goes.
  const trimmed = fold([[other, [['p|m', bucket('p', 'm', 7)]]]], { fileSize: 12000, fileMtimeMs: 130, seq: 50 })
  check(`${kind}: a day a fuller log no longer covers is dropped`, trimmed?.days.has(day) === false && trimmed?.days.has(other) === true, [...(trimmed?.days.keys() ?? [])].join(','))

  // Whereas a *shorter* fold that drops a day is indistinguishable from a restored backup, so the
  // day it cannot see is kept rather than deleted — this is the whole point of the row model.
  fold([[day, [['p|m', bucket('p', 'm', 20000)]]]], { fileSize: 12000, fileMtimeMs: 131, seq: 50 })
  const rolledBack = fold([[other, [['p|m', bucket('p', 'm', 7)]]]], { fileSize: 300, fileMtimeMs: 132, seq: 5 })
  check(`${kind}: a shorter fold keeps the day it cannot see`, rolledBack?.days.has(day) === true, [...(rolledBack?.days.keys() ?? [])].join(','))
  check(`${kind}: ...and the fuller copy is still the one that counts`, rolledBack?.days.get(day)?.get('p|m')?.input === 20000, String(rolledBack?.days.get(day)?.get('p|m')?.input))

  store.close()
}

// ── 9. rows from another device: stored, never deleted, never downgraded ─────
//
// The import path takes rows, not records: a shard is a set of rows, each carrying its own device
// and its own stamp. Two things must hold, and they are the whole reason this path is separate from
// the fold path: an import never deletes anything, and it never replaces a fuller copy with a
// weaker one — not even a copy the same source pushed earlier.
{
  const root = makeHome('rows-sync')
  const dir = storeRoot(root)
  mkdirSync(dir, { recursive: true })
  const store = createCacheStore({ dir, log: () => {}, env: {} })
  const day = dayKeyOf(0)
  const other = dayKeyOf(-4)
  const copies = () => store.scan().find((row) => row.sessionId === 's1')?.rows ?? []
  const merged = () => store.load().find((row) => row.sessionId === 's1')
  /** One row as a shard carries it. */
  const incoming = (date, input, stamp, sessionId = 's1') => ({
    sessionId,
    date,
    source: 'device-b',
    kind: 'current',
    seq: stamp.seq,
    fileSize: stamp.fileSize,
    fileMtimeMs: stamp.fileMtimeMs,
    at: stamp.at ?? 10,
    routes: { 'p|m': bucket('p', 'm', input) },
  })

  // History arrives from another device. The session id matches because it is derived from the log
  // path, which is exactly why the merge key cannot include the device: two machines that once held
  // the same log produce the same id, and adding them up would count that usage twice.
  const written = store.intakeRows([
    incoming(day, 4000, { seq: 30, fileSize: 5000, fileMtimeMs: 50 }),
    incoming(other, 1, { seq: 30, fileSize: 5000, fileMtimeMs: 50 }),
  ])
  check('rows from another device are stored and readable', written === 2 && merged()?.days.get(day)?.get('p|m')?.input === 4000, `${written} written`)
  check('...tagged with the device they came from', copies().every((row) => row.source === 'device-b'), JSON.stringify(copies().map((row) => row.source)))

  // The same device pushes a weaker copy of the same day — the classic "this machine's logs were
  // pruned" case. It must not replace the fuller copy already held.
  const weaker = store.intakeRows([incoming(day, 7, { seq: 2, fileSize: 100, fileMtimeMs: 1 })])
  check('a weaker import is dropped, not stored', weaker === 0, `${weaker} written`)
  check('...so the fuller copy is still the one that counts', merged()?.days.get(day)?.get('p|m')?.input === 4000, String(merged()?.days.get(day)?.get('p|m')?.input))

  // A local fold over a day the *imported* copy covers is stored beside it, under its own source:
  // the two are not competitors, and the resolver prefers whichever is fuller.
  const local = store.put(recordOf('s1', [[day, [['p|m', bucket('p', 'm', 11)]]]], { fileSize: 100, fileMtimeMs: 1, seq: 2 }), { at: 1 })
  check('a local fold does not outrank a fuller imported copy', local?.days.get(day)?.get('p|m')?.input === 4000, String(local?.days.get(day)?.get('p|m')?.input))
  check('...and the imported row is still stored', copies().some((row) => row.source === 'device-b' && row.date === day), JSON.stringify(copies().map((row) => `${row.date}:${row.source}`)))
  check('...while the local row keeps its own copy of the day', copies().some((row) => row.source === 'local' && row.date === day), JSON.stringify(copies().map((row) => `${row.date}:${row.source}`)))

  // A local fold stops covering a day the current log no longer has — but that day only exists in
  // the *imported* rows here. Deleting it would be the original bug: a machine whose log was pruned
  // erasing the history another machine contributed.
  store.put(recordOf('s1', [[other, [['p|m', bucket('p', 'm', 9)]]]], { fileSize: 300, fileMtimeMs: 2, seq: 40 }), { at: 2 })
  check('a local fold leaves the imported day alone', copies().some((row) => row.source === 'device-b' && row.date === day), JSON.stringify(copies().map((row) => `${row.date}:${row.source}`)))
  check('...while its own rows track the log it can see', copies().some((row) => row.source === 'local' && row.date === other), JSON.stringify(copies().map((row) => `${row.date}:${row.source}`)))

  // Re-importing the same rows is a no-op: a sync that runs twice must not grow the store, and an
  // equal-stamp copy is the same bytes by definition.
  const again = store.intakeRows([incoming(day, 4000, { seq: 30, fileSize: 5000, fileMtimeMs: 50 })])
  check('re-importing identical rows writes nothing', again === 0, `${again} written`)
  check('...and the store still holds exactly the same rows', copies().length === 3, `${copies().length} row(s)`)
  store.close()
}

await finish()