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

import { createAggregator, resolveDshHome } from './fold.js'
import { describeCalendar, loadBundledTable, resolveHolidayRules } from './holidays.js'
import { OFFICIAL_SOURCES, applyOfficialPricing, fetchOfficialPricing } from './official-pricing.js'
import {
  DEFAULT_TEMPLATE,
  bucketCost,
  bucketHourlyCosts,
  dayContext,
  dayKey,
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
 * Directory under `$DSH_HOME/storages` holding every file this plugin owns, so its
 * cache and price table are never mistaken for harness data in the shared root.
 */
const DATA_DIR_NAME = 'usage-badge'

/** Calendar days retained in the payload; covers the 12-month view plus slack. */
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
      .map((row) => ({ ...row, amount: round(row.amount, 4), hourly: roundSeries(row.hourly) })),
    hourly: roundSeries(dayHours),
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

/** Build the payload the browser half renders. */
function buildSnapshot(aggregator, pricing, rules, status) {
  const now = Date.now()
  const today = dayKey(now)
  const dayObjs = aggregator.days
  const dates = [...dayObjs.keys()].sort().reverse().slice(0, DAYS_KEPT)

  const todayObj = dayObjs.get(today)
  const todaySummary = summarizeDay(todayObj, pricing, today, true, rules)

  const days = dates.map((date) => {
    // The day's own classification travels with its row: the panel marks holidays
    // on the chart, and it is the only way to read a past day's holiday status
    // back from a snapshot.
    const context = dayContext(date, rules)
    const marks = { dayClass: context.class, dayName: context.name }
    if (date === today) return { date, ...todaySummary.totals, providers: todaySummary.providers, ...marks }
    const summary = summarizeDay(dayObjs.get(date), pricing, date, false, rules)
    return { date, ...summary.totals, providers: summary.providers, ...marks }
  })

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

/** Read a request body, bounded. */
function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error('request body too large'))
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
  if (patch.default && typeof patch.default === 'object') next.default = { ...(next.default ?? {}), ...patch.default }
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
  const cachePath = join(dataDir, 'cache.json')
  /** Pre-isolation location of the price table, honored as a migration fallback. */
  const legacyPricingPath = join(home, 'storages', 'usage-pricing.json')
  const pricingPaths = [pricingPath, legacyPricingPath]

  const aggregator = createAggregator({ sessionsRoot, cachePath, log })
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
    snapshot = buildSnapshot(aggregator, pricing, rules, status)
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
      // Persist straight away rather than waiting for the debounce: the initial
      // fold is the expensive one, and its timer is unref'd, so a short-lived
      // host would otherwise pay the full cold scan on every start.
      if (status.folded > 0) aggregator.saveCache()
      log(
        `ready: ${aggregator.sessionCount} session(s) over ${status.files} log(s), folded ${status.folded} in ${status.ms}ms` +
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

      if (route === '/config' && req.method === 'GET') {
        const calendar = describeCalendar(rules)
        // The bundled table is reported separately from the resolved rules: a
        // deployment with the calendar off still needs to see what data is
        // available before deciding to switch it on.
        const bundled = loadBundledTable()
        sendJson(res, 200, {
          effective: pricing,
          template: DEFAULT_TEMPLATE,
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
            cache: cachePath,
            legacyPricing: legacyPricingPath,
            // Which file the effective table was actually read from; null means
            // neither exists, so the built-in template is in force.
            pricingSource: readRawPricing(pricingPaths).path,
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
            warning,
        )
        sendJson(res, 200, { ok: true, applied, effective: pricing, calendar: describeCalendar(rules) })
        return
      }

      sendJson(res, 404, { error: `no such usage-badge route: ${route}` })
    } catch (error) {
      log(`request failed: ${error?.message ?? error}`)
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle }),
    'usage-badge: summary, config and official-pricing routes',
  )

  ctx.effect(() => {
    void warm()
    return () => aggregator.saveCache()
  }, 'usage-badge: warm the fold and persist the cache on unload')

  log(`mounted on ${ROUTE_PREFIX} (home: ${home}; data: ${dataDir})`)
}
