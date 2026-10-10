/**
 * The two automatic triggers, end to end through the host half.
 *
 * Manual sync is the path a person drives; these are the paths that happen without one:
 *
 *   - **a sync a little after startup**, when sync is already configured and enabled. It must not run
 *     for a home that never turned sync on — that would create `sync.json` and a lock for someone who
 *     never asked, and reach the network on their behalf.
 *   - **a push right after the price table is edited.** The price table is the one hand-written thing
 *     this plugin owns, so an edit is worth publishing while the person is still on the page. A local
 *     edit must never fail because the server is unreachable, and it must never be a reason to create
 *     sync state either.
 *
 * Both are timed in production (seconds) and overridden here so the suite does not wait them out.
 *
 * Usage:
 *   node test/sync-triggers.verify.mjs
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { startFakeWebDav } from './webdav-server.mjs'
import { createChecker, makeHome, mount, writeSession, DATA_DIR } from './helpers.mjs'

const { check, finish } = createChecker('SYNC TRIGGERS VERIFY')

const ha1 = createHash('md5').update('alice:WebDAV:secret1234').digest('hex')

/** Poll until `predicate` holds, or give up. Returns whether it held. */
async function until(predicate, { timeoutMs = 5000, everyMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
}

const writeSync = (home, config) => {
  mkdirSync(join(home, DATA_DIR), { recursive: true })
  writeFileSync(join(home, DATA_DIR, 'sync.json'), JSON.stringify(config, null, 2))
}

// ── 1. a home that never configured sync stays untouched ────────────────────
{
  const home = makeHome('trigger-off')
  process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS = '20'
  await mount(home, 'trigger-off-1')
  delete process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS
  // Wait past the (tiny) startup delay: nothing at all must have happened. No status read here, either —
  // reading the sync tab is itself a decision to engage, so it would create what this test is about.
  await new Promise((resolve) => setTimeout(resolve, 150))
  const files = readdirSync(join(home, DATA_DIR))
  check('an unconfigured home gets no automatic sync and no state', !files.includes('host.lock') && !files.includes('sync.json'), files.join(','))
}

// ── 2. a configured home syncs a little after startup ──────────────────────
{
  const server = await startFakeWebDav()
  const home = makeHome('trigger-on')
  try {
    writeSync(home, {
      enabled: true,
      url: server.url,
      username: 'alice',
      ha1,
      realm: 'WebDAV',
      deviceId: 'desktop',
      deviceLabel: 'desk',
      instanceId: 'trigger-on',
      windowYears: 5,
      state: {},
    })
    process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS = '30'
    const { call } = await mount(home, 'trigger-on-1')
    delete process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS

    // The run is asynchronous and its state is written at the end, so this waits for the state rather
    // than for the first byte on the server — the two are moments apart, and the panel reads the state.
    const recorded = await until(async () => (await call('GET', '/usage-badge/sync')).body.last.result === 'ok')
    const status = await call('GET', '/usage-badge/sync')
    check('a configured home syncs shortly after startup, with nobody pressing a button', recorded, JSON.stringify(status.body.last))
    check('...announcing itself on the server', server.state.files.has('/usage-badge/desktop/index.json'), [...server.state.files.keys()].join(','))
    check('...and the status records the run', status.body.last.result === 'ok' && /pulled/.test(status.body.last.message), JSON.stringify(status.body.last))
  } finally {
    await server.close()
  }
}

// ── 3. editing the price table publishes it, without a full run ─────────────
{
  const server = await startFakeWebDav()
  const home = makeHome('trigger-pricing')
  try {
    writeSync(home, {
      enabled: true,
      url: server.url,
      username: 'alice',
      ha1,
      realm: 'WebDAV',
      deviceId: 'desktop',
      deviceLabel: 'desk',
      instanceId: 'trigger-pricing',
      windowYears: 5,
      state: {},
    })
    // Long enough that pressing "save" three times is one publish, short enough for a test to wait out.
    process.env.DSH_USAGE_BADGE_PRICING_PUSH_MS = '30'
    // The startup sync is pushed past the end of this test: it would otherwise fire after the server is
    // closed and log a connection failure, which is noise, not a finding.
    process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS = '600000'
    const { call } = await mount(home, 'trigger-pricing-1')

    // One local edit through the real route: this is what the row editor and the switches do.
    const saved = await call('POST', '/usage-badge/config', { modelPrefixFallback: false })
    check('a local price edit is accepted', saved.status === 200, JSON.stringify(saved.body))

    const pushed = await until(() => server.state.files.has('/usage-badge/pricing.json'))
    check('the edit is published without asking', pushed, [...server.state.files.keys()].join(','))
    if (pushed) {
      const published = JSON.parse(server.state.files.get('/usage-badge/pricing.json').toString('utf8'))
      check('...carrying the edit', published.modelPrefixFallback === false, JSON.stringify(published.modelPrefixFallback))
      check('...and this device’s own copy beside it', server.state.files.has('/usage-badge/desktop/pricing-desktop.json'), [...server.state.files.keys()].join(','))
      check('...with no shard work dragged along', ![...server.state.files.keys()].some((path) => path.endsWith('.ndjson.zst')), [...server.state.files.keys()].join(','))
    }
    delete process.env.DSH_USAGE_BADGE_PRICING_PUSH_MS
    delete process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS
  } finally {
    await server.close()
  }
}

// ── 4. an unreachable server never makes a local edit fail ──────────────────
{
  const home = makeHome('trigger-down')
  try {
    writeSync(home, {
      enabled: true,
      url: 'http://127.0.0.1:9/',
      username: 'alice',
      ha1,
      realm: 'WebDAV',
      deviceId: 'desktop',
      instanceId: 'trigger-down',
      windowYears: 5,
      state: {},
    })
    process.env.DSH_USAGE_BADGE_PRICING_PUSH_MS = '20'
    // And here the point *is* an unreachable server, so the startup sync is allowed to run and fail — it
    // must fail quietly, which is what the check below reads.
    process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS = '20'
    const { call } = await mount(home, 'trigger-down-1')
    const saved = await call('POST', '/usage-badge/config', { priceUnmatchedModels: false })
    check('a local edit succeeds even when the server is unreachable', saved.status === 200, JSON.stringify(saved.body))
    await new Promise((resolve) => setTimeout(resolve, 250))
    const after = await call('GET', '/usage-badge/config')
    check('...and the local table is the one that took effect', after.body.effective.priceUnmatchedModels === false, JSON.stringify(after.body.effective.priceUnmatchedModels))
    delete process.env.DSH_USAGE_BADGE_PRICING_PUSH_MS
    delete process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS
  } finally {
    // nothing to close
  }
}

// ── 5. unloading stops the automatic work, even before the first fold finishes ─
//
// `apply()` returns before `warm()` resolves, so an unload in that window used to let the callback run
// anyway: it scheduled the first sync *after* the unload, took the lock back, and synced through a store
// that had already been closed — leaving `host.lock` behind for a host that was gone, and a re-mount refused
// by its own lock.
{
  const strayHome = makeHome('trigger-stray')
  writeSync(strayHome, {
    enabled: true,
    url: 'http://127.0.0.1:9/',
    username: 'alice',
    ha1,
    realm: 'WebDAV',
    deviceId: 'stray',
    instanceId: 'trigger-stray',
    windowYears: 5,
    state: {},
  })
  process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS = '60'
  const { dispose } = await mount(strayHome, 'trigger-stray-1')
  await dispose() // immediately: the fold has not finished yet
  delete process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS
  await new Promise((resolve) => setTimeout(resolve, 400))
  const files = readdirSync(join(strayHome, DATA_DIR))
  check('unloading before the first fold finishes schedules nothing', !files.includes('host.lock'), files.join(','))
}

// A run that is already in flight when the host unloads must not leave the lock behind either. The engine
// declines to release a lock the host handed it (`ownsLock`), so the disposer removes it itself.
{
  const server = await startFakeWebDav({ delayMs: 150 })
  const home = makeHome('trigger-inflight')
  writeSync(home, {
    enabled: true,
    url: server.url,
    username: 'alice',
    ha1,
    realm: 'WebDAV',
    deviceId: 'inflight',
    instanceId: 'trigger-inflight',
    windowYears: 5,
    state: {},
  })
  process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS = '600000'
  // A budget far shorter than the server's answer time: the run in flight is cut off at its next step
  // boundary, which is exactly what this case is about.
  process.env.DSH_USAGE_BADGE_EXIT_SYNC_MS = '50'
  try {
    const { call, dispose } = await mount(home, 'trigger-inflight-1')
    const running = call('POST', '/usage-badge/sync/run') // deliberately not awaited: it is in flight
    await until(() => server.state.requests.length > 0, { timeoutMs: 3000 })
    await dispose()
    check('unloading during a run releases the lock', !existsSync(join(home, DATA_DIR, 'host.lock')), 'the lock was left behind')
    const outcome = await running.catch((error) => ({ body: { error: String(error?.message ?? error) } }))
    check('...and the run stops at its next step boundary', outcome.body?.result === 'aborted', JSON.stringify(outcome.body?.result ?? outcome.body?.error))
    check('...writing nothing to the server', !server.state.files.has('/usage-badge/inflight/index.json'), [...server.state.files.keys()].join(','))
  } finally {
    delete process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS
    delete process.env.DSH_USAGE_BADGE_EXIT_SYNC_MS
    await server.close()
  }
}

// ── 6. a sync on the way out, awaited but bounded ───────────────────────────
//
// DSH's shutdown awaits what a disposer returns — the desktop asks the host to stop, the host awaits its own
// disposal, and the runtime force-exits only after 5 s. So the disposer can sync once for real, as long as it
// gives up in time. This is the part that has to be true for "it syncs when I close DSH" to be a feature
// rather than a hope.
{
  const server = await startFakeWebDav()
  const home = makeHome('trigger-exit')
  // A session to fold and publish, so the run has something to send.
  writeSession(home, 'exit-1', { provider: 'p', model: 'm', time: Date.now(), input: 4242 })
  writeSync(home, {
    enabled: true,
    url: server.url,
    username: 'alice',
    ha1,
    realm: 'WebDAV',
    deviceId: 'exit-device',
    instanceId: 'trigger-exit',
    windowYears: 5,
    onStart: false, // only the exit path is under test here
    state: {},
  })
  process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS = '600000'
  process.env.DSH_USAGE_BADGE_EXIT_SYNC_MS = '4000'
  try {
    const { dispose } = await mount(home, 'trigger-exit-1')
    check('nothing reaches the server before the host unloads', server.state.requests.length === 0, String(server.state.requests.length))
    await dispose()
    check('unloading syncs once before handing the lock back', server.state.files.has('/usage-badge/exit-device/index.json'), [...server.state.files.keys()].join(','))
    const manifest = JSON.parse(server.state.files.get('/usage-badge/exit-device/index.json').toString('utf8'))
    check('...publishing the month that was folded', Object.keys(manifest.chunks).length === 1, JSON.stringify(Object.keys(manifest.chunks)))
    check('...and the lock is still handed back', !existsSync(join(home, DATA_DIR, 'host.lock')), 'the lock was left behind')
  } finally {
    delete process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS
    delete process.env.DSH_USAGE_BADGE_EXIT_SYNC_MS
    await server.close()
  }
}

// The switch: `onExit: false` means no sync when the host unloads.
{
  const server = await startFakeWebDav()
  const home = makeHome('trigger-exit-off')
  writeSync(home, {
    enabled: true,
    url: server.url,
    username: 'alice',
    ha1,
    realm: 'WebDAV',
    deviceId: 'exit-off',
    instanceId: 'trigger-exit-off',
    windowYears: 5,
    onStart: false,
    onExit: false,
    state: {},
  })
  process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS = '600000'
  process.env.DSH_USAGE_BADGE_EXIT_SYNC_MS = '4000'
  try {
    const { dispose } = await mount(home, 'trigger-exit-off-1')
    await dispose()
    check('with the exit sync switched off nothing is sent', server.state.requests.length === 0 && !server.state.files.has('/usage-badge/exit-off/index.json'), `${server.state.requests.length} request(s)`)
  } finally {
    delete process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS
    delete process.env.DSH_USAGE_BADGE_EXIT_SYNC_MS
    await server.close()
  }
}

// The budget: a server that does not answer must not hold up quitting, and the run must stop at a step
// boundary rather than leaving a half-written month behind.
{
  const server = await startFakeWebDav({ delayMs: 600 })
  const home = makeHome('trigger-exit-slow')
  writeSession(home, 'exit-slow-1', { provider: 'p', model: 'm', time: Date.now(), input: 100 })
  writeSync(home, {
    enabled: true,
    url: server.url,
    username: 'alice',
    ha1,
    realm: 'WebDAV',
    deviceId: 'exit-slow',
    instanceId: 'trigger-exit-slow',
    windowYears: 5,
    onStart: false,
    state: {},
  })
  process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS = '600000'
  process.env.DSH_USAGE_BADGE_EXIT_SYNC_MS = '150'
  try {
    const { dispose } = await mount(home, 'trigger-exit-slow-1')
    const started = Date.now()
    await dispose()
    const took = Date.now() - started
    check('a slow server does not hold up the shutdown', took < 2000, `${took} ms`)
    check('...nothing is left half-published', !server.state.files.has('/usage-badge/exit-slow/index.json'), [...server.state.files.keys()].join(','))
    check('...no temporary upload name is left behind', [...server.state.files.keys()].every((path) => !path.includes('.upload-')), [...server.state.files.keys()].join(','))
    check('...and the lock is handed back anyway', !existsSync(join(home, DATA_DIR, 'host.lock')), 'the lock was left behind')
  } finally {
    delete process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS
    delete process.env.DSH_USAGE_BADGE_EXIT_SYNC_MS
    await server.close()
  }
}

// The other switch: `onStart: false` means no sync on the way up.
{
  const server = await startFakeWebDav()
  const home = makeHome('trigger-start-off')
  writeSync(home, {
    enabled: true,
    url: server.url,
    username: 'alice',
    ha1,
    realm: 'WebDAV',
    deviceId: 'start-off',
    instanceId: 'trigger-start-off',
    windowYears: 5,
    onStart: false,
    onExit: false,
    state: {},
  })
  process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS = '20'
  try {
    const { settle } = await mount(home, 'trigger-start-off-1')
    await settle()
    await new Promise((resolve) => setTimeout(resolve, 200))
    check('with the startup sync switched off nothing is sent', server.state.requests.length === 0, `${server.state.requests.length} request(s)`)
  } finally {
    delete process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS
    await server.close()
  }
}

// ── 7. with sync off, not one request and not one file ──────────────────────
//
// The promise the whole feature rests on: a home that never turned sync on (or turned it off again) is not
// touched — no `sync.json`, no lock, no network. Every trigger checks `enabled` before doing anything, and
// this is the test that says so out loud, including the case that is easiest to get wrong: a home that **was**
// configured once (url and ha1 present) and then switched off.
{
  const server = await startFakeWebDav()
  const home = makeHome('trigger-all-off')
  writeSync(home, {
    enabled: false, // configured once, then switched off
    url: server.url,
    username: 'alice',
    ha1,
    realm: 'WebDAV',
    deviceId: 'off-device',
    instanceId: 'trigger-all-off',
    windowYears: 5,
    state: {},
  })
  // Something to publish, so a missing check would show up as a request rather than as "nothing to do".
  writeSession(home, 'off-1', { provider: 'p', model: 'm', time: Date.now(), input: 4242 })
  process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS = '20'
  process.env.DSH_USAGE_BADGE_PRICING_PUSH_MS = '20'
  process.env.DSH_USAGE_BADGE_EXIT_SYNC_MS = '2000'
  try {
    const { call, settle, dispose } = await mount(home, 'trigger-all-off-1')
    await settle()
    await new Promise((resolve) => setTimeout(resolve, 250)) // well past the startup delay
    check('sync off: the startup trigger sends nothing', server.state.requests.length === 0, `${server.state.requests.length} request(s)`)

    const saved = await call('POST', '/usage-badge/config', { modelPrefixFallback: false })
    await new Promise((resolve) => setTimeout(resolve, 250)) // well past the pricing-push delay
    check('...and a price edit stays a local edit', saved.status === 200 && server.state.requests.length === 0, `${server.state.requests.length} request(s)`)

    await dispose()
    check('...and unloading sends nothing either', server.state.requests.length === 0, `${server.state.requests.length} request(s)`)
    const files = readdirSync(join(home, DATA_DIR))
    check('...and no lock was ever taken', !files.includes('host.lock'), files.join(','))

    // Opening the sync tab is looking, not deciding: it must not create `sync.json` or take the lock, and it
    // must not let any automatic trigger fire.
    const opened = await mount(home, 'trigger-all-off-2')
    await opened.settle()
    await opened.call('GET', '/usage-badge/sync')
    const before = server.state.requests.length
    check('sync off: opening the tab still creates nothing', !readdirSync(join(home, DATA_DIR)).includes('host.lock'), readdirSync(join(home, DATA_DIR)).join(','))
    await new Promise((resolve) => setTimeout(resolve, 250))
    check('...triggers nothing', server.state.requests.length === before, `${server.state.requests.length - before} request(s) after opening`)
    await opened.dispose()
    check('...not even on unload', server.state.requests.length === before, `${server.state.requests.length - before} request(s) after unloading`)
  } finally {
    delete process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS
    delete process.env.DSH_USAGE_BADGE_PRICING_PUSH_MS
    delete process.env.DSH_USAGE_BADGE_EXIT_SYNC_MS
    await server.close()
  }
}

await finish()