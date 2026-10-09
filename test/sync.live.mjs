/**
 * Live check against a real WebDAV server — the whole sync path, not just the client.
 *
 * `sync-engine.verify.mjs` runs the engine against a server this repository wrote, so it can only
 * prove the engine agrees with *that* server. This drives a real one end to end: publish a shard from
 * one store, then have a second, empty store pull it back and count it. The interesting failure it
 * catches is the one the offline server cannot — a `PROPFIND` listing shape, a `MOVE` that needs
 * `Overwrite: T`, a `MKCOL` that answers in a way the client did not expect.
 *
 * It runs entirely inside `usage-badge/` on the server and removes what it created. A run that fails
 * midway may leave that directory behind; the script says so, with the paths, rather than pretending
 * to have cleaned up.
 *
 * It needs the network, so it is not part of `npm test`.
 *
 * Usage (PowerShell):
 *   $env:DSH_USAGE_BADGE_WEBDAV_URL='http://nas:19347/'
 *   $env:DSH_USAGE_BADGE_WEBDAV_USER='alice'
 *   $env:DSH_USAGE_BADGE_WEBDAV_PASSWORD='…'
 *   node test/sync.live.mjs
 *
 * A missing URL or username skips the run (exit 0) rather than failing, so a CI job can include it
 * unconditionally.
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCacheStore } from '../lib/cache-store.js'
import { WebDavClient } from '../lib/webdav.js'
import { SyncEngine, readSyncDocument } from '../lib/sync.js'

const url = process.env.DSH_USAGE_BADGE_WEBDAV_URL
const username = process.env.DSH_USAGE_BADGE_WEBDAV_USER
const password = process.env.DSH_USAGE_BADGE_WEBDAV_PASSWORD

if (!url || !username || password === undefined) {
  console.log('SKIP: set DSH_USAGE_BADGE_WEBDAV_URL, DSH_USAGE_BADGE_WEBDAV_USER and DSH_USAGE_BADGE_WEBDAV_PASSWORD to run this check')
  process.exit(0)
}

const failures = []
const check = (label, condition, detail = '') => {
  if (condition) console.log(`ok    ${label}`)
  else {
    console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`)
    failures.push(label)
  }
}

/** The digest HA1, computed from the plaintext exactly as the container's entrypoint does. */
const digestHa1 = (user, realm, pass) => createHash('md5').update(`${user}:${realm}:${pass}`).digest('hex')

const realmProbe = new WebDavClient({ baseUrl: url, username, password, allowInsecureTls: true })
const options = await realmProbe.options()
const realm = options.realm ?? 'WebDAV'
const ha1 = digestHa1(username, realm, password)
const run = randomBytes(3).toString('hex')
const deviceA = `live-a-${run}`
const deviceB = `live-b-${run}`

console.log(`\n=== ${url}  (user ${username}, realm ${realm})`)
console.log(`  test devices: ${deviceA}, ${deviceB}`)

const homes = []
const makeHome = (name) => {
  const root = mkdtempSync(join(tmpdir(), `dsh-sync-live-${name}-`))
  const dir = join(root, 'usage-badge')
  mkdirSync(dir, { recursive: true })
  homes.push(root)
  return { root, dir }
}

const client = () => new WebDavClient({ baseUrl: url, username, passwordHash: ha1, allowInsecureTls: true })
const credential = { enabled: true, url, username, ha1, realm, windowYears: 5, allowInsecureTls: true }
const bucket = (input) => ({
  provider: 'p',
  model: 'm',
  input,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  requests: 1,
  hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, input: hour === 10 ? input : 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: hour === 10 ? 1 : 0 })),
  usageRecords: [{ input, cacheRead: 0, cacheWrite: 0, output: 0, hour: 10 }],
})

const a = makeHome('a')
const b = makeHome('b')
const storeA = createCacheStore({ dir: a.dir, log: () => {}, env: {} })
const storeB = createCacheStore({ dir: b.dir, log: () => {}, env: {} })
// A month the owner of a real server is unlikely to have: this check asserts the *delta* it causes, and
// a month that already exists there would bring that device's whole shard along with it.
const date = '2023-02-14'

try {
  // The server is **not assumed empty**. It belongs to whoever is running this check and usually holds
  // their real history, so nothing here asserts on a store's total: a device that syncs picks up every
  // other device's months as well, and measuring that would be measuring their data, not this check's.
  // What is asserted is **this day** and **this shard**.
  const dayInput = (store, on) => {
    let input = 0
    for (const record of store.load({ since: on, until: on })) for (const day of record.days.values()) for (const b of day.values()) input += b.input
    return input
  }

  // 1. one device publishes a day.
  storeA.put(
    {
      sessionId: 'live-1',
      path: '/logs/live-1/session.jsonl',
      fileSize: 1000,
      fileMtimeMs: 30,
      seq: 30,
      provider: 'p',
      model: 'm',
      days: new Map([[date, new Map([['p|m', bucket(4242)]])]]),
    },
    { at: 30 },
  )
  const engineA = new SyncEngine({ dataDir: a.dir, store: storeA, client: client(), instanceId: `live-a-${run}` })
  engineA.save({ config: { ...credential, deviceId: deviceA, deviceLabel: 'live check a' } })
  const pushed = await engineA.run()
  engineA.release()
  console.log(`  device A: ${pushed.result} — ${pushed.message}`)
  check('the first device reports success', pushed.result === 'ok', JSON.stringify(pushed))
  check('...and published its month', pushed.pushed === 1, String(pushed.pushed))
  // It may well pull other devices' shards — the server has an owner. What it must not do is read back
  // the month it just published under its own name.
  check(
    '...without reading its own month back',
    !Object.keys(engineA.state.held).some((key) => key === `${deviceA}/${date.slice(0, 7)}`),
    JSON.stringify(Object.keys(engineA.state.held).filter((key) => key.startsWith(deviceA))),
  )

  // 2. a second, empty device pulls it and counts the same usage.
  const engineB = new SyncEngine({ dataDir: b.dir, store: storeB, client: client(), instanceId: `live-b-${run}` })
  engineB.save({ config: { ...credential, deviceId: deviceB, deviceLabel: 'live check b' } })
  const pulled = await engineB.run()
  engineB.release()
  console.log(`  device B: ${pulled.result} — ${pulled.message}`)
  check('the second device reports success', pulled.result === 'ok', JSON.stringify(pulled))
  check('...and pulled this check’s month', pulled.pulled >= 1 && Boolean(engineB.state.held[`${deviceA}/${date.slice(0, 7)}`]), JSON.stringify(Object.keys(engineB.state.held).filter((key) => key.startsWith(deviceA))))
  check('...leaving its own store empty of anything to publish', pulled.pushed === 0, String(pulled.pushed))
  check('...so this day arrives with exactly the usage that was published', dayInput(storeB, date) === 4242, `${dayInput(storeB, date)} on ${date} (expected 4242)`)
  check(
    '...with that day attributed to the device that published it',
    storeB
      .scan()
      .filter((record) => record.sessionId === 'live-1')
      .every((record) => record.rows.every((row) => row.source === deviceA)),
    JSON.stringify(storeB.scan().filter((r) => r.sessionId === 'live-1').map((r) => r.rows.map((row) => row.source))),
  )
  check('the credential is kept as the server keeps it, not as plaintext', !readSyncDocument(b.dir).ha1.includes(password), 'plaintext on disk')

  // 3. publishing again with nothing changed uploads nothing.
  const again = await (async () => {
    const engine = new SyncEngine({ dataDir: a.dir, store: storeA, client: client(), instanceId: `live-a-${run}` })
    const result = await engine.run()
    engine.release()
    return result
  })()
  console.log(`  device A again: ${again.result} — ${again.message}`)
  check('a second run uploads nothing', again.pushed === 0, String(again.pushed))
  check('...and still reads nothing back', again.pulled === 0, String(again.pulled))
} catch (error) {
  console.error(`FAIL  ${error?.message ?? error}`)
  failures.push(String(error?.message ?? error))
} finally {
  // Close the stores first: an open SQLite handle keeps the temp directory undeletable on Windows.
  storeA.close()
  storeB.close()
  // Clean up both device directories: the shards, then the manifests, then the collections.
  const clientForCleanup = client()
  for (const device of [deviceA, deviceB]) {
    for (const name of [`2023-02.ndjson.zst`, 'index.json', '.device']) {
      try {
        await clientForCleanup.delete(`usage-badge/${device}/${name}`)
      } catch (error) {
        console.log(`  note: could not remove usage-badge/${device}/${name}: ${error?.message ?? error}`)
      }
    }
    try {
      await clientForCleanup.delete(`usage-badge/${device}/`)
    } catch (error) {
      console.log(`  note: could not remove the usage-badge/${device}/ collection: ${error?.message ?? error}`)
    }
  }
  for (const home of homes) rmSync(home, { recursive: true, force: true })
  try {
    // `usage-badge/` itself is deliberately left alone: it may hold another device's history, and a
    // check that removed a directory it did not create would be the worst kind of surprise.
    const entries = await clientForCleanup.propfind('usage-badge/')
    const leftovers = entries.map((entry) => entry.path)
    if (leftovers.length > 0) console.log(`  note: usage-badge/ still holds ${leftovers.join(', ')} (not this check's to remove)`)
    else console.log('  cleaned up')
  } catch {
    console.log('  cleaned up')
  }
}

console.log(failures.length === 0 ? '\nLIVE CHECK: the whole sync path works against this server' : `\nLIVE CHECK: ${failures.length} failure(s)`)
process.exitCode = failures.length === 0 ? 0 : 2
