/**
 * Host-half verification for the sync system: the lock, `sync.json`, and the four routes.
 *
 * The engine itself is covered by `sync-engine.verify.mjs` and the format by `sync.verify.mjs`. This
 * suite is about the wiring a user actually touches: that mounting the plugin creates nothing, that the
 * panel can configure sync without the plaintext ever landing on disk, that a wrong address fails with
 * a sentence instead of an exception, and that a real run against a real (fake) server publishes and
 * pulls through the routes.
 *
 * Usage:
 *   node test/host-sync.verify.mjs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { readLock } from '../lib/sync.js'
import { startFakeWebDav } from './webdav-server.mjs'
import { createChecker, makeHome, mount, writeSession, DATA_DIR } from './helpers.mjs'

const { check, finish } = createChecker('HOST SYNC VERIFY')

// No exit sync here: most fixtures in this suite have sync switched on, and the point of each one is a
// route or a lock, not the shutdown path. `test/sync-triggers.verify.mjs` is where the exit sync is tested,
// with its own budget. (A zero budget is the documented "there is no time for this" switch.)
process.env.DSH_USAGE_BADGE_EXIT_SYNC_MS = '0'

const home = makeHome('host-sync')
const dataDir = join(home, DATA_DIR)
const server = await startFakeWebDav()
const md5 = (text) => createHash('md5').update(text).digest('hex')
const ha1 = md5('alice:WebDAV:secret1234')
const first = await mount(home, 'host-sync-1')
const call = first.call

try {
  // ── 1. mounting must not create anything ─────────────────────────────────
  check('mounting the plugin writes no sync state at all', !existsSync(join(dataDir, 'sync.json')) && !existsSync(join(dataDir, 'host.lock')), 'something was created at mount time')

  const initial = await call('GET', '/usage-badge/sync')
  check('reading the sync status answers with defaults', initial.status === 200 && initial.body.config.url === '' && initial.body.last.result === 'never', JSON.stringify(initial.body?.config))
  check('...and says nothing is configured yet', initial.body.config.hasCredential === false, JSON.stringify({ hasCredential: initial.body.config.hasCredential }))
  // **Looking is not deciding.** Reading the status must not take the lock or write `sync.json`: someone who
  // opened the tab to see what it says has not asked to sync, and "it wrote a file because I looked at it" is
  // exactly the surprise this avoids. The lock is claimed by the first action that decides something.
  check(
    '...and reading it creates nothing at all',
    !existsSync(join(dataDir, 'sync.json')) && !existsSync(join(dataDir, 'host.lock')) && !existsSync(join(dataDir, 'pricing.json')),
    JSON.stringify({ sync: existsSync(join(dataDir, 'sync.json')), lock: existsSync(join(dataDir, 'host.lock')) }),
  )
  check('...while still reporting itself as free to write', initial.body.writable === true && initial.body.lock === null, JSON.stringify({ writable: initial.body.writable, lock: initial.body.lock }))
  // The first thing that decides anything is what creates the state — and from then on the lock is ours.
  const claimed = await call('POST', '/usage-badge/sync', { deviceLabel: 'first-look' })
  check('...and the first save is what creates it', claimed.status === 200 && existsSync(join(dataDir, 'sync.json')) && existsSync(join(dataDir, 'host.lock')), JSON.stringify({ sync: existsSync(join(dataDir, 'sync.json')), lock: existsSync(join(dataDir, 'host.lock')) }))
  check('...with the lock naming this process', readLock(dataDir)?.pid === process.pid, JSON.stringify(readLock(dataDir)))

  // ── 2. the credential is hashed here, not stored in plaintext ────────────
  const saved = await call('POST', '/usage-badge/sync', {
    enabled: true,
    url: server.url,
    username: 'alice',
    password: 'secret1234',
    realm: 'WebDAV',
    deviceLabel: 'desk',
    windowYears: 3,
  })
  check('saving the configuration succeeds', saved.status === 200 && saved.body.ok === true, JSON.stringify(saved.body))
  // Saving is the moment the plugin starts caring about this data directory, so that is when it claims
  // ownership — the lock says "this process may write", and from here on it is the writer.
  check(
    '...and claims the data directory for this process',
    existsSync(join(dataDir, 'sync.json')) && existsSync(join(dataDir, 'host.lock')) && readLock(dataDir)?.pid === process.pid,
    JSON.stringify(readLock(dataDir)),
  )
  const onDisk = readFileSync(join(dataDir, 'sync.json'), 'utf8')
  check('...with the digest HA1 exactly as the server keeps it', JSON.parse(onDisk).ha1 === ha1, 'the stored credential is not the expected HA1')
  check('...and never the plaintext password', !onDisk.includes('secret1234'), 'the plaintext password is on disk')
  check('...and the response hands back only a prefix', saved.body.config.hasCredential === true && /^[0-9a-f]{6}…$/.test(saved.body.config.credentialPrefix), JSON.stringify(saved.body.config.credentialPrefix))
  check('...with no field carrying the credential itself', !JSON.stringify(saved.body).includes(ha1), 'the response carries the credential')

  // A field the panel did not send must keep its value: a save is a patch, not a replacement.
  check('saving one field keeps the others', saved.body.config.username === 'alice' && saved.body.config.windowYears === 3 && saved.body.config.deviceLabel === 'desk', JSON.stringify(saved.body.config))
  const deviceId = saved.body.config.deviceId
  const renamed = await call('POST', '/usage-badge/sync', { deviceLabel: 'renamed' })
  check('a patch keeps the device identity', renamed.body.config.deviceId === deviceId && renamed.body.config.deviceLabel === 'renamed', JSON.stringify({ deviceId: renamed.body.config.deviceId, expected: deviceId }))

  const badUrl = await call('POST', '/usage-badge/sync', { url: 'not a url' })
  check('a URL that is not a URL is refused with a reason', badUrl.status === 400 && /not a URL/.test(String(badUrl.body.error)), JSON.stringify(badUrl.body))
  // A collection needs its trailing slash. The browser half **refuses** to build a client without one (a
  // WebDAV server answers a slash-less directory with a 301, and chasing it turns a mistyped address into
  // what looks like a wrong password), so the save route must not accept what the client refuses — a panel
  // storing a URL it can never use reports a lie in its own address field.
  {
    const stored = () => JSON.parse(readFileSync(join(dataDir, 'sync.json'), 'utf8')).url
    const noSlash = await call('POST', '/usage-badge/sync', { url: 'http://nas:19347' })
    check('a URL without its trailing slash is normalised, not stored as typed', noSlash.status === 200 && noSlash.body.config.url === 'http://nas:19347/', JSON.stringify(noSlash.body.config.url))
    check('...and the file agrees', stored() === 'http://nas:19347/', stored())
    const deeper = await call('POST', '/usage-badge/sync', { url: 'https://nas.example/dav' })
    check('...including a path below the root', deeper.body.config.url === 'https://nas.example/dav/', JSON.stringify(deeper.body.config.url))
    const already = await call('POST', '/usage-badge/sync', { url: 'http://nas:19347/dav/' })
    check('...and an address that already ends in one is left alone', already.body.config.url === 'http://nas:19347/dav/', JSON.stringify(already.body.config.url))
    // The two shapes that used to be accepted and then fail in the field: a missing host (WHATWG reads the
    // next segment as the host, pointing the sync at another machine) and an encoded slash (a 404 on this
    // server family, after which the field would have shown a URL nobody meant).
    const noHost = await call('POST', '/usage-badge/sync', { url: 'http:///dav' })
    check('...an address with no host is refused with a reason', noHost.status === 400 && /no host/.test(String(noHost.body.error)), JSON.stringify(noHost.body))
    const encodedSlash = await call('POST', '/usage-badge/sync', { url: 'http://nas:19347/dav%2f' })
    check('...and one with an encoded slash is refused by name', encodedSlash.status === 400 && /%2f/.test(String(encodedSlash.body.error)), JSON.stringify(encodedSlash.body))
  }
  const badDevice = await call('POST', '/usage-badge/sync', { deviceId: 'a/b' })
  check('a device id with a slash is refused', badDevice.status === 400, JSON.stringify(badDevice.body))

  // A body that is not JSON is the caller's mistake, not the host's: a 500 for it sends whoever is debugging
  // it looking at the wrong process. (The helper sends a string payload verbatim for exactly this.)
  const malformed = await call('POST', '/usage-badge/sync', '{not json')
  check('a malformed body is answered 400, not 500', malformed.status === 400 && /not JSON/.test(String(malformed.body.error)), `${malformed.status} ${JSON.stringify(malformed.body).slice(0, 90)}`)

  // ── 2b. a password saves without the panel having to know the realm ──────
  //
  // The realm is part of the digest input, but it is not a field the panel offers — someone filling in an
  // address, a username and a password has no way to know it. So it defaults, and the connection test
  // replaces the guess with whatever the server actually announced. This exact case used to fail with
  // "a username and a realm are needed to hash a password", which named a term the UI never showed.
  {
    const realmHome = makeHome('host-sync-realm')
    const scene = await mount(realmHome, 'host-sync-realm-1')
    const storedHa1 = () => JSON.parse(readFileSync(join(realmHome, DATA_DIR, 'sync.json'), 'utf8')).ha1
    const first = await scene.call('POST', '/usage-badge/sync', { enabled: true, url: 'http://nas:19347/', username: 'alice', password: 'secret1234' })
    check('a password saves even though the panel never asked for a realm', first.status === 200 && first.body.config.hasCredential === true, JSON.stringify(first.body.error ?? first.body.config))
    check('...hashed against the conventional realm', first.body.config.realm === 'WebDAV' && storedHa1() === md5('alice:WebDAV:secret1234'), JSON.stringify(first.body.config.realm))
    const noUser = await scene.call('POST', '/usage-badge/sync', { username: '', password: 'secret1234' })
    check('...while a password with no username is still refused, naming what is missing', noUser.status === 400 && /username/.test(String(noUser.body.error)), JSON.stringify(noUser.body))
    const announced = await scene.call('POST', '/usage-badge/sync', { username: 'bob', realm: 'Our Files', password: 'hunter2' })
    check('...and a realm the server did announce is the one used', announced.body.config.realm === 'Our Files' && storedHa1() === md5('bob:Our Files:hunter2'), JSON.stringify(announced.body.config.realm))
  }

  // ── 3. a connection test that fails says so, and does not throw ──────────
  const unreachable = await call('POST', '/usage-badge/sync', { url: 'http://127.0.0.1:9/' })
  check('an unreachable address saves without error', unreachable.status === 200, JSON.stringify(unreachable.body))
  const failedTest = await call('POST', '/usage-badge/sync/test')
  check('testing an unreachable server answers with a failure, not an exception', failedTest.status === 200 && failedTest.body.ok === false && typeof failedTest.body.error === 'string', JSON.stringify(failedTest.body))

  // Point it back at the real (fake) server and the check must pass, reporting the realm.
  await call('POST', '/usage-badge/sync', { url: server.url, username: 'alice', password: 'secret1234', realm: 'WebDAV', enabled: true })
  const okTest = await call('POST', '/usage-badge/sync/test')
  check('testing a reachable server reports the realm and its devices', okTest.body.ok === true && okTest.body.realm === 'WebDAV', JSON.stringify(okTest.body))
  check('...without creating the remote directory', !server.state.collections.has('/usage-badge/'), [...server.state.collections].join(','))

  // ── 4. a run through the route publishes, and the status reports it ──────
  const run = await call('POST', '/usage-badge/sync/run')
  check('a run through the route reports its outcome', run.status === 200 && run.body.result === 'ok', JSON.stringify(run.body))
  check('...holding the lock for this process, as a writer should', existsSync(join(dataDir, 'host.lock')), 'no lock was held after a run')
  check('...and creating its device directory on the server', server.state.files.has(`/usage-badge/${deviceId}/index.json`), [...server.state.files.keys()].filter((path) => path.includes('usage-badge/')).join(','))

  const after = await call('GET', '/usage-badge/sync')
  check('the status now describes the run', after.body.last.result === 'ok' && /pushed/.test(after.body.last.message), JSON.stringify(after.body.last))
  check('...and reports this process as the writer', after.body.lock === null && after.body.writable === true, JSON.stringify({ lock: after.body.lock, writable: after.body.writable }))
  // This home has no session logs, so the store holds nothing to publish and the count is legitimately
  // zero. What the check pins is that the field is a map of months (what the panel lists), not that it
  // is non-empty — the publish path with real rows is covered end to end by `sync.live.mjs`.
  check('...reporting its published months as a map', after.body.published !== null && typeof after.body.published === 'object', JSON.stringify(after.body.published))
  check('...with the configuration still intact', after.body.config.url === server.url && after.body.config.enabled === true, JSON.stringify(after.body.config))

  // ── 5. a second instance on the same home is refused, not broken ─────────
  //
  // This is the case the owner lock exists for: two processes sharing a `deviceId` would each believe
  // the same remote shard is theirs to overwrite. The second one is not an error state — it reports why
  // and declines to sync, while still reading the same history and the same configuration.
  const second = await mount(home, 'host-sync-2')
  const lockedStatus = await second.call('GET', '/usage-badge/sync')
  check('a second instance reads the same configured status', lockedStatus.body.config.url === server.url, JSON.stringify(lockedStatus.body.config.url))
  check('...reports the lock and who holds it', lockedStatus.body.lock !== null && /pid \d+/.test(String(lockedStatus.body.lock?.reason)), JSON.stringify(lockedStatus.body.lock))
  check('...is not a writer', lockedStatus.body.writable === false, JSON.stringify({ writable: lockedStatus.body.writable }))
  const refusedRun = await second.call('POST', '/usage-badge/sync/run')
  check('...and is refused a sync rather than writing anyway', refusedRun.body.result === 'locked', JSON.stringify(refusedRun.body))
  check('...leaving the first instance’s lock alone', existsSync(join(dataDir, 'host.lock')), 'the refuser removed the holder’s lock')
} finally {
  await server.close()
}

// ── 6. what the panel actually does: address, username, password, 立即同步 ────
//
// The suite above proves each route in isolation. This is the whole path a person takes on a fresh
// install, with nothing but those three fields — no realm anywhere, because the panel has no field for
// one — and it has to end with a working sync. It is the exact case that failed before the default.
{
  const panelHome = makeHome('host-sync-panel')
  const panelServer = await startFakeWebDav()
  // The startup sync would otherwise fire after this block and reach a closed port.
  process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS = '600000'
  try {
    const { call: panel } = await mount(panelHome, 'host-sync-panel-1')
    const save = await panel('POST', '/usage-badge/sync', {
      enabled: true,
      url: panelServer.url,
      username: 'alice',
      password: 'secret1234',
      allowInsecureTls: false,
      windowYears: 5,
    })
    check('the panel’s fields alone save a usable credential', save.status === 200 && save.body.config.hasCredential === true, JSON.stringify(save.body.error ?? save.body.config))

    const test = await panel('POST', '/usage-badge/sync/test')
    check('...the connection test then succeeds against the real handshake', test.body.ok === true && test.body.realm === 'WebDAV', JSON.stringify(test.body))

    const run = await panel('POST', '/usage-badge/sync/run')
    check('...and 立即同步 really syncs', run.body.result === 'ok', JSON.stringify(run.body))
    check('...against the realm that was assumed', panelServer.state.files.has(`/usage-badge/${save.body.config.deviceId}/index.json`), [...panelServer.state.files.keys()].join(','))
  } finally {
    delete process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS
    await panelServer.close()
  }
}

// ── 7. the status never carries a credential, whatever sync.json holds ───────
//
// The panel's answer is rebuilt field by field. A spread plus a `ha1` blacklist would forward anything
// else the file happens to contain — and an older build of this plugin wrote exactly such a field,
// `password`, in plaintext. So the check writes both shapes into sync.json and reads them back.
{
  const leakHome = makeHome('host-sync-leak')
  const leakDir = join(leakHome, DATA_DIR)
  mkdirSync(leakDir, { recursive: true })
  writeFileSync(
    join(leakDir, 'sync.json'),
    JSON.stringify({
      enabled: true,
      url: 'http://nas:19347/',
      username: 'alice',
      ha1: 'a'.repeat(32),
      password: 'plaintext-from-an-older-build',
      passwordHash: 'b'.repeat(32),
      deviceId: 'desk',
      state: { held: {}, published: {} },
    }),
  )
  // The startup sync must not fire into a closed port while this block runs.
  process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS = '600000'
  try {
    const { call: leakCall } = await mount(leakHome, 'host-sync-leak-1')
    const status = await leakCall('GET', '/usage-badge/sync')
    const serialised = JSON.stringify(status.body)
    check('the status does not carry a plaintext password from an older build', !serialised.includes('plaintext-from-an-older-build') && !('password' in status.body.config), JSON.stringify(Object.keys(status.body.config)))
    check('...nor the HA1, only that one exists', !serialised.includes('a'.repeat(32)) && status.body.config.hasCredential === true, status.body.config.credentialPrefix)
    check('...and the credential prefix is still just a prefix', /^[0-9a-f]{6}…$/.test(status.body.config.credentialPrefix), status.body.config.credentialPrefix)
    // A six-character slice of a short value **is** the whole value. A hand-edited or truncated `ha1` must
    // not be shown by a field whose entire purpose is to show only part of one. (A home of its own: the
    // running system holds its configuration in memory, so editing this one's file would not be re-read.)
    const shortHome = makeHome('host-sync-short')
    const shortDir = join(shortHome, DATA_DIR)
    mkdirSync(shortDir, { recursive: true })
    writeFileSync(join(shortDir, 'sync.json'), JSON.stringify({ enabled: true, url: 'http://nas/', username: 'alice', ha1: 'abc123', deviceId: 'desk' }))
    const { call: shortCall } = await mount(shortHome, 'host-sync-short-1')
    const shortStatus = await shortCall('GET', '/usage-badge/sync')
    check('...while a short credential is shown as nothing at all', shortStatus.body.config.credentialPrefix === '' && shortStatus.body.config.hasCredential === true, JSON.stringify(shortStatus.body.config.credentialPrefix))

    // `password` / `passwordHash` are fields an older build could leave behind, and `connect()` can use
    // neither. Claiming a credential exists enables 立即同步 and then fails the moment it is pressed.
    const legacyHome = makeHome('host-sync-legacy')
    const legacyDir = join(legacyHome, DATA_DIR)
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'sync.json'), JSON.stringify({ enabled: true, url: 'http://nas/', username: 'alice', password: 'plaintext', deviceId: 'desk' }))
    const { call: legacyCall } = await mount(legacyHome, 'host-sync-legacy-1')
    const legacyStatus = await legacyCall('GET', '/usage-badge/sync')
    check('...and a credential field this build cannot use is not reported as one', legacyStatus.body.config.hasCredential === false, JSON.stringify(legacyStatus.body.config.hasCredential))
  } finally {
    delete process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS
  }
}

// ── 8. the panel remembers the last run across a restart ────────────────────
//
// `last` is persisted state. A host that answered "从未" after every restart would be telling the user
// their sync had never worked when it had, and that is the one line they look at first.
{
  const revisitHome = makeHome('host-sync-revisit')
  const revisitDir = join(revisitHome, DATA_DIR)
  mkdirSync(revisitDir, { recursive: true })
  writeFileSync(
    join(revisitDir, 'sync.json'),
    JSON.stringify({
      enabled: true,
      url: 'http://nas:19347/',
      username: 'alice',
      ha1: 'c'.repeat(32),
      realm: 'WebDAV',
      deviceId: 'desk',
      instanceId: 'host-sync-revisit',
      windowYears: 5,
      state: { lastSyncAt: 1_700_000_000_000, lastResult: 'ok', message: 'pulled 2 shard(s) / 12 row(s)', held: {}, published: {} },
    }),
  )
  process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS = '600000'
  try {
    const { call: revisit } = await mount(revisitHome, 'host-sync-revisit-1')
    const status = await revisit('GET', '/usage-badge/sync')
    check('a restart still knows when the last sync happened', status.body.last.at === 1_700_000_000_000 && status.body.last.result === 'ok', JSON.stringify(status.body.last))
    check('...and what it said', status.body.last.message === 'pulled 2 shard(s) / 12 row(s)', status.body.last.message)
  } finally {
    delete process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS
  }
}

// ── 9. unloading hands the lock back ───────────────────────────────────────
//
// Not releasing it leaves `host.lock` naming a process that is still very much alive — this one — and the
// next mount in the same process is then refused by the plugin's own lock. A hot reload, or a test
// mounting the same home twice, is exactly that case.
{
  const unloadHome = makeHome('host-sync-unload')
  const unloadDir = join(unloadHome, DATA_DIR)
  mkdirSync(unloadDir, { recursive: true })
  // Sync off, so nothing in the background runs: this case is about the lock and nothing else.
  writeFileSync(join(unloadDir, 'sync.json'), JSON.stringify({ enabled: false, deviceId: 'desk', instanceId: 'host-sync-unload' }))
  process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS = '600000'
  try {
    const { call: unloadCall, settle, dispose } = await mount(unloadHome, 'host-sync-unload-1')
    // A save is the action that claims the directory — reading the status deliberately does not.
    await unloadCall('POST', '/usage-badge/sync', { deviceLabel: 'unload-check' })
    check('a live host holds the lock', existsSync(join(unloadDir, 'host.lock')) && readLock(unloadDir)?.pid === process.pid, JSON.stringify(readLock(unloadDir)))
    await settle()
    await dispose()
    check('unloading releases it', !existsSync(join(unloadDir, 'host.lock')), JSON.stringify(readLock(unloadDir)))

    const { call: second } = await mount(unloadHome, 'host-sync-unload-2')
    const after = await second('GET', '/usage-badge/sync')
    check('...so the same data directory can be claimed again', after.body.writable === true && after.body.lock === null, JSON.stringify({ writable: after.body.writable, lock: after.body.lock }))
  } finally {
    delete process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS
  }
}

// ── 10. a server that does not use the default realm ────────────────────────
//
// The panel has no realm field, so the password is hashed against `WebDAV` unless something tells it
// otherwise. On a server with a different realm that guess is wrong and **nothing** works — so the failed
// connection check has to hand back the realm the server announced, or the user has no way to find out what
// the right one is.
{
  const otherServer = await startFakeWebDav({ realm: 'Our Files' })
  const realmHome = makeHome('host-sync-other-realm')
  const realmDir = join(realmHome, DATA_DIR)
  mkdirSync(realmDir, { recursive: true })
  writeFileSync(join(realmDir, 'sync.json'), JSON.stringify({ enabled: true, url: otherServer.url, username: 'alice', ha1: md5('alice:WebDAV:secret1234'), realm: 'WebDAV', deviceId: 'desk', instanceId: 'host-sync-other-realm' }))
  process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS = '600000'
  try {
    const { call: realmCall } = await mount(realmHome, 'host-sync-other-realm-1')
    const failed = await realmCall('POST', '/usage-badge/sync/test')
    check('a check against a different realm fails', failed.body.ok === false, JSON.stringify(failed.body).slice(0, 90))
    check('...and reports the realm the server announced', failed.body.realm === 'Our Files', JSON.stringify(failed.body.realm))
    // With that realm the same password works — which is what the panel's hint tells the user to do.
    const fixed = await realmCall('POST', '/usage-badge/sync', { realm: 'Our Files', password: 'secret1234' })
    const ok = await realmCall('POST', '/usage-badge/sync/test')
    check('...and re-entering the password against it succeeds', fixed.status === 200 && ok.body.ok === true, JSON.stringify({ fixed: fixed.status, ok: ok.body.ok, error: ok.body.error }))
  } finally {
    delete process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS
    await otherServer.close()
  }
}

// ── 11. a pull lands in the panel without a restart (both cache backends) ────
//
// The sync writes rows straight into the cache. The fold is driven by log cursors, and a row that came
// from another device has no log here to move one — so unless the host reloads its aggregate after the
// run, the badge and the charts keep the numbers they had until the process restarts, while the sync
// page (which reads `sync.json`) cheerfully reports "pulled 1 shard". Both directions are asserted below:
// an imported month starts counting, and a month another device withdraws stops.
//
// **Both backends, in a loop.** They import the same way but answer "this session is empty now" with
// different shapes (SQLite keeps the session row, the JSON document used to drop the entry), and the
// reload *merges* what the store returns instead of replacing its world with it — so the withdrawal half
// passed on SQLite and silently failed on the JSON fallback. One backend is not the contract.
for (const kind of ['sqlite', 'json']) {
  const previousBackend = process.env.DSH_USAGE_BADGE_CACHE
  if (kind === 'json') process.env.DSH_USAGE_BADGE_CACHE = 'json'
  else delete process.env.DSH_USAGE_BADGE_CACHE
  const accumServer = await startFakeWebDav()
  const now = Date.now()
  const stamp = new Date(now)
  const day = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')}`
  const month = day.slice(0, 7)
  /** Each "machine" needs its own persisted identity: in one process they would otherwise share hostname+pid. */
  const seed = (home, instanceId) => {
    mkdirSync(join(home, DATA_DIR), { recursive: true })
    writeFileSync(join(home, DATA_DIR, 'sync.json'), JSON.stringify({ enabled: false, instanceId }))
  }
  const remoteHome = makeHome(`host-sync-accum-remote-${kind}`)
  seed(remoteHome, `host-sync-accum-remote-${kind}`)
  writeSession(remoteHome, 'session-on-remote', { provider: 'deepseek', model: 'deepseek-chat', time: now, input: 1111, output: 222 })
  const localHome = makeHome(`host-sync-accum-local-${kind}`)
  seed(localHome, `host-sync-accum-local-${kind}`)
  process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS = '600000'
  try {
    const remote = await mount(remoteHome, `host-sync-accum-remote-${kind}-1`)
    await remote.settle()
    await remote.call('POST', '/usage-badge/sync', { enabled: true, url: accumServer.url, username: 'alice', password: 'secret1234', deviceId: 'accum-remote' })
    const publish = await remote.call('POST', '/usage-badge/sync/run')
    check(`${kind}: the other machine publishes its month`, publish.body.result === 'ok' && publish.body.pushed === 1, JSON.stringify(publish.body).slice(0, 120))

    const local = await mount(localHome, `host-sync-accum-local-${kind}-1`)
    await local.settle()
    // The loop is only worth anything if the backend named here is the one in play: the host reads this
    // from the environment, and a mistake there would run SQLite twice and call it coverage. (`cacheKind`
    // rather than a file on disk: the JSON backend only writes its file once something changed.)
    const cacheKind = (await local.call('GET', '/usage-badge/config')).body.paths.cacheKind
    check(`${kind}: the host opened the cache backend this case is about`, cacheKind === kind, String(cacheKind))
    const before = (await local.call('GET', '/usage-badge/summary')).body
    check(`${kind}: a machine with no logs of its own starts empty`, before.today.input === 0 && before.days.length === 0, JSON.stringify({ input: before.today.input, days: before.days.length }))
    await local.call('POST', '/usage-badge/sync', { enabled: true, url: accumServer.url, username: 'alice', password: 'secret1234', deviceId: 'accum-local' })
    const pull = await local.call('POST', '/usage-badge/sync/run')
    check(`${kind}: the pull imports the row`, pull.body.result === 'ok' && pull.body.pulled === 1 && pull.body.rows === 1, JSON.stringify(pull.body).slice(0, 140))
    // **No remount anywhere in this block**: everything below is the same host process that did the pull.
    const after = (await local.call('GET', '/usage-badge/summary')).body
    check(`${kind}: the badge counts it without a restart`, after.today.input === 1111, JSON.stringify({ input: after.today.input, sessions: after.status.sessions }))
    check(`${kind}: the day is in the window the charts read`, after.days.some((row) => row.date === day && row.input === 1111), JSON.stringify(after.days.map((row) => `${row.date}:${row.input}`)))
    check(`${kind}: the year view agrees with it`, (await local.call('GET', `/usage-badge/year?year=${stamp.getFullYear()}`)).body.daily.some((row) => row.date === day && row.input === 1111), 'the year view does not show the imported day')

    // The other half of the same hole: a withdrawn month is **deleted** from the store, so a host that only
    // reloads on import would keep counting rows that are no longer there.
    const manifestPath = '/usage-badge/accum-remote/index.json'
    const manifest = JSON.parse(accumServer.state.files.get(manifestPath).toString('utf8'))
    const withdrawnSha = manifest.chunks[month]?.sha256 ?? ''
    delete manifest.chunks[month]
    manifest.retired = { ...(manifest.retired ?? {}), [month]: { at: Date.now(), sha256: withdrawnSha } }
    accumServer.state.files.set(manifestPath, Buffer.from(JSON.stringify(manifest)))
    const second = await local.call('POST', '/usage-badge/sync/run')
    const emptied = (await local.call('GET', '/usage-badge/summary')).body
    check(`${kind}: a month the other machine withdraws stops counting without a restart`, second.body.dropped === 1 && emptied.today.input === 0, JSON.stringify({ dropped: second.body.dropped, input: emptied.today.input }))
    check(`${kind}: ...leaving no day behind in the window`, emptied.days.length === 0, JSON.stringify(emptied.days.map((row) => row.date)))
  } finally {
    delete process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS
    await accumServer.close()
    if (previousBackend === undefined) delete process.env.DSH_USAGE_BADGE_CACHE
    else process.env.DSH_USAGE_BADGE_CACHE = previousBackend
  }
}

await finish()