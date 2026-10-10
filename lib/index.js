/**
 * dsh-usage-badge — host half.
 *
 * Folds every DSH session log into per-day cost totals and serves them to the
 * browser half over a small JSON API. It owns no model-visible surface: nothing
 * here adds a prompt section, a tool, or a session event.
 *
 * Why an HTTP route instead of a Typert remote: a third-party plugin cannot
 * easily ship the generated invocation descriptors strict mode wants, and the
 * Typert source-plane fallback is documented as a development path. Named
 * `ctx.webServer` routes need no codegen and no gateway wiring, which is what
 * keeps this plugin dependency-free. The routes are unauthenticated like the rest
 * of the loopback UI, so the two write paths additionally require a loopback peer.
 *
 * @module dsh-usage-badge
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

import { createCacheStore } from './cache-store.js'
import { createAggregator, mergeRecords, resolveDshHome } from './fold.js'
import { SyncEngine, acquireLock, readSyncDocument, releaseLock, safeDeviceId } from './sync.js'
import { normalizeWebdavUrl } from './webdav.js'
import { describeCalendar, loadBundledTable, resolveHolidayRules } from './holidays.js'
import { OFFICIAL_SOURCES, applyOfficialPricing, fetchOfficialPricing } from './official-pricing.js'
import {
  DEFAULT_TEMPLATE,
  bucketCost,
  bucketHourlyCosts,
  dayContext,
  dayKey,
  isUnpriced,
  normalizePricing,
  timeOfUseState,
  totalCurrencyOf,
} from './pricing.js'

/** Cordis service this plugin requires; the host half is meaningless without it. */
export const inject = ['webServer']

/** Plugin name as it appears in the loader tree. */
export const name = 'usage-badge'

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/usage-badge'

/**
 * What the browser half requires of the host half, and what this build provides.
 *
 * Bump it whenever the panel starts depending on something only a newer host does — an
 * accepted patch key, a field in a response. The host half is loaded when the DSH process
 * starts while the browser half is re-read on every page load, so a refreshed page against
 * an unrestarted host is the normal way to get a UI whose buttons silently do nothing
 * (an unknown patch key is accepted with a 200 and ignored). The panel compares this number
 * and says so instead. `test/client.render.mjs` asserts the two halves agree.
 */
export const HOST_API_VERSION = 7

/**
 * Directory under `$DSH_HOME/storages` holding every file this plugin owns, so its
 * cache and price table are never mistaken for harness data in the shared root.
 */
const DATA_DIR_NAME = 'usage-badge'

/**
 * How many of the newest days **that have usage** travel in the payload; covers the 12-month view
 * plus slack.
 *
 * Not a calendar-day window: the snapshot takes the newest 400 entries of the in-memory day map, so
 * a sparse history reaches further back than 400 days — and a dense one stops inside them. The
 * store's loading window (`CACHE_WINDOW_DAYS`) is a separate, calendar-day bound on what is read
 * back from disk; it is deliberately wider so it never truncates what this can ask for.
 */
const DAYS_KEPT = 400

/** A snapshot younger than this is reused instead of rebuilt on every poll. */
const SNAPSHOT_TTL_MS = 2000

/**
 * How long after an edit the price table is published.
 *
 * Long enough that editing three rows in a row is one publish rather than three, short enough that the
 * person is still on the page when it happens. Only ever reached when sync is on and configured.
 */
export const PRICING_PUSH_DELAY_MS = 3000

/** How long after startup the first automatic sync runs, when sync is enabled. */
export const STARTUP_SYNC_DELAY_MS = 8000

/**
 * How long the panel waits for a status read before it is told the answer is not ready.
 *
 * The status read may ask the server what devices it holds. That happens in the background, but this
 * bound is what keeps a slow or black-holed server from making the whole dialog look frozen.
 */
const STATUS_TIMEOUT_MS = 5000

/** Resolve `promise`, or reject once `ms` have passed, so a route can always answer. */
function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)}s`)), ms)
      timer.unref?.()
    }),
  ])
}

/**
 * The delay to actually use, overridable so a test does not have to wait out a real one.
 *
 * Reading it per call rather than at import time is what lets a test set the variable, mount the plugin,
 * and still get the short delay — the host half is imported once per scenario with a cache-busting
 * query, but a constant captured at module load would freeze whatever the first reader saw.
 */
function delayFor(name, fallback) {
  const configured = Number(process.env[name])
  return Number.isFinite(configured) && configured >= 0 ? configured : fallback
}

/**
 * How long a fetched price list is reused. Opening the dialog asks for a fresh
 * copy every time, and this window only coalesces the requests that arrive within
 * a few seconds of each other so a reopened panel cannot hammer the docs site.
 */
const OFFICIAL_TTL_MS = 20000

/** Largest accepted request body, so a bad client cannot buffer unbounded memory. */
const MAX_BODY_BYTES = 256 * 1024

const log = (message) => console.log(`[dsh-usage-badge] ${message}`)

/** Round to a fixed number of decimals. */
const round = (value, decimals) => {
  const factor = 10 ** decimals
  return Math.round((Number(value) || 0) * factor) / factor
}

/** A fresh 24-slot cost/token series. */
const newHourSeries = () =>
  Array.from({ length: 24 }, (_, hour) => ({
    hour,
    amount: 0,
    requests: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
  }))

/** Add one bucket's token/request totals (and cost) into a row. */
function addTokens(target, source, amount) {
  target.amount += amount
  target.requests += source.requests || 0
  target.input += source.input || 0
  target.cacheRead += source.cacheRead || 0
  target.cacheWrite += source.cacheWrite || 0
  target.output += source.output || 0
}

/**
 * Fold one day's route buckets into day totals and provider rows.
 *
 * `date` is passed in rather than read off the bucket because the day's cost
 * depends on facts the bucket does not carry: its weekday, and whether the holiday
 * calendar marks it a holiday or a 调休 working day.
 *
 * `withHourly` materializes the 24-hour series for the day *and* for every
 * provider row, which costs one pass over the day's per-request records — so it
 * is requested only for the day being charted, and that same pass supplies the
 * day total instead of costing the buckets twice.
 */
function summarizeDay(dayObj, pricing, date, withHourly, rules) {
  const day = dayContext(date, rules)
  const providers = new Map()
  const totals = { amount: 0, requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  const dayHours = withHourly ? newHourSeries() : null

  for (const bucket of dayObj?.values() ?? []) {
    const providerName = String(bucket.provider ?? '').trim() || 'unknown'
    let row = providers.get(providerName)
    if (!row) {
      row = { provider: providerName, amount: 0, requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
      if (withHourly) row.hourly = newHourSeries()
      providers.set(providerName, row)
    }

    const costs = dayHours ? bucketHourlyCosts(bucket, pricing, day) : null
    let amount = 0
    if (costs) for (let hour = 0; hour < 24; hour++) amount += costs[hour]
    else amount = bucketCost(bucket, pricing, day)

    addTokens(row, bucket, amount)
    addTokens(totals, bucket, amount)

    if (!costs) continue
    for (let hour = 0; hour < 24; hour++) {
      row.hourly[hour].amount += costs[hour]
      dayHours[hour].amount += costs[hour]
      const source = bucket.hourly?.[hour]
      if (!source) continue
      for (const target of [row.hourly[hour], dayHours[hour]]) {
        target.requests += source.requests || 0
        target.input += source.input || 0
        target.cacheRead += source.cacheRead || 0
        target.cacheWrite += source.cacheWrite || 0
        target.output += source.output || 0
      }
    }
  }

  const roundSeries = (series) => series?.map((slot) => ({ ...slot, amount: round(slot.amount, 4) })) ?? null

  return {
    totals: {
      amount: round(totals.amount, 4),
      requests: totals.requests,
      input: totals.input,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      output: totals.output,
    },
    providers: [...providers.values()]
      .sort((a, b) => b.amount - a.amount || a.provider.localeCompare(b.provider))
      .map((row) => {
        const base = { ...row, amount: round(row.amount, 4) }
        // Only the 24-hour view asks for a per-hour series, and a row without one omits the key
        // rather than carrying `hourly: null`, so a month row and a day row have the same shape.
        if (row.hourly) base.hourly = roundSeries(row.hourly)
        return base
      }),
    hourly: roundSeries(dayHours),
  }
}

/**
 * Fold one calendar year's day rows into twelve natural months.
 *
 * All twelve are always present, in order, empty ones included: a month bar has to line up
 * across years, and "no usage in March" is a fact about March rather than a month to drop.
 * Costing is the day summariser's, day by day and request by request, so a month total is the
 * sum of its days and nothing is priced at a coarser granularity than the daily charts use.
 *
 * @param {Map<string, Map<string, object>>} dayRows - merged day buckets, as `mergeRecords`
 *   produces them, already restricted to the year.
 */
function summarizeYear(dayRows, pricing, rules, year) {
  const months = Array.from({ length: 12 }, (_, index) => ({
    month: `${year}-${String(index + 1).padStart(2, '0')}`,
    label: `${index + 1}月`,
    amount: 0,
    requests: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    providers: new Map(),
  }))
  // The year's days travel with the months: the heatmap next to the monthly chart is a calendar
  // grid, and days older than the loading window are not in the snapshot at all.
  const days = []

  for (const [date, dayObj] of dayRows) {
    const month = months[Number(date.slice(5, 7)) - 1]
    if (!month) continue
    const summary = summarizeDay(dayObj, pricing, date, false, rules)
    days.push(dayRow(date, summary, rules))
    addTokens(month, summary.totals, summary.totals.amount)
    for (const row of summary.providers) {
      const target = month.providers.get(row.provider) ?? {
        provider: row.provider,
        amount: 0,
        requests: 0,
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
      }
      addTokens(target, row, row.amount)
      month.providers.set(row.provider, target)
    }
  }

  const total = { amount: 0, requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  for (const month of months) {
    total.amount += month.amount
    total.requests += month.requests
    total.input += month.input
    total.cacheRead += month.cacheRead
    total.cacheWrite += month.cacheWrite
    total.output += month.output
  }

  return {
    year: Number(year),
    // How many days of that year this is based on, so an empty year is legible. Counted from the
    // rows actually reported, not from the input map — a row whose date is unparseable is skipped
    // and must not be counted as a day the caller can see.
    days: days.length,
    months: months.map((month) => ({
      ...month,
      amount: round(month.amount, 4),
      providers: [...month.providers.values()]
        .sort((a, b) => b.amount - a.amount || a.provider.localeCompare(b.provider))
        .map((row) => ({ ...row, amount: round(row.amount, 4) })),
    })),
    // The days that had usage, oldest first — the calendar grid fills in the quiet ones itself.
    daily: days,
    total: { ...total, amount: round(total.amount, 4) },
  }
}

/**
 * Recover the `provider|model` route behind a provider row, so a per-model
 * pricing rule can be evaluated for the period indicator. A provider row is
 * already collapsed across models, so that provider's heaviest model stands in
 * for the provider as a whole.
 */
function dominantRouteOf(dayObj, providerName) {
  let best = null
  for (const bucket of dayObj?.values() ?? []) {
    if ((String(bucket.provider ?? '').trim() || 'unknown') !== providerName) continue
    const weight = bucket.input + bucket.cacheRead + bucket.cacheWrite + bucket.output
    if (!best || weight > best.weight) best = { weight, model: bucket.model ?? null }
  }
  return best?.model ?? null
}

/**
 * Routes inside the snapshot window that have usage but no price at all.
 *
 * Only reachable with `priceUnmatchedModels` off. The snapshot reports them because a
 * route that contributes tokens and ¥0 is indistinguishable from a free one — the panel
 * has to be able to say which models the amount is missing, or the total would be a
 * silently wrong number of exactly the kind this plugin avoids everywhere else.
 */
function collectUnpriced(pricing, dayObjs, dates) {
  // The common case by far: every model is priced, so there is nothing to walk. Answering
  // before the loop keeps this off the snapshot-building path for tables that never ask.
  if (pricing.priceUnmatchedModels !== false) return []
  const window = new Set(dates)
  const routes = new Map()
  for (const [date, dayObj] of dayObjs) {
    if (!window.has(date)) continue
    for (const bucket of dayObj.values()) {
      if (!isUnpriced(pricing, bucket.provider, bucket.model)) continue
      const provider = String(bucket.provider ?? '').trim() || 'unknown'
      const model = String(bucket.model ?? '').trim() || 'unknown'
      const key = `${provider}|${model}`
      const row = routes.get(key) ?? { provider, model, tokens: 0, requests: 0 }
      row.tokens += (bucket.input || 0) + (bucket.cacheRead || 0) + (bucket.cacheWrite || 0) + (bucket.output || 0)
      row.requests += bucket.requests || 0
      routes.set(key, row)
    }
  }
  return [...routes.values()].sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model))
}

/**
 * One day, as a row: totals, per-provider splits, and the day's own classification.
 *
 * Shared by the snapshot and the year view, because both feed the same chart and the same
 * heatmap, and a day that read differently in the two would be a bug with no upside. The marks
 * travel with the row because it is the only way to read a past day's holiday status back.
 */
function dayRow(date, summary, rules) {
  const context = dayContext(date, rules)
  return { date, ...summary.totals, providers: summary.providers, dayClass: context.class, dayName: context.name }
}

/** Build the payload the browser half renders. */
function buildSnapshot(aggregator, pricing, rules, status, years = []) {
  const now = Date.now()
  const today = dayKey(now)
  const dayObjs = aggregator.days
  const dates = [...dayObjs.keys()].sort().reverse().slice(0, DAYS_KEPT)

  const todayObj = dayObjs.get(today)
  const todaySummary = summarizeDay(todayObj, pricing, today, true, rules)

  const days = dates.map((date) =>
    dayRow(
      date,
      date === today ? todaySummary : summarizeDay(dayObjs.get(date), pricing, date, false, rules),
      rules,
    ),
  )

  // The badge is always CNY: a CNY total needs no rate, a USD total is converted
  // with the live exchange rate.
  const totalCurrency = totalCurrencyOf(pricing)
  const badgeCny =
    totalCurrency === 'cny'
      ? todaySummary.totals.amount
      : todaySummary.totals.amount * (Number(pricing.exchangeRate) || 1)

  // Period indicator: today's dominant route's rule, so a per-model override is
  // reflected rather than only the global default row.
  const dominant = todaySummary.providers[0]
  const band = timeOfUseState(
    pricing,
    dominant ? dominant.provider : null,
    dominant ? dominantRouteOf(todayObj, dominant.provider) : null,
    dayContext(today, rules),
  )

  return {
    generatedAt: now,
    currency: totalCurrency,
    exchangeRate: pricing.exchangeRate,
    badge: { date: today, amount: round(badgeCny, 2), currency: 'cny' },
    today: { date: today, ...todaySummary.totals, hourly: todaySummary.hourly, providers: todaySummary.providers },
    days,
    // Which calendar years have data, newest first. Answered by the store, not by the days
    // above: the snapshot only carries a window, so a year older than that would be invisible
    // even though its rows are still on disk.
    years,
    // Empty unless unmatched models are deliberately left unpriced.
    unpriced: collectUnpriced(pricing, dayObjs, dates),
    band,
    calendar: describeCalendar(rules, now),
    status: { ...status, sessions: aggregator.sessionCount },
  }
}

/**
 * Read a pricing document, preferring the plugin's own directory.
 *
 * `paths` is ordered: the canonical file first, then the pre-isolation location in
 * the shared storages root. The fallback exists so an install that predates the
 * move keeps working, and so a harness-side `usage-pricing.json` is still honored
 * if one reappears — the first write migrates it into the plugin's directory.
 *
 * @returns {{raw:object, path:string|null}} the parsed document and where it came
 *   from; `path` is null when neither file exists or parses.
 */
function readRawPricing(paths) {
  for (const path of paths) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      if (raw && typeof raw === 'object') return { raw, path }
    } catch {
      // Missing or corrupt: fall through to the next candidate.
    }
  }
  return { raw: {}, path: null }
}

/** Normalize a read result, falling back to the template when nothing was found. */
function readPricing(paths) {
  return normalizePricing(readRawPricing(paths).raw)
}

/** Read a request body, bounded. An oversized one is a 413, not a server error. */
/**
 * Read a JSON request body, reporting a malformed one as the caller's mistake.
 *
 * A bare `JSON.parse` throws a `SyntaxError` with no status, which the route wrapper can only answer with a
 * 500 — and a 500 for a body the client got wrong sends whoever is debugging it looking at the host.
 */
async function readJsonBody(req) {
  const text = (await readBody(req)) || '{}'
  try {
    return JSON.parse(text)
  } catch (error) {
    const bad = new Error(`the request body is not JSON: ${error?.message ?? error}`)
    bad.statusCode = 400
    throw bad
  }
}

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        const error = new Error(`request body larger than ${MAX_BODY_BYTES} bytes`)
        error.statusCode = 413
        rejectPromise(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectPromise)
  })
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Whether a socket belongs to this machine, so a LAN peer cannot rewrite config. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Atomically replace a file with `text`. */
function writeFileAtomic(path, text) {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temp, text)
  try {
    renameSync(temp, path)
  } catch {
    // Windows cannot rename over an existing file; the complete temp file is
    // already on disk, so removing the old one first loses nothing.
    try {
      unlinkSync(path)
    } catch {
      // absent is fine
    }
    renameSync(temp, path)
  }
}

/**
 * Merge an accepted config patch into the raw user document. Only the fields this
 * plugin prices with are touched, and only when the client sent them, so keys it
 * does not understand survive the round trip.
 */
function mergeConfig(raw, patch) {
  const next = raw && typeof raw === 'object' ? { ...raw } : {}
  if (patch.exchangeRate !== undefined) next.exchangeRate = Number(patch.exchangeRate) || next.exchangeRate
  if (patch.totalCurrency !== undefined) next.totalCurrency = patch.totalCurrency === 'usd' ? 'usd' : 'cny'
  if (patch.multiplier !== undefined) next.multiplier = Number(patch.multiplier) || 1
  // Accepted here even though the panel offers no field for it: only an explicit
  // `false` turns the model-prefix fallback off.
  if (patch.modelPrefixFallback !== undefined) next.modelPrefixFallback = patch.modelPrefixFallback !== false
  // Same shape: only an explicit `false` stops the `default` row pricing unmatched models.
  if (patch.priceUnmatchedModels !== undefined) next.priceUnmatchedModels = patch.priceUnmatchedModels !== false
  // The catch-all row is replaced **wholesale**, exactly like `overrides` below — the panel sends
  // the whole row it was showing, so a field the user cleared has to disappear. Merging instead
  // (the older behaviour) made clearing a field a silent no-op that still reported success, and
  // it meant an unwanted `currency` or rate could never be removed from the panel.
  // `default: null` removes the row; the table then falls back to the built-in template until an
  // official apply fills it again.
  if (patch.default === null) delete next.default
  else if (patch.default && typeof patch.default === 'object') next.default = { ...patch.default }
  if (patch.overrides && typeof patch.overrides === 'object') next.overrides = patch.overrides
  if (patch.timeOfUse !== undefined) next.timeOfUse = patch.timeOfUse
  if (patch.contextMultiplier !== undefined) next.contextMultiplier = patch.contextMultiplier
  if (patch.holidays !== undefined) next.holidays = patch.holidays
  return next
}

/**
 * Host plugin body.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context carrying `webServer`.
 */
export function apply(ctx) {
  const home = resolveDshHome()
  const sessionsRoot = join(home, 'sessions')
  // Everything this plugin owns lives in one directory of its own. Writing into
  // the shared storages root would leave files a user cannot attribute: the root
  // already holds harness caches and, on some installs, other tools' settings.
  const dataDir = join(home, 'storages', DATA_DIR_NAME)
  const pricingPath = join(dataDir, 'pricing.json')
  /** Pre-isolation location of the price table, honored as a migration fallback. */
  const legacyPricingPath = join(home, 'storages', 'usage-pricing.json')
  const pricingPaths = [pricingPath, legacyPricingPath]

  // The folded history lives in whichever store this runtime can offer — SQLite when
  // `node:sqlite` is there, the original single-document JSON otherwise. Either way it is one
  // file inside the plugin's own directory.
  const store = createCacheStore({ dir: dataDir, log })
  const aggregator = createAggregator({ sessionsRoot, store, log })
  aggregator.loadCache()

  /**
   * The sync system, created **on first use** rather than when the plugin mounts.
   *
   * Creating it eagerly would write `host.lock` and `sync.json` into the data directory of every
   * install, including the many that never turn sync on — and would quietly change the directory a
   * user is looking at. Mounting a plugin should not do that; asking it to sync should.
   *
   * The lock decides who may **write**: a second DSH instance pointed at the same home cannot share a
   * `deviceId`, because two processes would each believe the same remote shard is theirs to overwrite.
   * The instance that loses is not broken and does not refuse to start — it reports why and declines to
   * sync, which is the same answer the design gives to a read-only cache.
   */
  let system = null
  function syncSystem() {
    if (system) return system
    const document = readSyncDocument(dataDir, log)
    const instanceId = document.instanceId || `${hostname()}-${process.pid}`
    const lock = acquireLock(dataDir, { instanceId, log })
    if (!lock.acquired) log(`usage-badge is read-only here: ${lock.reason}`)
    const engine = new SyncEngine({
      dataDir,
      store: lock.acquired ? store : null,
      log,
      config: document,
      state: document.state,
      instanceId,
    })
    if (!document.deviceId) engine.save({ config: { deviceId: `${hostname()}-${randomBytes(3).toString('hex')}` } })
    // **This** is where the lock becomes ours, not inside `run()`: the host takes it once, when the system
    // comes into being, and hands the already-held lock to every run. Without this the engine reported
    // `ownsLock: false`, so `release()` declined to remove a lock this very process was holding — and the
    // next mount of the same directory was refused by this plugin's own lock, naming a live pid.
    engine.ownsLock = lock.acquired
    system = {
      engine,
      lock,
      instanceId,
      running: null,
      pushing: null,
      // The last run is **persisted** state, so a restart must show it rather than "从未": the panel's
      // first question is "when did this last work", and the answer is in `sync.json` — the engine wrote
      // it there precisely so that it would outlive the process.
      last: {
        result: document.state?.lastResult || (lock.acquired ? 'never' : 'locked'),
        message: document.state?.message ?? (lock.acquired ? '' : lock.reason),
        at: Number(document.state?.lastSyncAt) || 0,
      },
    }
    return system
  }

  const { path: pricingSourcePath } = readRawPricing(pricingPaths)
  if (pricingSourcePath === legacyPricingPath) {
    log(`reading the price table from the pre-isolation path ${legacyPricingPath}; the next write moves it to ${pricingPath}`)
  }
  let pricing = readPricing(pricingPaths)
  let rules = resolveHolidayRules(pricing.holidays)
  let snapshot = null
  let inFlight = null
  let official = null

  /** Serialize concurrent refreshes so a burst of polls folds the logs once. */
  function refreshOnce() {
    if (!inFlight) {
      inFlight = (async () => {
        const status = await aggregator.refresh()
        // Re-read pricing every pass so an edit applies without a restart.
        pricing = readPricing(pricingPaths)
        rules = resolveHolidayRules(pricing.holidays)
        return status
      })().finally(() => {
        inFlight = null
      })
    }
    return inFlight
  }

  /**
   * The sync state the panel reads: configuration, lock ownership, and the last run's outcome.
   *
   * The configuration is **rebuilt field by field** rather than spread. A spread would forward whatever a
   * hand-edited `sync.json` happens to contain — and an older build of this plugin wrote exactly such a
   * field, `password`, in plaintext. A blacklist that removes `ha1` and forwards everything else is one
   * forgotten key away from putting a credential in an HTTP response.
   */
  function safeSyncConfig(config = {}) {
    const ha1 = String(config.ha1 ?? '')
    return {
      enabled: Boolean(config.enabled),
      url: String(config.url ?? ''),
      username: String(config.username ?? ''),
      realm: String(config.realm ?? ''),
      allowInsecureTls: Boolean(config.allowInsecureTls),
      deviceId: String(config.deviceId ?? ''),
      deviceLabel: String(config.deviceLabel ?? ''),
      windowYears: Number(config.windowYears) || 0,
      instanceId: String(config.instanceId ?? ''),
      hasCredential: Boolean(ha1),
      // Only a real HA1 counts. `password` and `passwordHash` are fields an older build could leave behind,
      // and `connect()` cannot use either — claiming a credential exists would enable 立即同步 and then
      // fail with "no WebDAV credential is configured" the moment it was pressed.
      credentialPrefix: ha1.length >= 16 ? `${ha1.slice(0, 6)}…` : '',
    }
  }

  function conflictFiles() {
    try {
      return readdirSync(dataDir).filter((name) => name.startsWith('.conflict-'))
    } catch {
      return []
    }
  }

  /** The devices the **server** holds, remembered between polls. Never a network call. */
  let knownRemote = null
  /** How long that answer is reused: the panel polls every 2s while a run is in flight. */
  const REMOTE_CACHE_MS = 30_000

  async function refreshRemoteDevices() {
    if (!system?.engine?.store || !system.engine.config.enabled) return
    if (system.syncAbort) return
    if (system.remoteInFlight) return
    system.remoteInFlight = true
    try {
      const client = system.engine.connect()
      knownRemote = { devices: await system.engine.discover(client), at: Date.now() }
    } catch (error) {
      // A site the panel can show as "unknown" is better than an exception on every poll.
      knownRemote = { devices: null, at: Date.now(), error: String(error?.message ?? error) }
    } finally {
      system.remoteInFlight = false
    }
  }

  /**
   * Every piece of work that talks to the server goes through one queue.
   *
   * The owner lock keeps two **processes** apart; inside one process it cannot, because the host holds it for
   * its whole life. Without this, 立即同步 and the automatic price push run as two independent chains: a run's
   * `PROPFIND` and a push's `GET pricing.json` would already be interleaving on the wire (measured), and both
   * mutate the same `engine.state` and rewrite `sync.json`, so whichever finishes last decides what the panel
   * says about the other.
   */
  function enqueue(instance, work) {
    const next = (instance.chain ?? Promise.resolve()).then(work, work)
    // The chain must survive a rejection — neither breaking on it nor leaving it unhandled.
    instance.chain = next.then(
      () => {},
      () => {},
    )
    return next
  }

  async function syncStatus() {
    // Reading the status must not create anything either, so an untouched install answers with the
    // sensible defaults rather than acquiring a lock it has no intention of using.
    if (!system) {
      const document = readSyncDocument(dataDir, log)
      return {
        config: safeSyncConfig({ ...document, hasCredential: Boolean(document.ha1 || document.passwordHash || document.password) }),
        writable: true,
        lock: null,
        running: false,
        last: {
          result: document.state?.lastResult || 'never',
          message: document.state?.message ?? '',
          at: Number(document.state?.lastSyncAt) || 0,
        },
        collision: document.state?.collision ?? null,
        remoteDevices: {},
        // `null` rather than `{}`: nothing has asked the server yet, and an empty map would read as "there
        // are no other devices".
        remoteKnown: false,
        remoteError: null,
        published: {},
        conflictFiles: conflictFiles(),
        paths: { sync: join(dataDir, 'sync.json'), pricing: pricingPath },
      }
    }
    const { engine, lock, running, last } = system
    const pulled = {}
    for (const context of Object.keys(engine.state.held ?? {})) {
      const device = context.split('/')[0]
      pulled[device] = (pulled[device] ?? 0) + 1
    }
    // The count of shards this device has actually read, and the names the server holds, are two
    // different questions. The panel shows both: "已同步到的月份" from `held`, and "服务器上的设备" from
    // this list, so a device that published but was never pulled from still shows up. Refreshed at most
    // every `REMOTE_CACHE_MS` — the panel polls during a run, and a `PROPFIND` per poll would be a lot of
    // requests for a list that changes when someone else syncs.
    if (!knownRemote || Date.now() - (knownRemote.at ?? 0) > REMOTE_CACHE_MS) void refreshRemoteDevices()
    return {
      config: safeSyncConfig(engine.config),
      writable: Boolean(engine.store),
      lock: lock.acquired ? null : { reason: lock.reason, owner: lock.owner ?? null, pid: process.pid },
      running: Boolean(running),
      last,
      collision: engine.state.collision ?? null,
      remoteDevices: pulled,
      remoteKnown: Boolean(knownRemote?.devices),
      remoteError: knownRemote?.error ?? null,
      remoteDevicesOnServer: knownRemote?.devices ?? null,
      published: engine.state.published ?? {},
      conflictFiles: conflictFiles(),
      paths: { sync: join(dataDir, 'sync.json'), pricing: pricingPath },
    }
  }

  /**
   * Run one sync, at most one at a time.
   *
   * The host owns the lock for as long as it lives, so an automatic pricing push that lands mid-run
   * waits on the same chain rather than racing it — two writers on one data directory is the case the
   * lock exists for, and a lock cannot serialise work inside a single process.
   */
  function runSync() {
    const instance = syncSystem()
    if (!instance.running) {
      instance.running = enqueue(instance, async () => {
        if (!instance.engine.store) {
          // The cache is read-only here (another instance holds the lock, a permission problem, a newer
          // schema). The sync would publish a history this process cannot even fold, so it declines
          // rather than doing half of it.
          return { result: 'locked', message: instance.lock.reason ?? 'the cache is read-only here', at: 0 }
        }
        try {
          await refreshOnce()
        } catch (error) {
          // Refreshing is what makes the store worth publishing; without it there is nothing to send. A
          // rejection here used to escape the route and the startup timer as an unhandled rejection.
          return { result: 'failed', message: `could not fold the logs: ${error?.message ?? error}`, at: 0 }
        }
        // The system already owns the lock from the moment it was created; taking it again in the same
        // process would see this process's own lock file and refuse. It is re-acquired only when the
        // system was created without one (a second instance that lost the race).
        const attempt = instance.lock?.acquired
          ? instance.lock
          : acquireLock(dataDir, { instanceId: instance.instanceId, log })
        if (!attempt.acquired) return { result: 'locked', message: attempt.reason, at: 0 }
        try {
          const result = await instance.engine.run({ lock: attempt })
          // A shard may have carried a newer price table; the panel's next poll should see it.
          pricing = readPricing(pricingPaths)
          rules = resolveHolidayRules(pricing.holidays)
          // The engine's own record of when this happened, not "now": `locked` and `skipped` deliberately
          // leave `lastSyncAt` alone, and showing a fresh timestamp for them would claim a sync that did
          // not happen.
          return { ...result, at: Number(instance.engine.state.lastSyncAt) || 0 }
        } catch (error) {
          // `SyncEngine.run` catches its own failures; this is the belt to its braces, so a bug there
          // cannot take the host half down.
          log(`sync failed unexpectedly: ${error?.message ?? error}`)
          return { result: 'failed', message: String(error?.message ?? error), at: 0 }
        }
        // Nothing to release: the lock belongs to the system and lives as long as this process does.
      })
        .then((result) => {
          instance.last = { result: result.result, message: result.message, at: result.at ?? 0 }
          return result
        })
        .finally(() => {
          instance.running = null
        })
    }
    return instance.running
  }

  async function getSnapshot() {
    const status = await refreshOnce()
    // Nothing changed and the previous payload is still fresh: reuse it rather
    // than re-costing every day on each poll.
    if (snapshot && status.folded === 0 && Date.now() - snapshot.generatedAt < SNAPSHOT_TTL_MS) return snapshot
    // The year list is the one thing here that comes from the store rather than from memory, so a
    // store that cannot answer must not take the badge down with it: every number in the payload is
    // already in hand, and the picker simply has nothing to offer.
    let years = []
    try {
      years = store.years()
    } catch (error) {
      log(`cache year list failed: ${error?.message ?? error}`)
    }
    snapshot = buildSnapshot(aggregator, pricing, rules, status, years)
    return snapshot
  }

  /** Fetch a price list, reusing a very recent one so a reopen cannot hammer the site. */
  async function officialPricing(source, { refresh = false } = {}) {
    const key = OFFICIAL_SOURCES[source] ? source : 'zh-cn'
    if (!refresh && official && official.key === key && Date.now() - official.at < OFFICIAL_TTL_MS) return official.value
    const value = await fetchOfficialPricing({ source: key })
    official = { key, at: Date.now(), value }
    return value
  }

  /** Write a pricing document through and refresh everything derived from it. */
  function commitPricing(next) {
    mkdirSync(dataDir, { recursive: true })
    writeFileAtomic(pricingPath, JSON.stringify(next, null, 2) + '\n')
    pricing = normalizePricing(next)
    rules = resolveHolidayRules(pricing.holidays)
    snapshot = null // force a rebuild on the next read
    // The price table is the one hand-written thing this plugin owns, so an edit is worth publishing
    // while the person is still looking at the page. It is fire-and-forget: a sync that cannot reach
    // the server must never make a local edit fail, and the state it leaves behind is what the panel
    // reports.
    schedulePricingPush()
  }

  /**
   * Publish just the price table, a moment after the last edit.
   *
   * Debounced because editing a row and then the one below it is one intention, not two publishes, and
   * because the fetch it needs would otherwise happen on every keystroke-sized save. It only ever runs
   * when sync was already configured and enabled: a local edit is not a reason to create `sync.json`.
   */
  let pricingPushTimer = null
  function schedulePricingPush() {
    const configured = system ? system.engine.config : readSyncDocument(dataDir, log)
    if (!configured.enabled || !configured.url || !configured.ha1) return
    if (pricingPushTimer) clearTimeout(pricingPushTimer)
    pricingPushTimer = setTimeout(() => {
      pricingPushTimer = null
      const instance = syncSystem()
      if (!instance.lock?.acquired || !instance.engine.store) return
      // Onto the **same** queue as a full run, so an edit landing mid-sync waits for it instead of
      // interleaving its PUTs and its `sync.json` write with the run's.
      instance.pushing = enqueue(instance, () => instance.engine.pushPricing({ lock: instance.lock, instanceId: instance.instanceId }))
        .then((result) => {
          log(`pricing pushed after an edit: ${result.result} — ${result.status}`)
          instance.last = { result: result.result, message: `prices: ${result.status}`, at: result.result === 'ok' ? Number(instance.engine.state.lastSyncAt) || 0 : instance.last?.at ?? 0 }
          return result
        })
        .catch((error) => {
          log(`pricing push failed: ${error?.message ?? error}`)
          instance.last = { result: 'failed', message: `prices: ${error?.message ?? error}`, at: instance.last?.at ?? 0 }
        })
    }, delayFor('DSH_USAGE_BADGE_PRICING_PUSH_MS', PRICING_PUSH_DELAY_MS))
    pricingPushTimer.unref?.()
  }

  /**
   * The first automatic sync, a little after startup.
   *
   * Deliberately conditional: it only runs when sync is **already configured and enabled**, so a home
   * that never turned sync on stays untouched (no `sync.json`, no lock, no network). The delay exists so
   * the cold fold and the first panel paint come first — a sync on the way up would compete with the
   * work that makes the badge show anything at all.
   *
   * It is also skipped when the instance is not the writer: on a second DSH instance the lock belongs to
   * the first, and the honest answer is to do nothing rather than take the lock away from it.
   */
  function scheduleStartupSync(delayMs = delayFor('DSH_USAGE_BADGE_STARTUP_SYNC_MS', STARTUP_SYNC_DELAY_MS)) {
    const configured = readSyncDocument(dataDir, log)
    if (!configured.enabled || !configured.url || !configured.ha1) return
    const timer = setTimeout(() => {
      startupSyncTimer = null
      const instance = syncSystem()
      if (!instance.lock?.acquired) {
        log(`startup sync skipped: ${instance.lock?.reason ?? 'no lock'}`)
        return
      }
      void runSync().then((result) => log(`startup sync: ${result.result} — ${result.message}`))
    }, delayMs)
    timer.unref?.()
    startupSyncTimer = timer
  }
  let startupSyncTimer = null

  async function warm() {
    try {
      const status = await refreshOnce()
      // The SQLite store has already committed every session it folded; the JSON fallback
      // batches, and a short-lived host would otherwise pay the full cold scan on every start.
      aggregator.flush()
      log(
        `ready: ${aggregator.sessionCount} session(s) over ${status.files} log(s), folded ${status.folded} in ${status.ms}ms` +
          `; cache: ${store.kind}` +
          (rules.enabled ? `; holiday calendar on (${rules.holidays.size} holidays)` : ''),
      )
      if (rules.missingYears?.length) {
        log(`holiday calendar has no data for ${rules.missingYears.join(', ')} — those days are treated as ordinary weekdays`)
      }
    } catch (error) {
      log(`initial fold failed: ${error?.message ?? error}`)
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'

    try {
      if (route === '/summary' && (req.method === 'GET' || req.method === 'HEAD')) {
        sendJson(res, 200, await getSnapshot())
        return
      }

      // One calendar year, by month. Read straight from the store rather than from the
      // snapshot, because a year older than the loading window is not in memory at all — and
      // it is the store that knows which years exist in the first place.
      if (route === '/year' && (req.method === 'GET' || req.method === 'HEAD')) {
        const year = String(url.searchParams.get('year') ?? '')
        if (!/^\d{4}$/.test(year)) {
          sendJson(res, 400, { error: `year must be a four-digit calendar year, got ${JSON.stringify(year)}` })
          return
        }
        const records = store.load({ since: `${year}-01-01`, until: `${year}-12-31` })
        const dayRows = mergeRecords(records)
        sendJson(res, 200, summarizeYear(dayRows, pricing, rules, year))
        return
      }

      if (route === '/config' && req.method === 'GET') {
        const calendar = describeCalendar(rules)
        // The bundled table is reported separately from the resolved rules: a
        // deployment with the calendar off still needs to see what data is
        // available before deciding to switch it on.
        const bundled = loadBundledTable()
        // Read once: both the path the table came from and whether it carries a usable
        // `default` row, which decides whether that row is the user's or the template's.
        const raw = readRawPricing(pricingPaths)
        const rawDefault = raw.raw?.default
        // A row only counts when it actually says something: `{}` (or a non-object, which a hand
        // edit can leave) still takes every rate from the template, and reporting that as the
        // user's row is the silent-template problem this field exists to avoid. The panel clears
        // all four inputs to `{}` if a save is allowed to, so this is reachable from the UI too.
        const hasDefaultRow = Boolean(rawDefault) && typeof rawDefault === 'object' && Object.keys(rawDefault).length > 0
        sendJson(res, 200, {
          effective: pricing,
          template: DEFAULT_TEMPLATE,
          // The handshake the panel checks before trusting a button: see HOST_API_VERSION.
          apiVersion: HOST_API_VERSION,
          // Where the `default` row comes from. A table with no `default` row of its own
          // is priced by the built-in template, and the panel has to say so rather than
          // present those rates as the user's.
          defaultSource: hasDefaultRow ? 'file' : 'template',
          // The row exactly as the file has it, which is what the editor shows and seeds from.
          // `effective.default` is the template-merged view, and writing *that* back would
          // materialise template fields nobody wrote — a field the user just cleared would
          // look like it had come back on the next save.
          defaultRow: hasDefaultRow ? rawDefault : null,
          calendar,
          bundled: {
            years: [...bundled.years].sort(),
            holidayCount: bundled.holidays.size,
            workdayCount: bundled.workdays.size,
            source: bundled.source,
            note: bundled.note,
          },
          holidayTable: {
            years: [...bundled.years].sort(),
            holidays: [...rules.holidays.keys()].sort(),
            // Recorded for audit only: the published policy makes every weekend
            // off-peak, so a 调休 working day does not change any price.
            workdays: [...bundled.workdays].sort(),
            source: rules.source,
          },
          paths: {
            dataDir,
            pricing: pricingPath,
            // The cache file this runtime is using, whichever backend that turned out to be.
            cache: store.path,
            cacheKind: store.kind,
            legacyPricing: legacyPricingPath,
            // Which file the effective table was actually read from; null means
            // neither exists, so the built-in template is in force.
            pricingSource: raw.path,
          },
        })
        return
      }

      if (route === '/config' && (req.method === 'PUT' || req.method === 'POST')) {
        if (!isLoopback(req)) {
          sendJson(res, 403, { error: 'config writes are accepted from loopback clients only' })
          return
        }
        const patch = await readJsonBody(req)
        commitPricing(mergeConfig(readRawPricing(pricingPaths).raw, patch))
        log('pricing config updated')
        sendJson(res, 200, { ok: true, effective: pricing, calendar: describeCalendar(rules) })
        return
      }

      // The published price list, parsed. `refresh=1` is what "fetch it live when
      // the panel opens" sends; without it a very recent result is reused.
      if (route === '/official-pricing' && req.method === 'GET') {
        const source = url.searchParams.get('source') ?? 'zh-cn'
        const parsed = await officialPricing(source, { refresh: url.searchParams.get('refresh') === '1' })
        sendJson(res, 200, { ...parsed, sources: OFFICIAL_SOURCES })
        return
      }

      if (route === '/official-pricing/apply' && (req.method === 'PUT' || req.method === 'POST')) {
        if (!isLoopback(req)) {
          sendJson(res, 403, { error: 'config writes are accepted from loopback clients only' })
          return
        }
        const body = await readJsonBody(req)
        // Apply the copy the user was looking at, reusing the recent fetch rather
        // than pulling a possibly different page under them.
        const parsed = await officialPricing(body.source ?? 'zh-cn')
        const base = readRawPricing(pricingPaths)
        const { document, applied } = applyOfficialPricing(base.raw, parsed)
        // Report the shape change: applying the official list must only touch the
        // rows it names, so a shrinking override set means the base document was not
        // read and the user's own rows are about to be lost. That is worth a loud
        // line rather than a silent overwrite.
        const before = Object.keys(base.raw?.overrides ?? {}).length
        const after = Object.keys(document.overrides ?? {}).length
        const warning =
          after < before
            ? ` WARNING: override rows dropped ${before} -> ${after}; base read from ${base.path ?? 'no file (defaults)'}`
            : ''
        commitPricing(document)
        log(
          `official prices applied: ${applied.models.join(', ')}${applied.aliases.length ? ` (+ ${applied.aliases.join(', ')})` : ''};` +
            ` override rows ${before} -> ${after}` +
            (applied.defaultFrom ? `; default row filled from the first published line, ${applied.defaultFrom}` : '') +
            warning,
        )
        sendJson(res, 200, { ok: true, applied, effective: pricing, calendar: describeCalendar(rules) })
        return
      }

      // ── cloud sync ──────────────────────────────────────────────────────────
      //
      // The panel's third tab. The credential never travels back: `ha1` is reported as a short prefix
      // plus a `hasCredential` flag, so the state of "is one configured" is visible without the secret
      // leaving the host half.
      if (route === '/sync' && req.method === 'GET') {
        // Loopback only, like every other sync route. The answer names the server and the account, and
        // reading it *is* engaging with sync — this is where the system comes into being, and with it the
        // owner lock. A page that never opens this tab still touches nothing.
        if (!isLoopback(req)) {
          sendJson(res, 403, { error: 'the sync status is visible to loopback clients only' })
          return
        }
        syncSystem()
        let body
        try {
          body = await withTimeout(syncStatus(), STATUS_TIMEOUT_MS, 'reading the sync status')
        } catch (error) {
          sendJson(res, 200, { error: String(error?.message ?? error) })
          return
        }
        sendJson(res, 200, body)
        return
      }

      if (route === '/sync' && (req.method === 'PUT' || req.method === 'POST')) {
        if (!isLoopback(req)) {
          sendJson(res, 403, { error: 'sync writes are accepted from loopback clients only' })
          return
        }
        const instance = syncSystem()
        const patch = await readJsonBody(req)
        const config = {}
        for (const field of ['enabled', 'url', 'username', 'allowInsecureTls', 'deviceLabel', 'deviceId', 'realm']) {
          if (patch[field] !== undefined) config[field] = patch[field]
        }
        if (patch.windowYears !== undefined) config.windowYears = Math.max(0, Math.min(50, Number(patch.windowYears) || 0))
        if (typeof patch.deviceId === 'string' && patch.deviceId !== '') {
          try {
            config.deviceId = safeDeviceId(patch.deviceId)
          } catch (error) {
            sendJson(res, 400, { error: error.message })
            return
          }
        }
        // Either a plaintext password (hashed here, immediately, and never stored) or an HA1 someone
        // pasted in — the same value the server keeps in its password file.
        //
        // The realm is part of the digest input, so it has to be right before the password can be hashed.
        // The panel does not offer it as a field: a person has no reason to care, and the servers this is
        // built for use `WebDAV`. So it defaults here rather than being demanded — requiring it made
        // "fill in address/user/password and press 保存" fail with a sentence about a term the UI never
        // showed. A connection test replaces the guess with the realm the server actually announced.
        if (typeof patch.password === 'string' && patch.password !== '') {
          const username = String(patch.username ?? instance.engine.config.username ?? '')
          const realm = String(patch.realm ?? instance.engine.config.realm ?? '').trim() || 'WebDAV'
          if (!username) {
            sendJson(res, 400, { error: 'a username is needed to hash the password' })
            return
          }
          config.ha1 = createHash('md5').update(`${username}:${realm}:${patch.password}`).digest('hex')
          config.realm = realm
        } else if (typeof patch.ha1 === 'string' && /^[0-9a-f]{32}$/i.test(patch.ha1)) {
          config.ha1 = patch.ha1.toLowerCase()
        }
        if (typeof config.url === 'string' && config.url !== '') {
          // The **same** judgement the client makes, from the same function. A copy here is what let the
          // route accept a query string, embedded credentials and `ftp:` — addresses the client refuses —
          // so the panel stored one, showed it, and the sync could not run at all. Two copies of a rule
          // drift; one copy cannot.
          const judged = normalizeWebdavUrl(config.url)
          if (!judged.ok) {
            sendJson(res, 400, { error: judged.reason })
            return
          }
          // The trailing slash is **added** rather than demanded: someone typing `host:port` means the
          // collection at that address. The panel stores what this returns, so the field ends up showing
          // the address that will actually be used instead of the one that was typed.
          config.url = judged.url
        }
        instance.engine.save({ config })
        log(`sync configuration updated (${instance.engine.config.enabled ? 'on' : 'off'}, device ${instance.engine.config.deviceId})`)
        sendJson(res, 200, { ok: true, ...(await syncStatus()) })
        return
      }

      // A connection check: it must not sync, and it must not write anything anywhere.
      if (route === '/sync/test' && req.method === 'POST') {
        if (!isLoopback(req)) {
          sendJson(res, 403, { error: 'sync writes are accepted from loopback clients only' })
          return
        }
        // The client is kept across the catch so a **failure** can still report the realm the server
        // announced. That realm is the missing piece when someone's server does not use `WebDAV`: the
        // password was hashed against the default, so nothing can work until it is re-hashed against the
        // real one — and without this the panel had no way to learn it.
        let client = null
        try {
          client = syncSystem().engine.connect()
          const options = await client.options()
          const devices = await syncSystem().engine.discover(client)
          sendJson(res, 200, {
            ok: true,
            realm: options.realm,
            dav: options.dav,
            devices,
            insecure: Boolean(client.insecureWarning),
            warning: client.insecureWarning ?? null,
          })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message ?? error), realm: client?.challenge?.realm ?? null })
        }
        return
      }

      if (route === '/sync/run' && req.method === 'POST') {
        if (!isLoopback(req)) {
          sendJson(res, 403, { error: 'sync writes are accepted from loopback clients only' })
          return
        }
        const result = await runSync()
        sendJson(res, 200, { ok: result.result === 'ok' || result.result === 'partial', ...result, ...(await syncStatus()) })
        return
      }

      sendJson(res, 404, { error: `no such usage-badge route: ${route}` })
    } catch (error) {
      // A caller's mistake is reported as one; only genuinely unexpected failures are 500s.
      const status = Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 500 ? Number(error.statusCode) : 500
      if (status === 500) log(`request failed: ${error?.message ?? error}`)
      sendJson(res, status, { error: String(error?.message ?? error) })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle }),
    'usage-badge: summary, config and official-pricing routes',
  )

  ctx.effect(() => {
    // The delay is read **here**, synchronously, rather than inside the warm-up callback: warming is
    // asynchronous, and a value read after it would be whatever the environment holds by then — which a
    // test that sets an override for exactly this mount would already have taken away.
    const startupDelay = delayFor('DSH_USAGE_BADGE_STARTUP_SYNC_MS', STARTUP_SYNC_DELAY_MS)
    // Unloading before the first fold finishes used to schedule the first sync *after* the unload: the
    // callback ran anyway, took the lock back, and synced through a store that had already been closed
    // (`statement has been finalized`), leaving a lock file behind for a host that was gone.
    let disposed = false
    void warm().then(() => {
      if (disposed) return
      scheduleStartupSync(startupDelay)
      // Fire and forget: this only fills in what the server holds, for the panel's next read.
      void refreshRemoteDevices()
    })
    return () => {
      disposed = true
      // Any pending automatic work is dropped on unload: a push that fires while the host is going away
      // would write state for a process that no longer exists.
      if (pricingPushTimer) clearTimeout(pricingPushTimer)
      if (startupSyncTimer) clearTimeout(startupSyncTimer)
      // **And the lock is handed back.** Not releasing it leaves `host.lock` naming this dead process, and a
      // re-mount inside the same process — a hot reload, or a test mounting the same home twice — is then
      // refused by this plugin's own lock, for a pid that is very much alive: its own.
      //
      // `engine.release()` alone is not enough: a run in flight was handed the host's lock object, and the
      // engine only releases one it acquired itself (`ownsLock`), so unloading mid-run would leave the file
      // behind. `releaseLock` checks the pid, so this can only ever remove our own.
      if (system) {
        system.syncAbort = true
        // Stops a run at its next step boundary. Requests already on the wire finish; the phases that would
        // touch the store do not start.
        system.engine.abort()
        system.engine.release()
        if (system.running) log('unloading while a sync is in flight; it stops at its next step boundary')
      }
      releaseLock(dataDir)
      aggregator.close()
    }
  }, 'usage-badge: warm the fold, schedule the first sync, and close the cache on unload')

  log(`mounted on ${ROUTE_PREFIX} (home: ${home}; data: ${dataDir})`)
}
