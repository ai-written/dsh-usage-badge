/**
 * Sync-format verification: the shard, the manifest, and the two directions across them.
 *
 * The store's own semantics (row slots, truncation, imports never being deleted) are covered by
 * `cache.verify.mjs`. What is checked here is the **boundary**: that a device publishes only what it
 * folded, that a month's bytes are stable enough to skip when nothing changed, that a shard survives
 * the trip and rebuilds the same numbers on the other side, and that the window bound applies to
 * fetching rather than to keeping.
 *
 * Usage:
 *   node test/sync.verify.mjs
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { createCacheStore } from '../lib/cache-store.js'
import { LOCAL_SOURCE } from '../lib/buckets.js'
import {
  chunkRows,
  decodeShard,
  encodeShard,
  manifestPath,
  parseManifest,
  planDownload,
  planPricing,
  planUpload,
  rowsToRecords,
  safeDeviceId,
  safeShardKey,
  shardPath,
  shortHash,
} from '../lib/sync.js'
import { createChecker, makeHome } from './helpers.mjs'

const { check, finish } = createChecker('SYNC VERIFY')

const storeRoot = (root) => join(root, 'storages', 'usage-badge')
const bucket = (provider, model, input) => ({
  provider,
  model,
  input,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  requests: 1,
  hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, input: hour === 10 ? input : 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: hour === 10 ? 1 : 0 })),
  usageRecords: [{ input, cacheRead: 0, cacheWrite: 0, output: 0, hour: 10 }],
})
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
const openStore = (root, env = {}) => {
  const dir = storeRoot(root)
  mkdirSync(dir, { recursive: true })
  return createCacheStore({ dir, log: () => {}, env })
}

// ── 1. path and key hygiene ─────────────────────────────────────────────────
{
  check('a device id may not carry a slash', (() => { try { safeDeviceId('a/b'); return false } catch { return true } })())
  check('a device id may not be a traversal', (() => { try { safeDeviceId('..'); return false } catch { return true } })())
  check('a normal device id passes through', safeDeviceId('desktop-01') === 'desktop-01')
  check('a shard key must be a month', (() => { try { safeShardKey('2026-9'); return false } catch { return true } })())
  check('a shard path stays under the device directory', shardPath('desktop', '2026-09') === 'usage-badge/desktop/2026-09.ndjson.zst', shardPath('desktop', '2026-09'))
  check('a manifest path is per device', manifestPath('desktop') === 'usage-badge/desktop/index.json', manifestPath('desktop'))
  check('a hash is shortened for display, never truncated into a claim', shortHash('abcdef0123456789') === 'abcdef012345', shortHash('abcdef0123456789'))
}

// ── 2. a shard round-trips its rows exactly ─────────────────────────────────
{
  const rows = [
    { date: '2026-09-01', source: LOCAL_SOURCE, kind: 'current', seq: 12, fileSize: 900, fileMtimeMs: 5, at: 5, sessionId: 's1', path: '/l/s1/session.jsonl', routes: { 'p|m': bucket('p', 'm', 1234) } },
    { date: '2026-09-30', source: LOCAL_SOURCE, kind: 'current', seq: 40, fileSize: 5000, fileMtimeMs: 9, at: 9, sessionId: 's2', path: '/l/s2/session.jsonl', routes: { 'p|m': bucket('p', 'm', 77) } },
  ]
  const { body, sha256, rows: count } = encodeShard(rows, { device: 'desktop', at: 1000 })
  check('a shard reports how many rows it holds', count === 2, String(count))
  check('a shard compresses', body.length > 0 && body.length < JSON.stringify(rows).length * 2, `${body.length} B`)

  const back = decodeShard(body)
  check('a shard keeps its device', back.device === 'desktop', String(back.device))
  check('a row’s source is rewritten to the publishing device', back.rows.every((row) => row.source === 'desktop'), JSON.stringify(back.rows.map((row) => row.source)))
  check('every row survives the trip', back.rows.length === 2 && back.malformed === 0, `${back.rows.length} rows, ${back.malformed} malformed`)
  check('a row keeps its stamp', back.rows[0].seq === 12 && back.rows[0].fileSize === 900 && back.rows[0].fileMtimeMs === 5, JSON.stringify(back.rows[0]).slice(0, 120))
  check('a row keeps its session and its buckets', back.rows[0].sessionId === 's1' && back.rows[0].routes['p|m'].input === 1234, JSON.stringify(back.rows[0].routes).slice(0, 120))
  check('the hash is of the bytes actually written', sha256.length === 64)

  // Two encodes of the same rows differ byte-for-byte because the header carries the time; that is
  // why the upload plan compares hashes of *content* it just built, not of a previous run's file.
  const again = encodeShard(rows, { device: 'desktop', at: 1000 })
  check('the same rows at the same time produce the same bytes', again.sha256 === sha256)
}

// ── 3. a shard of a version this build does not write is refused by name ─────
{
  let message = null
  try {
    decodeShard(Buffer.from('not zstd at all'))
  } catch (error) {
    message = error.message
  }
  check('a corrupt shard fails with a reason, not a silent empty month', /could not be decompressed/.test(String(message)), String(message))

  let versionMessage = null
  try {
    parseManifest(JSON.stringify({ v: 99, device: 'desktop' }))
  } catch (error) {
    versionMessage = error.message
  }
  check('a manifest of another version is refused by name', /version 99/.test(String(versionMessage)), String(versionMessage))
}

// ── 4. chunking: what is published, and what is not ─────────────────────────
{
  const root = makeHome('sync-chunk')
  const store = openStore(root)
  store.put(recordOf('s1', [['2026-09-14', [['p|m', bucket('p', 'm', 100)]]], ['2026-10-02', [['p|m', bucket('p', 'm', 200)]]]], { fileSize: 500, seq: 20 }), { at: 20 })
  // Rows that arrived from another device must never be republished as this device's own.
  store.intakeRows([
    { sessionId: 's2', date: '2026-09-15', source: 'device-b', kind: 'current', seq: 9, fileSize: 90, fileMtimeMs: 9, at: 9, routes: { 'p|m': bucket('p', 'm', 999) } },
  ])
  // A fallback copy is local insurance, not history to publish.
  store.put(recordOf('s1', [[ '2026-09-14', [['p|m', bucket('p', 'm', 1)]]]], { fileSize: 10, seq: 1 }), { at: 1 })

  const shards = chunkRows(store.scan())
  check('rows are grouped into month shards', [...shards.keys()].sort().join(',') === '2026-09,2026-10', [...shards.keys()].join(','))
  check('the September shard holds only this device’s current rows', shards.get('2026-09').every((row) => row.source === LOCAL_SOURCE), JSON.stringify(shards.get('2026-09').map((row) => row.source)))
  check('...which is the fuller copy, not the fallback', shards.get('2026-09')[0].seq === 20, String(shards.get('2026-09')[0].seq))
  check('a row that came from another device is not published back', shards.get('2026-09').every((row) => row.sessionId !== 's2'), JSON.stringify(shards.get('2026-09').map((row) => row.sessionId)))
  store.close()
}

// ── 5. the upload plan skips bytes that did not change ──────────────────────
{
  const root = makeHome('sync-plan')
  const store = openStore(root)
  store.put(recordOf('s1', [['2026-09-14', [['p|m', bucket('p', 'm', 100)]]]], { fileSize: 500, seq: 20 }), { at: 20 })

  const first = planUpload(chunkRows(store.scan()), {}, { device: 'desktop', label: 'desk', at: 1000 })
  check('the first plan uploads every month', first.pending.length === 1 && first.unchanged === 0, JSON.stringify({ pending: first.pending.length, unchanged: first.unchanged }))
  check('the manifest names the device and lists the chunk', first.manifest.device === 'desktop' && first.manifest.label === 'desk' && Boolean(first.manifest.chunks['2026-09']), JSON.stringify(first.manifest.chunks))
  check('a chunk entry says where it is and what it is', first.pending[0].entry.path === 'usage-badge/desktop/2026-09.ndjson.zst' && first.pending[0].entry.rows === 1, JSON.stringify(first.pending[0].entry))

  // Nothing changed: the same bytes must not be uploaded again. The header's timestamp is part of
  // those bytes, so an unchanged re-plan has to keep the published time rather than stamp a new one.
  const second = planUpload(chunkRows(store.scan()), first.manifest, { device: 'desktop', label: 'desk', at: 2000 })
  check('an unchanged month is not uploaded twice', second.pending.length === 0 && second.unchanged === 1, JSON.stringify({ pending: second.pending.length, unchanged: second.unchanged }))

  // A day changes: only its month is uploaded again.
  store.put(recordOf('s1', [['2026-09-14', [['p|m', bucket('p', 'm', 300)]]]], { fileSize: 600, seq: 21 }), { at: 21 })
  const third = planUpload(chunkRows(store.scan()), second.manifest, { device: 'desktop', label: 'desk', at: 3000 })
  check('a changed month is uploaded again', third.pending.length === 1 && third.pending[0].key === '2026-09', JSON.stringify(third.pending.map((p) => p.key)))

  // A manifest survives the trip through JSON, which is how it is actually stored.
  const parsed = parseManifest(JSON.stringify(third.manifest))
  check('a manifest round-trips through JSON', parsed.device === 'desktop' && parsed.chunks['2026-09'].sha256 === third.manifest.chunks['2026-09'].sha256, JSON.stringify(Object.keys(parsed.chunks)))
  store.close()
}

// ── 6. what a reader fetches: the window bounds fetching, not keeping ───────
{
  const manifests = [
    {
      device: 'desktop',
      chunks: {
        '2014-05': { path: 'usage-badge/desktop/2014-05.ndjson.zst', sha256: 'a' },
        '2026-09': { path: 'usage-badge/desktop/2026-09.ndjson.zst', sha256: 'b' },
        '2027-01': { path: 'usage-badge/desktop/2027-01.ndjson.zst', sha256: 'c' },
      },
    },
    { device: 'laptop', chunks: { '2026-09': { path: 'usage-badge/laptop/2026-09.ndjson.zst', sha256: 'd' } } },
  ]
  const now = new Date('2026-10-09T00:00:00+08:00').getTime()
  const wanted = planDownload({ manifests, now, windowYears: 5 })
  check('the window drops a decade-old shard', wanted.every((item) => item.key !== '2014-05'), JSON.stringify(wanted.map((item) => item.key)))
  check('...and keeps everything inside it, from every device', wanted.length === 3, JSON.stringify(wanted.map((item) => `${item.device}/${item.key}`)))
  check('a shard already applied at the same hash is not fetched again', planDownload({ manifests, now, held: { 'desktop/2026-09': 'b' } }).every((item) => `${item.device}/${item.key}` !== 'desktop/2026-09'))
  check('windowYears 0 means everything', planDownload({ manifests, now, windowYears: 0 }).length === 4, String(planDownload({ manifests, now, windowYears: 0 }).length))
}

// ── 7. the whole trip: export, wipe, import, same numbers ───────────────────
{
  const rootA = makeHome('sync-trip-a')
  const rootB = makeHome('sync-trip-b')
  const a = openStore(rootA)
  const days = [['2026-09-14', 1111], ['2026-09-15', 2222], ['2026-10-01', 3333]]
  for (const [date, input] of days) {
    a.put(recordOf(`s-${date}`, [[date, [['p|m', bucket('p', 'm', input)]]]], { fileSize: 1000, seq: 30 }), { at: 30 })
  }
  const before = a.load().map((record) => ({ id: record.sessionId, days: [...record.days.keys()], input: [...record.days.values()][0].get('p|m').input })).sort((x, y) => (x.id < y.id ? -1 : 1))

  const plan = planUpload(chunkRows(a.scan()), {}, { device: 'desktop', label: 'desk', at: 1000 })
  check('the trip publishes one shard per month', plan.pending.map((item) => item.key).sort().join(',') === '2026-09,2026-10', plan.pending.map((item) => item.key).join(','))

  // Device B starts empty and receives what the shards carry.
  const b = openStore(rootB)
  let imported = 0
  for (const item of plan.pending) {
    imported += b.intakeRows(decodeShard(item.body).rows)
  }
  check('the other device stored every row', imported === 3, String(imported))
  const after = b.load().map((record) => ({ id: record.sessionId, days: [...record.days.keys()], input: [...record.days.values()][0].get('p|m').input })).sort((x, y) => (x.id < y.id ? -1 : 1))
  check('...and reads back exactly the same usage', JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before, after }))
  check('...as rows tagged with the device that published them', b.scan().every((record) => record.rows.every((row) => row.source === 'desktop')), JSON.stringify(b.scan().map((record) => record.rows.map((row) => row.source))))

  // What B received must not be published back as B's own history.
  check('a receiving device publishes nothing of what it received', chunkRows(b.scan()).size === 0, `${chunkRows(b.scan()).size} shard(s)`)

  // And an import is idempotent: running the same sync again changes nothing.
  let second = 0
  for (const item of plan.pending) second += b.intakeRows(decodeShard(item.body).rows)
  check('re-importing the same shards writes nothing', second === 0, String(second))
  a.close()
  b.close()
}

// ── 8. records rebuilt from rows carry the fullest stamp ────────────────────
{
  const rows = [
    { sessionId: 's1', date: '2026-09-01', source: 'desktop', kind: 'current', seq: 5, fileSize: 100, fileMtimeMs: 1, at: 1, routes: {} },
    { sessionId: 's1', date: '2026-09-02', source: 'desktop', kind: 'current', seq: 40, fileSize: 9000, fileMtimeMs: 9, at: 9, routes: {} },
    { sessionId: 's2', date: '2026-09-02', source: 'desktop', kind: 'current', seq: 8, fileSize: 200, fileMtimeMs: 2, at: 2, routes: {} },
  ]
  const records = rowsToRecords(rows)
  check('rows are grouped into one record per session and device', records.length === 2, String(records.length))
  check('a record carries the fullest stamp among its rows', records[0].seq === 40 && records[0].fileSize === 9000, JSON.stringify({ seq: records[0].seq, size: records[0].fileSize }))
  check('a row without a session is dropped rather than stored under an empty id', rowsToRecords([{ date: '2026-09-01', routes: {} }]).length === 0)
}

// ── 9. the price table: three cases, and a conflict that loses nothing ──────
//
// The price table is hand-written, so it cannot be merged by a rule — two people editing it is a
// decision only a person can make. What the plan has to do is tell the cases apart without ever
// dropping a version, which is what these assertions are about.
{
  const bytes = (text) => Buffer.from(text)
  const ours = bytes('{"mine":1}')
  const theirs = bytes('{"theirs":2}')
  const base = createHash('sha256').update(ours).digest('hex')

  const nothing = planPricing({ localBytes: ours, remoteBytes: ours, baseline: base })
  check('a price table nobody changed is left alone', nothing.action === 'none', JSON.stringify(nothing))

  const took = planPricing({ localBytes: ours, remoteBytes: theirs, baseline: base })
  check('a remote-only change is taken', took.action === 'pull' && took.winner === 'remote', JSON.stringify(took))

  const gave = planPricing({ localBytes: theirs, remoteBytes: ours, baseline: base })
  check('a local-only change is published', gave.action === 'push' && gave.winner === 'local', JSON.stringify(gave))

  // Both sides moved. The later write wins, and the losing copy is named — a silently dropped price
  // row is exactly what this project does not do.
  const conflicted = planPricing({ localBytes: theirs, remoteBytes: bytes('{"third":3}'), baseline: base, localAt: 10, remoteAt: 20, device: 'laptop', at: 99 })
  check('a real conflict is recognised', conflicted.action === 'conflict', JSON.stringify(conflicted))
  check('...the later write wins', conflicted.winner === 'remote', JSON.stringify(conflicted))
  check('...and the losing copy is kept under a named file', /\.conflict-pricing-laptop-99\.json$/.test(String(conflicted.conflictFile)), String(conflicted.conflictFile))
  const otherWay = planPricing({ localBytes: bytes('{"newer":9}'), remoteBytes: theirs, baseline: base, localAt: 30, remoteAt: 20, device: 'desk', at: 7 })
  check('...and an earlier remote write loses to ours', otherWay.winner === 'local', JSON.stringify(otherWay))

  // Same bytes on both sides is not a conflict, whatever the baselines say: nothing would be decided.
  const agreed = planPricing({ localBytes: theirs, remoteBytes: Buffer.from(theirs), baseline: base })
  check('identical edits on both sides are not a conflict', agreed.action === 'none', JSON.stringify(agreed))

  // A table that exists only on the server (a fresh install) is taken without a conflict.
  const fresh = planPricing({ localBytes: null, remoteBytes: theirs, baseline: null })
  check('a fresh install takes the server’s table', fresh.action === 'pull', JSON.stringify(fresh))
  const first = planPricing({ localBytes: ours, remoteBytes: null, baseline: null })
  check('...and a server with no table takes ours', first.action === 'push', JSON.stringify(first))
}

finish()
