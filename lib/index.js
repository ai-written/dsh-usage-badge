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

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createCacheStore } from './cache-store.js'
import { createAggregator, mergeRecords, resolveDshHome } from './fold.js'
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
export const HOST_API_VERSION = 6

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
  }

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
        const patch = JSON.parse((await readBody(req)) || '{}')
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
        const body = JSON.parse((await readBody(req)) || '{}')
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
    void warm()
    return () => aggregator.close()
  }, 'usage-badge: warm the fold and close the cache on unload')

  log(`mounted on ${ROUTE_PREFIX} (home: ${home}; data: ${dataDir})`)
}
