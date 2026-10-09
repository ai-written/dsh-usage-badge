/**
 * End-to-end sync verification: two devices, one WebDAV server, and the local stores in between.
 *
 * The pieces are each covered elsewhere — the format by `sync.verify.mjs`, the row model by
 * `cache.verify.mjs`, the HTTP layer by `webdav.verify.mjs`. What is only visible here is the
 * **order of operations and what it leaves behind**: that a device publishes only its own months,
 * that the other device ends up counting both devices' usage exactly once, that a second run moves
 * nothing, that the lock keeps a second host out, and that a shard which fails to arrive is retried
 * rather than remembered as applied.
 *
 * The server is the fake from `webdav-server.mjs`, which verifies the digest response properly, so
 * the credential path (HA1 rather than plaintext) is exercised rather than stubbed.
 *
 * Usage:
 *   node test/sync-engine.verify.mjs
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { createCacheStore } from '../lib/cache-store.js'
import { LOCAL_SOURCE } from '../lib/buckets.js'
import { WebDavClient } from '../lib/webdav.js'
import { DEVICE_MARKER, SyncEngine, acquireLock, readLock, readSyncDocument, releaseLock } from '../lib/sync.js'
import { startFakeWebDav } from './webdav-server.mjs'
import { createChecker, makeHome } from './helpers.mjs'

const { check, finish } = createChecker('SYNC ENGINE VERIFY')

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
  fileSize: 1000,
  fileMtimeMs: 30,
  seq: 30,
  provider: 'p',
  model: 'm',
  days: new Map(days.map(([date, entries]) => [date, new Map(entries.map(([key, plain]) => [key, { ...plain }]))])),
  ...extra,
})
const openStore = (root) => {
  const dir = storeRoot(root)
  mkdirSync(dir, { recursive: true })
  return createCacheStore({ dir, log: () => {}, env: {} })
}
/** The total this device would report, over every record it can resolve. */
const totalInput = (store) => {
  let total = 0
  for (const record of store.load()) {
    for (const day of record.days.values()) {
      for (const b of day.values()) total += b.input
    }
  }
  return total
}
const seed = (store, date, input, sessionId = `s-${date}`) =>
  store.put(recordOf(sessionId, [[date, [['p|m', bucket('p', 'm', input)]]]]), { at: 30 })

const ha1 = (username, realm, password) => createHash('md5').update(`${username}:${realm}:${password}`).digest('hex')

const server = await startFakeWebDav()
const credential = {
  enabled: true,
  url: server.url,
  username: 'alice',
  ha1: ha1('alice', 'WebDAV', 'secret1234'),
  realm: 'WebDAV',
  windowYears: 5,
}
/** A client wired to the fake server, using the stored HA1 rather than a plaintext password. */
const client = () => new WebDavClient({ baseUrl: server.url, username: 'alice', passwordHash: credential.ha1 })

try {
  // ── 1. device A publishes what it folded ──────────────────────────────────
  const rootA = makeHome('engine-a')
  const a = openStore(rootA)
  seed(a, '2026-09-14', 1111)
  seed(a, '2026-09-15', 2222)
  seed(a, '2026-10-01', 3333)

  const engineA = new SyncEngine({ dataDir: storeRoot(rootA), store: a, client: client(), now: () => 1000, instanceId: 'instance-a' })
  engineA.save({ config: { ...credential, deviceId: 'desktop', deviceLabel: 'desk' } })
  const firstRun = await runAndRelease(engineA)
  check('the first run reports success', firstRun.result === 'ok', JSON.stringify(firstRun))
  check('...publishing one shard per month', firstRun.pushed === 2, String(firstRun.pushed))
  check('...with nothing to pull from an empty server', firstRun.pulled === 0, String(firstRun.pulled))
  check('the device directory holds its manifest and marker', server.state.collections.has('/usage-badge/desktop/') && server.state.files.has('/usage-badge/desktop/index.json') && server.state.files.has(`/usage-badge/desktop/${DEVICE_MARKER}`), [...server.state.collections].join(','))
  check('each shard landed under the device directory', server.state.files.has('/usage-badge/desktop/2026-09.ndjson.zst') && server.state.files.has('/usage-badge/desktop/2026-10.ndjson.zst'), [...server.state.files.keys()].filter((p) => p.includes('desktop')).join(','))
  check('no temporary upload name was left behind', [...server.state.files.keys()].every((path) => !path.includes('.upload-')), [...server.state.files.keys()].join(','))
  const manifestA = JSON.parse(server.state.files.get('/usage-badge/desktop/index.json').toString('utf8'))
  check('...and the manifest names both months with their bytes', Object.keys(manifestA.chunks).sort().join(',') === '2026-09,2026-10' && manifestA.chunks['2026-09'].bytes > 0, JSON.stringify(Object.keys(manifestA.chunks)))
  const afterFirst = server.state.requests.length

  // ── 2. a second run with nothing changed moves nothing ────────────────────
  const secondRun = await runAndRelease(engineA)
  check('a second run uploads nothing', secondRun.pushed === 0 && secondRun.pulled === 0, JSON.stringify({ pushed: secondRun.pushed, pulled: secondRun.pulled }))
  check('...and says so', /pushed 0 shard/.test(secondRun.message), secondRun.message)
  const writes = server.state.requests.slice(afterFirst).filter((entry) => entry.method === 'PUT' || entry.method === 'MOVE')
  check('...leaving the shards on the server untouched', writes.every((entry) => !entry.path.includes('.ndjson.zst')), JSON.stringify(writes.map((entry) => entry.path)))

  // ── 3. device B takes the history ─────────────────────────────────────────
  const rootB = makeHome('engine-b')
  const b = openStore(rootB)
  const engineB = new SyncEngine({ dataDir: storeRoot(rootB), store: b, client: client(), now: () => 2000, instanceId: 'instance-b' })
  engineB.save({ config: { ...credential, deviceId: 'laptop', deviceLabel: 'lap' } })
  const pullRun = await runAndRelease(engineB)
  check('the second device pulls both shards', pullRun.pulled === 2 && pullRun.pushed === 0, JSON.stringify({ pulled: pullRun.pulled, pushed: pullRun.pushed }))
  check('...and counts exactly the other device’s usage', totalInput(b) === 6666, String(totalInput(b)))
  check('...as rows attributed to the publishing device', b.scan().every((record) => record.rows.every((row) => row.source === 'desktop')), JSON.stringify(b.scan().map((record) => record.rows.map((row) => row.source))))
  // Only the marker and the manifest are written for a device with nothing of its own to publish.
  check('a device with nothing of its own still announces itself', server.state.files.has('/usage-badge/laptop/index.json'), [...server.state.files.keys()].filter((p) => p.includes('laptop')).join(','))

  // B folds its own day, then publishes: both devices end up sharing both histories.
  seed(b, '2026-10-02', 4444, 'b-only')
  const pushRun = await runAndRelease(engineB)
  check('the second device publishes its own month', pushRun.pushed === 1, String(pushRun.pushed))
  const laptopOwned = Object.keys(engineB.state.published ?? {}).sort().join(',')
  check('...and its manifest lists only that month', laptopOwned === '2026-10', laptopOwned)

  const aAgain = await runAndRelease(engineA)
  check('the first device pulls what the second published', aAgain.pulled === 1, JSON.stringify({ pulled: aAgain.pulled }))
  check('...so both devices now count the same total', totalInput(a) === totalInput(b) && totalInput(a) === 11110, `${totalInput(a)} vs ${totalInput(b)}`)

  // ── 4. two devices' rows for the same day are summed, not merged away ──────
  seed(a, '2026-10-02', 5555, 'a-same-day')
  await runAndRelease(engineA)
  await runAndRelease(engineB)
  check(
    'the same day from two devices adds up',
    totalInput(b) === 11110 + 5555,
    `${totalInput(b)} (expected ${11110 + 5555})`,
  )

  // ── 5. renaming this device does not count anything twice ──────────────────
  //
  // The device name is a *storage partition*, not a session identity: the merge key is the session id
  // derived from the log path. Renaming is a natural thing to do (and the panel invites it, because it
  // is how a reinstalled machine rejoins its own history), so the question "does this double my usage"
  // has to have a proven answer rather than a reasoned one.
  //
  // What happens on the rename itself is a one-time cost, and worth pinning down: this device re-reads
  // its own old shards under the **previous** name (they are no longer "its own manifest" to skip) and
  // republishes those months under the new name. The old directory stays on the server — a remote is
  // never deleted because of a local change.
  {
    // A server of its own: the one above already holds `desktop` and `laptop`, and a pull would bring
    // their history in too — which is correct behaviour, but not what this section is measuring.
    const renameServer = await startFakeWebDav()
    const renameClient = () => new WebDavClient({ baseUrl: renameServer.url, username: 'alice', passwordHash: credential.ha1 })
    const rootR = makeHome('engine-rename')
    const r = openStore(rootR)
    seed(r, '2026-12-01', 1234, 'r-1')
    seed(r, '2026-12-02', 8766, 'r-2')
    const engineR = new SyncEngine({ dataDir: storeRoot(rootR), store: r, client: renameClient(), now: () => 4000, instanceId: 'instance-r' })
    engineR.save({ config: { ...credential, url: renameServer.url, deviceId: 'before-name' } })
    const publishBefore = await runAndRelease(engineR)
    check('a device publishes under its first name', publishBefore.result === 'ok' && renameServer.state.files.has('/usage-badge/before-name/2026-12.ndjson.zst'), JSON.stringify({ pushed: publishBefore.pushed }))

    engineR.save({ config: { deviceId: 'after-name' } })
    const publishAfter = await runAndRelease(engineR)
    check('renaming publishes under the new name', renameServer.state.files.has('/usage-badge/after-name/2026-12.ndjson.zst'), [...renameServer.state.files.keys()].join(','))
    check('...leaving the old directory alone, as a remote always is', renameServer.state.files.has('/usage-badge/before-name/2026-12.ndjson.zst'), [...renameServer.state.files.keys()].join(','))
    check('...so the renamed device still counts its own history once', totalInput(r) === 10000, String(totalInput(r)))

    // The machine that has to be sure: nothing of its own, so it takes the server as it is — both names.
    const rootR2 = makeHome('engine-rename-reader')
    const r2 = openStore(rootR2)
    const reader = new SyncEngine({ dataDir: storeRoot(rootR2), store: r2, client: renameClient(), now: () => 5000, instanceId: 'instance-r2' })
    reader.save({ config: { ...credential, url: renameServer.url, deviceId: 'reader' } })
    const readerRun = await runAndRelease(reader)
    check('...and a third machine sees the total once, not twice', readerRun.result === 'ok' && totalInput(r2) === 10000, `${totalInput(r2)} (16666 would be double-counted)`)
    check('...holding a row from each name for the same session and day', r2.scan().length === 2 && r2.scan().every((record) => record.rows.length === 2 && new Set(record.rows.map((row) => row.source)).size === 2), JSON.stringify(r2.scan().map((record) => record.rows.map((row) => row.source))))
    // Resolution is what keeps that at one: the two rows are the same session on the same day, so the
    // store's read resolves them to a single day. The duplicates cost storage, never a number.
    const againR = await runAndRelease(reader)
    check('...and nothing moves on the next run', againR.pulled === 0 && againR.pushed === 0 && totalInput(r2) === 10000, JSON.stringify({ pulled: againR.pulled, pushed: againR.pushed, total: totalInput(r2) }))
    r.close()
    r2.close()
    await renameServer.close()
  }

  // ── 6. two installations sharing one device name are refused, not merged ───
  //
  // The device name is a directory name. Two machines choosing the same one do not combine their
  // histories — each uploads to `usage-badge/<name>/<month>`, so the second `PUT` replaces the first's
  // month and its rows are gone. Nothing in the bytes reveals that, so the check has to happen before
  // anything is written; the manifest carries the publishing installation's identity for exactly this.
  {
    const clashServer = await startFakeWebDav()
    const clashClient = () => new WebDavClient({ baseUrl: clashServer.url, username: 'alice', passwordHash: credential.ha1 })
    const home1 = makeHome('engine-clash-1')
    const home2 = makeHome('engine-clash-2')
    const s1 = openStore(home1)
    const s2 = openStore(home2)
    seed(s1, '2026-08-20', 400, 'c1')
    seed(s2, '2026-08-20', 700, 'c2')

    const first = new SyncEngine({ dataDir: storeRoot(home1), store: s1, client: clashClient(), now: () => 6000, instanceId: 'instance-one' })
    first.save({ config: { ...credential, url: clashServer.url, deviceId: 'team' } })
    const firstRun = await runAndRelease(first)
    check('the first installation publishes under the shared name', firstRun.result === 'ok' && clashServer.state.files.has('/usage-badge/team/2026-08.ndjson.zst'), JSON.stringify(firstRun))
    const shardBefore = clashServer.state.files.get('/usage-badge/team/2026-08.ndjson.zst')
    const manifestBefore = clashServer.state.files.get('/usage-badge/team/index.json').toString('utf8')

    const second = new SyncEngine({ dataDir: storeRoot(home2), store: s2, client: clashClient(), now: () => 7000, instanceId: 'instance-two' })
    second.save({ config: { ...credential, url: clashServer.url, deviceId: 'team' } })
    const clashRun = await runAndRelease(second)
    check('a second installation with the same name does not publish', clashRun.result === 'clash' && /being written by another installation/.test(clashRun.message), JSON.stringify({ result: clashRun.result, message: clashRun.message }))
    check('...its rows are not uploaded over the first one’s', clashServer.state.files.get('/usage-badge/team/2026-08.ndjson.zst').equals(shardBefore), 'the shard changed')
    check('...the manifest is left alone too', clashServer.state.files.get('/usage-badge/team/index.json').toString('utf8') === manifestBefore, 'the manifest changed')
    check('...and it says which installation owns the name', second.state.collision?.owner === 'instance-one' && second.state.collision?.device === 'team', JSON.stringify(second.state.collision))
    // The point of allowing the pull: a reinstalled machine gets its history back even while the name
    // question is unresolved. Refusing to pull would leave it with an empty panel until the user acted.
    check('...but it still gets the history back', totalInput(s2) === 1100, `${totalInput(s2)} (400 + 700)`)

    // The first installation is unaffected: its own shard is still its own, and it still counts its data.
    const firstAgain = await runAndRelease(first)
    check('...while the owner keeps working', firstAgain.result === 'ok' && firstAgain.pushed === 0, JSON.stringify({ result: firstAgain.result, pushed: firstAgain.pushed }))
    check('...and its collision note is not raised for it', !first.state.collision, JSON.stringify(first.state.collision))

    // The way out is a different name, which is exactly what the panel tells the user to do.
    second.save({ config: { deviceId: 'team-2' } })
    const renamed = await runAndRelease(second)
    check('renaming the second installation lets it publish', renamed.result === 'ok' && clashServer.state.files.has('/usage-badge/team-2/2026-08.ndjson.zst'), JSON.stringify({ result: renamed.result, message: renamed.message }))
    check('...clearing the collision note', !second.state.collision, JSON.stringify(second.state.collision))
    check('...and now both installations’ history is on the server', totalInput(s2) === 1100, `${totalInput(s2)} (400 + 700)`)
    // The original owner has to run once more to pick up the newcomer's shard — nothing is pushed to
    // it, the pull is what carries the other way.
    await runAndRelease(first)
    check('...which the first installation counts after its next run', totalInput(s1) === 1100, `${totalInput(s1)} (400 + 700)`)
    s1.close()
    s2.close()
    await clashServer.close()
  }

  // ── 7. another installation writing into this device's directory ───────────
  //
  // The owner field cannot catch this one: a directory copied to another machine carries `sync.json`
  // with it, `instanceId` included, so the copy passes every owner check and then MOVE-overwrites this
  // device's months. The bytes answer what identity cannot — a month we recorded at one hash and the
  // server now holds at another was written by something that was not us.
  {
    const copyServer = await startFakeWebDav()
    const copyClient = () => new WebDavClient({ baseUrl: copyServer.url, username: 'alice', passwordHash: credential.ha1 })
    const copyHome = makeHome('engine-copy')
    const copyStore = openStore(copyHome)
    seed(copyStore, '2026-05-05', 500, 'k1')
    const owner = new SyncEngine({ dataDir: storeRoot(copyHome), store: copyStore, client: copyClient(), now: () => 8000, instanceId: 'inst-copied' })
    owner.save({ config: { ...credential, url: copyServer.url, deviceId: 'desk' } })
    await runAndRelease(owner)
    const original = copyServer.state.files.get('/usage-badge/desk/2026-05.ndjson.zst')

    // Someone else's PUB of that month: different bytes **and a manifest that names them**. The manifest
    // is the part that matters — a shard that merely disagrees with its manifest is a half-finished
    // upload, and the next push repairs it by re-writing the correct bytes.
    const stranger = Buffer.from(original).reverse()
    copyServer.state.files.set('/usage-badge/desk/2026-05.ndjson.zst', stranger)
    const strangerManifest = JSON.parse(copyServer.state.files.get('/usage-badge/desk/index.json').toString('utf8'))
    strangerManifest.chunks['2026-05'] = { ...strangerManifest.chunks['2026-05'], sha256: createHash('sha256').update(stranger).digest('hex'), bytes: stranger.length }
    copyServer.state.files.set('/usage-badge/desk/index.json', Buffer.from(JSON.stringify(strangerManifest, null, 2)))
    const after = await runAndRelease(owner)
    check('a month rewritten by something else is noticed', after.result === 'clash' && owner.state.collision?.kind === 'diverged', JSON.stringify({ result: after.result, collision: owner.state.collision }))
    check('...and not written over when we have no change of our own', copyServer.state.files.get('/usage-badge/desk/2026-05.ndjson.zst').equals(stranger), 'we overwrote the stranger')
    check('...naming the month', owner.state.collision?.month === '2026-05', JSON.stringify(owner.state.collision))

    // A change of our own in a *different* month does not publish either, and that is the deliberate
    // choice: publishing needs a manifest, the manifest would have to name both the stranger's month and
    // ours, and a directory two writers are filling has no correct manifest. So the refusal is whole —
    // and it is loud, in the panel, until the user picks a different device name. Nothing is lost: the
    // local rows are still here and go up the moment the name is free.
    seed(copyStore, '2026-06-06', 600, 'k2')
    const resolved = await runAndRelease(owner)
    check('...and a change of ours in another month does not publish either', resolved.result === 'clash' && resolved.pushed === 0, JSON.stringify({ result: resolved.result, pushed: resolved.pushed }))
    check('...while our own rows are kept, not dropped', totalInput(copyStore) === 1100, String(totalInput(copyStore)))
    check('...and the month that disagrees is still not written over', copyServer.state.files.get('/usage-badge/desk/2026-05.ndjson.zst').equals(stranger), 'we overwrote the stranger')
    check('...with the refusal still on record', owner.state.collision?.month === '2026-05', JSON.stringify(owner.state.collision))

    // Freeing the name is the way out, and it must actually work: the same store, published under a name
    // nothing else is using, goes up in full.
    owner.save({ config: { deviceId: 'desk-2' } })
    const afterRename = await runAndRelease(owner)
    check('...and a free device name publishes the lot', afterRename.pushed === 2 && copyServer.state.files.has('/usage-badge/desk-2/2026-05.ndjson.zst') && copyServer.state.files.has('/usage-badge/desk-2/2026-06.ndjson.zst'), JSON.stringify({ result: afterRename.result, pushed: afterRename.pushed, message: afterRename.message }))
    copyStore.close()
    await copyServer.close()
  }

  // ── 8. a month this device no longer holds is withdrawn ────────────────────
  //
  // Rows disappear for a real reason — a session folder was deleted, or a newer log version that no
  // longer covers that day superseded them. Leaving the month in the manifest means the next device to
  // sync imports usage this machine no longer has: the numbers the user deleted come back.
  {
    const retireServer = await startFakeWebDav()
    const retireClient = () => new WebDavClient({ baseUrl: retireServer.url, username: 'alice', passwordHash: credential.ha1 })
    const retireHome = makeHome('engine-retire')
    const retireStore = openStore(retireHome)
    // One session carries a day in **each** month, so that dropping one of its days empties 2026-04
    // completely while the session — and therefore 2026-05 — stays. This is the shape of a real case: a
    // log version that no longer covers an old day.
    retireStore.put(recordOf('t-1', [['2026-04-10', [['p|m', bucket('p', 'm', 1111)]]], ['2026-05-02', [['p|m', bucket('p', 'm', 555)]]]]), { at: 30 })
    retireStore.put(recordOf('t-2', [['2026-04-11', [['p|m', bucket('p', 'm', 2222)]]]]), { at: 30 })
    const device = new SyncEngine({ dataDir: storeRoot(retireHome), store: retireStore, client: retireClient(), now: () => 9000, instanceId: 'inst-retire' })
    device.save({ config: { ...credential, url: retireServer.url, deviceId: 'desk' } })
    const published = await runAndRelease(device)
    check('both months are published first', published.pushed === 2 && retireServer.state.files.has('/usage-badge/desk/2026-04.ndjson.zst') && retireServer.state.files.has('/usage-badge/desk/2026-05.ndjson.zst'), JSON.stringify(published))

    // 2026-04 disappears from this device's rows entirely: t-1's day is gone and t-2 never had a row
    // there once it is re-folded without one.
    retireStore.put(recordOf('t-1', [['2026-05-02', [['p|m', bucket('p', 'm', 555)]]]]), { at: 30 })
    retireStore.put(recordOf('t-2', [['2026-06-01', [['p|m', bucket('p', 'm', 2222)]]]]), { at: 30 })
    const second = await runAndRelease(device)
    const remaining = JSON.parse(retireServer.state.files.get('/usage-badge/desk/index.json').toString('utf8')).chunks
    check('a month with no rows left is withdrawn', retireServer.state.files.has('/usage-badge/desk/2026-04.ndjson.zst') === false, [...retireServer.state.files.keys()].join(','))
    check('...the manifest no longer lists it', !remaining['2026-04'], JSON.stringify(Object.keys(remaining)))
    check('...and the run says so', /withdrew 1 month/.test(second.message), second.message)

    // A machine with nothing of its own must not be handed the withdrawn month.
    const readerHome = makeHome('engine-retire-reader')
    const readerStore = openStore(readerHome)
    const reader = new SyncEngine({ dataDir: storeRoot(readerHome), store: readerStore, client: retireClient(), now: () => 9500, instanceId: 'inst-reader' })
    reader.save({ config: { ...credential, url: retireServer.url, deviceId: 'reader' } })
    await runAndRelease(reader)
    check('...so a fresh device does not get the deleted usage back', totalInput(readerStore) === 555 + 2222, `${totalInput(readerStore)} (3333 would be 1111 revived)`)
    retireStore.close()
    readerStore.close()
    await retireServer.close()
  }

  // ── 9. a shard that fails to arrive is not remembered as applied ───────────
  seed(a, '2026-11-05', 777, 'a-november')
  await runAndRelease(engineA)
  const heldBefore = { ...engineB.state.held }
  // Hide the November shard: the manifest still lists it, so the reader must notice the miss.
  const novemberPath = '/usage-badge/desktop/2026-11.ndjson.zst'
  const novemberBytes = server.state.files.get(novemberPath)
  server.state.files.delete(novemberPath)
  const partialRun = await runAndRelease(engineB)
  check('a missing shard is reported, not silently skipped', partialRun.result === 'partial' && /failed/.test(partialRun.message), JSON.stringify({ result: partialRun.result, message: partialRun.message }))
  check('...and is not recorded as applied', !engineB.state.held['desktop/2026-11'], JSON.stringify(Object.keys(engineB.state.held).filter((key) => key.includes('2026-11'))))
  check('...while the shards that did arrive are still recorded', Object.keys(engineB.state.held).length >= Object.keys(heldBefore).length, String(Object.keys(engineB.state.held).length))
  server.state.files.set(novemberPath, novemberBytes)
  const recovered = await runAndRelease(engineB)
  check('the retry picks it up once the server has it again', recovered.result === 'ok' && totalInput(b) === 11110 + 5555 + 777, `${recovered.result} / ${totalInput(b)}`)

  // ── 6. the lock keeps a second host out of the same data directory ─────────
  const held = acquireLock(storeRoot(rootB), { instanceId: 'instance-b' })
  check('the first host takes the lock', held.acquired === true, JSON.stringify(held))
  check('...and the lock records its pid and instance', readLock(storeRoot(rootB))?.pid === process.pid && readLock(storeRoot(rootB))?.instanceId === 'instance-b', JSON.stringify(readLock(storeRoot(rootB))))
  const third = new SyncEngine({
    dataDir: storeRoot(rootB),
    store: b,
    client: client(),
    now: () => 3000,
    instanceId: 'instance-c',
    config: { ...credential, deviceId: 'laptop' },
  })
  const lockedRun = await runAndRelease(third)
  check('a second host is refused the lock instead of writing', lockedRun.result === 'locked', JSON.stringify({ result: lockedRun.result, message: lockedRun.message }))
  check('...and the refusal says who holds it', /pid \d+/.test(lockedRun.message), lockedRun.message)
  // The disabled run happens while the lock is still held, and passes its whole configuration in
  // rather than saving: a `save` here would overwrite the device identity this section is about to
  // check, because a config merged onto the file's is not the same as the file's.
  const disabled = new SyncEngine({ dataDir: storeRoot(rootB), store: b, client: client(), config: { ...credential, deviceId: 'laptop', enabled: false } })
  check('a disabled sync does nothing at all', (await runAndRelease(disabled)).result === 'skipped')
  releaseLock(storeRoot(rootB))
  check('releasing the lock lets the next host in', acquireLock(storeRoot(rootB), { instanceId: 'instance-c' }).acquired === true)
  releaseLock(storeRoot(rootB))

  // ── 7. the credential is stored as the server stores it, never plaintext ───
  const onDisk = readFileSync(join(storeRoot(rootB), 'sync.json'), 'utf8')
  check('sync.json holds the digest HA1', JSON.parse(onDisk).ha1 === credential.ha1, 'the credential is not the expected HA1')
  check('...and never the plaintext password', !onDisk.includes('secret1234'), 'the plaintext password is on disk')
  const reloaded = readSyncDocument(storeRoot(rootB))
  check('...so a restarted host can authenticate from the file alone', reloaded.ha1 === credential.ha1 && reloaded.deviceId === 'laptop', JSON.stringify({ deviceId: reloaded.deviceId, ha1: recorded(reloaded.ha1) }))
  check('a config write keeps the last run’s state', (reloaded.state?.lastResult ?? '') !== '', JSON.stringify(reloaded.state))

  // ── 8. the price table travels, and a conflict keeps what would have been lost ──
  //
  // The price table is hand-written, so it cannot be merged by a rule. What is asserted here is that
  // it travels, and that the case a rule *cannot* decide — both devices changed it — costs nobody a
  // version.
  writeFileSync(join(storeRoot(rootA), 'pricing.json'), JSON.stringify({ multiplier: 1, overrides: { 'a|m': { inputPerMillion: 1 } } }))
  const pricingPush = await runAndRelease(engineA)
  check('a price table nobody published yet is published', pricingPush.pricing === 'push', JSON.stringify({ pricing: pricingPush.pricing, message: pricingPush.message }))
  check('...as the shared file', server.state.files.has('/usage-badge/pricing.json'), [...server.state.files.keys()].filter((path) => path.includes('pricing')).join(','))
  check('...with this device’s own copy beside it', server.state.files.has('/usage-badge/desktop/pricing-desktop.json'), [...server.state.files.keys()].filter((path) => path.includes('pricing')).join(','))

  const pricingPull = await runAndRelease(engineB)
  check('the other device takes the shared table', pricingPull.pricing === 'pull', JSON.stringify({ pricing: pricingPull.pricing, message: pricingPull.message }))
  check('...and ends up with the same bytes', readFileSync(join(storeRoot(rootB), 'pricing.json'), 'utf8') === readFileSync(join(storeRoot(rootA), 'pricing.json'), 'utf8'))

  // Both sides now hold different tables: the server has A's, this device has its own. The engine has
  // to say so and keep both — which of the two counts as "later" is decided by the plan's own tests in
  // `sync.verify.mjs`, not by how fast this test happens to run.
  writeFileSync(join(storeRoot(rootA), 'pricing.json'), JSON.stringify({ multiplier: 2, editedBy: 'desktop' }))
  await runAndRelease(engineA)
  writeFileSync(join(storeRoot(rootB), 'pricing.json'), JSON.stringify({ multiplier: 5, editedBy: 'laptop' }))
  const conflicted = await runAndRelease(engineB)
  check('a conflicting edit is reported as a conflict', conflicted.pricing === 'conflict', JSON.stringify({ pricing: conflicted.pricing, message: conflicted.message }))

  const conflicts = readdirSync(storeRoot(rootB)).filter((name) => name.startsWith('.conflict-pricing-'))
  check('...and the copy that would have been lost is kept', conflicts.length === 1, conflicts.join(','))
  const remoteTable = JSON.parse(server.state.files.get('/usage-badge/pricing.json').toString('utf8'))
  const conflictTable = conflicts.length === 1 ? JSON.parse(readFileSync(join(storeRoot(rootB), conflicts[0]), 'utf8')) : {}
  const localTable = JSON.parse(readFileSync(join(storeRoot(rootB), 'pricing.json'), 'utf8'))
  // Whichever side won, **both** versions survive: the winner on the server, the loser in the conflict
  // file. That is the property this whole design exists for.
  check(
    '...so both versions survive the conflict',
    new Set([remoteTable.editedBy, conflictTable.editedBy]).size === 2 &&
      [remoteTable.editedBy, conflictTable.editedBy].includes('desktop') &&
      [remoteTable.editedBy, conflictTable.editedBy].includes('laptop'),
    JSON.stringify({ remote: remoteTable.editedBy, conflict: conflictTable.editedBy }),
  )
  check('...and the local hand-written table is still the person’s own', localTable.editedBy === 'laptop', JSON.stringify(localTable))

  a.close()
  b.close()
} finally {
  await server.close()
}

/** Run one sync and hand the lock back: a real host holds it for the process, a test cannot. */
async function runAndRelease(engine) {
  try {
    return await engine.run()
  } finally {
    engine.release()
  }
}

function recorded(hash) {
  return `${String(hash).slice(0, 8)}…`
}

finish()
