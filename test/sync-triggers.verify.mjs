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
import { createChecker, makeHome, mount, DATA_DIR } from './helpers.mjs'

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
  dispose() // immediately: the fold has not finished yet
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
  try {
    const { call, dispose } = await mount(home, 'trigger-inflight-1')
    const running = call('POST', '/usage-badge/sync/run') // deliberately not awaited: it is in flight
    await until(() => server.state.requests.length > 0, { timeoutMs: 3000 })
    dispose()
    check('unloading during a run releases the lock', !existsSync(join(home, DATA_DIR, 'host.lock')), 'the lock was left behind')
    const outcome = await running.catch((error) => ({ body: { error: String(error?.message ?? error) } }))
    check('...and the run stops at its next step boundary', outcome.body?.result === 'aborted', JSON.stringify(outcome.body?.result ?? outcome.body?.error))
    check('...writing nothing to the server', !server.state.files.has('/usage-badge/inflight/index.json'), [...server.state.files.keys()].join(','))
  } finally {
    delete process.env.DSH_USAGE_BADGE_STARTUP_SYNC_MS
    await server.close()
  }
}

finish()
