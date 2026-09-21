/**
 * dsh-usage-badge — pricing model and cost math.
 *
 * Ported from the DeepSeek-Harness desktop shell's `usage-sidecar.mjs` so that an
 * existing `$DSH_HOME/storages/usage-pricing.json` keeps behaving identically:
 * the same four override-key shapes (model / provider|model / provider|* / *|model),
 * the same case-insensitive key matching, and the same per-request application of
 * the model multiplier, the context-length tier and the peak/valley rule.
 *
 * Naming note: every cost function here returns an amount in the *total currency*
 * (`totalCurrency`, CNY by default), not necessarily USD — the sidecar inherited
 * the misleading `usageCostUsd` name, which this port drops.
 *
 * @module dsh-usage-badge/pricing
 */

/** The price fields resolved per (provider, model). */
export const PRICE_KEYS = ['inputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion', 'outputPerMillion']

/**
 * Written to `usage-pricing.json` on first run (only when the file is missing) so
 * a fresh install starts from a working table instead of zero prices. Mirrors the
 * shell's template.
 */
export const DEFAULT_TEMPLATE = {
  exchangeRate: 6.74,
  default: {
    inputPerMillion: 1.5,
    cacheReadPerMillion: 0.05,
    cacheWritePerMillion: 0,
    outputPerMillion: 4.5,
    currency: 'cny',
  },
  totalCurrency: 'cny',
  multiplier: 1,
  overrides: {
    'deepseek-v4-flash': {
      inputPerMillion: 1.5,
      cacheReadPerMillion: 0.05,
      cacheWritePerMillion: 0,
      outputPerMillion: 4.5,
      currency: 'cny',
      multiplier: 1,
      timeOfUse: {
        enabled: true,
        peakMultiplier: 2,
        valleyMultiplier: 1,
        peakRanges: [[9, 12], [14, 18]],
        days: 'weekday',
      },
    },
    'deepseek-v4-pro': {
      inputPerMillion: 4.5,
      cacheReadPerMillion: 0.15,
      cacheWritePerMillion: 0,
      outputPerMillion: 13.5,
      currency: 'cny',
      multiplier: 1,
      timeOfUse: {
        enabled: true,
        peakMultiplier: 2,
        valleyMultiplier: 1,
        peakRanges: [[9, 12], [14, 18]],
        days: 'weekday',
      },
    },
  },
}

/**
 * Normalize a parsed pricing document, applying the template only as a *default
 * row* fallback. Override rows are the user's explicit set and are never merged
 * back from the template — otherwise a model the user deleted would silently
 * reappear.
 *
 * @param {unknown} raw - parsed JSON, or anything when the file is unreadable.
 * @returns {object} a pricing document safe for the cost functions.
 */
export function normalizePricing(raw) {
  const user = raw && typeof raw === 'object' ? raw : {}
  return {
    exchangeRate: Number(user.exchangeRate) || DEFAULT_TEMPLATE.exchangeRate,
    default: { ...DEFAULT_TEMPLATE.default, ...(user.default ?? {}) },
    overrides: user.overrides && typeof user.overrides === 'object' ? user.overrides : {},
    timeOfUse: user.timeOfUse,
    multiplier: user.multiplier ?? DEFAULT_TEMPLATE.multiplier,
    contextMultiplier: user.contextMultiplier,
    totalCurrency: user.totalCurrency ?? DEFAULT_TEMPLATE.totalCurrency,
    // The legal-holiday calendar the peak/valley rule consults; a separate field
    // from `timeOfUse` because it says which days peak windows may apply to at all.
    holidays: user.holidays,
  }
}

/**
 * Match keys for one request, in resolution priority order: a pure model name
 * (no provider) wins, then the exact `provider|model`, then the `provider|*` and
 * `*|model` wildcards. This lets a single row like `"deepseek-v4-flash"` apply to
 * every provider.
 *
 * @param {string|null} provider - provider id as recorded in the session log.
 * @param {string|null} model - model id as recorded in the session log.
 * @returns {string[]} candidate override keys, highest priority first.
 */
export function matchKeys(provider, model) {
  const keys = []
  if (model) keys.push(model)
  if (provider && model) keys.push(`${provider}|${model}`)
  if (provider) keys.push(`${provider}|*`)
  if (model) keys.push(`*|${model}`)
  return keys
}

const hasOwnKey = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

/**
 * Lowercase → authored-key index, memoized per pricing object.
 *
 * Override rows are matched case-insensitively because a model id reaches us
 * spelled exactly as the session log records it, while the price row is typed by
 * hand: a row named `deepSeek-flash` must still price the model `deepseek-flash`,
 * and the same holds for both sides of `provider|model`. Precedence stays
 * predictable: an exact key always wins, otherwise the first row whose lowercased
 * key matches is used.
 */
const lowerOverrideKeys = new WeakMap()

function overrideKeysByLower(pricing) {
  const rows = pricing.overrides
  if (!rows) return new Map()
  let index = lowerOverrideKeys.get(rows)
  if (!index) {
    index = new Map()
    for (const key of Object.keys(rows)) {
      const lower = key.toLowerCase()
      if (!index.has(lower)) index.set(lower, key)
    }
    lowerOverrideKeys.set(rows, index)
  }
  return index
}

/** The override row for one match key, or undefined when no row applies. */
function overrideRow(pricing, key) {
  const rows = pricing.overrides
  if (!rows) return undefined
  if (hasOwnKey(rows, key)) return rows[key]
  const actual = overrideKeysByLower(pricing).get(String(key).toLowerCase())
  return actual === undefined ? undefined : rows[actual]
}

/**
 * Resolve the four price fields for one route.
 *
 * Each field is resolved independently: the highest-priority row that *defines*
 * that field wins, so a `provider|model` row may override just the output price
 * while inheriting the rest from a broader row or the default row.
 */
export function resolvePrice(pricing, provider, model) {
  const out = {}
  for (const k of PRICE_KEYS) {
    out[k] = Number(pricing.default?.[k]) || 0
    for (const key of matchKeys(provider, model)) {
      const row = overrideRow(pricing, key)
      if (row && row[k] != null) {
        out[k] = Number(row[k]) || 0
        break
      }
    }
  }
  return out
}

/** Per-model peak/valley rule: the first matching row's own rule, else the global one. */
export function modelTimeOfUse(pricing, provider, model) {
  for (const key of matchKeys(provider, model)) {
    const row = overrideRow(pricing, key)
    if (row && row.timeOfUse) return row.timeOfUse
  }
  return pricing.timeOfUse
}

/** Per-model multiplier applied to the whole request cost (row wins, else global, default 1). */
export function modelMultiplier(pricing, provider, model) {
  for (const key of matchKeys(provider, model)) {
    const row = overrideRow(pricing, key)
    if (row && row.multiplier != null) return Number(row.multiplier) || 1
  }
  return Number(pricing.multiplier) || 1
}

/** Per-model context-length tier rule (row wins, else the default-row rule). */
export function modelContextMultiplier(pricing, provider, model) {
  for (const key of matchKeys(provider, model)) {
    const row = overrideRow(pricing, key)
    if (row && row.contextMultiplier != null) return row.contextMultiplier
  }
  return pricing.contextMultiplier
}

/** The currency a route's prices are quoted in (`cny` unless the row says otherwise). */
export function resolveCurrency(pricing, provider, model) {
  for (const key of matchKeys(provider, model)) {
    const row = overrideRow(pricing, key)
    if (row && row.currency) return row.currency
  }
  return pricing.default?.currency || 'cny'
}

/** The currency every summed total is expressed in. */
export function totalCurrencyOf(pricing) {
  return pricing.totalCurrency === 'usd' ? 'usd' : 'cny'
}

/**
 * Convert a cost quoted in `from` into the configured total currency. Same-currency
 * conversion is a no-op, so an all-CNY table needs no exchange rate at all.
 */
export function convertCost(cost, from, pricing) {
  const total = totalCurrencyOf(pricing)
  if (from === total) return cost
  const rate = Number(pricing.exchangeRate) || 1
  return from === 'cny' ? cost / rate : cost * rate
}

/** Cost of one token bucket at one resolved price, before any multiplier. */
export function tokenCost(tokens, price) {
  return (
    ((Number(tokens.input) || 0) / 1e6) * price.inputPerMillion +
    ((Number(tokens.cacheRead) || 0) / 1e6) * price.cacheReadPerMillion +
    ((Number(tokens.cacheWrite) || 0) / 1e6) * price.cacheWritePerMillion +
    ((Number(tokens.output) || 0) / 1e6) * price.outputPerMillion
  )
}

/**
 * The request's input context size used by the tiered-price rule. DSH records
 * uncached input and cache usage as disjoint values; their sum is the input
 * context its own tiered calculation uses.
 */
export function contextTokens(tokens) {
  return (Number(tokens.input) || 0) + (Number(tokens.cacheRead) || 0) + (Number(tokens.cacheWrite) || 0)
}

/**
 * Parse a token count written either as a number or as a compact string with a
 * K / M / B suffix (case-insensitive, optional whitespace): `128000`, `"128K"`,
 * `"1.5M"`, `"2b"`. Returns NaN for anything unparseable.
 */
export function parseTokenCount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  const text = String(value ?? '').trim()
  if (!text) return NaN
  const m = /^(\d+(?:\.\d+)?)\s*([kKmMbB]?)$/.exec(text)
  if (!m) return NaN
  const suffix = m[2] ? m[2].toLowerCase() : ''
  const scale = suffix === 'k' ? 1e3 : suffix === 'm' ? 1e6 : suffix === 'b' ? 1e9 : 1
  return parseFloat(m[1]) * scale
}

/** The context-tier multiplier for one request: strictly above the threshold, else 1. */
export function contextMultiplierFor(pricing, provider, model, tokens) {
  const rule = modelContextMultiplier(pricing, provider, model)
  const threshold = parseTokenCount(rule?.threshold)
  const multiplier = Number(rule?.multiplier)
  if (!Number.isFinite(threshold) || threshold <= 0 || !Number.isFinite(multiplier) || multiplier <= 0) return 1
  return contextTokens(tokens) > threshold ? multiplier : 1
}

/**
 * Cost of one per-request usage record, in the total currency. The peak/valley
 * multiplier, the model multiplier and the context tier all apply per request,
 * which is why the raw per-request records are kept rather than only aggregates.
 *
 * @param {{input:number,cacheRead:number,cacheWrite:number,output:number}} tokens - this request's usage.
 * @param {number} hour - local hour (0–23) the request was sent.
 * @param {object} day - `{ date, weekday, class, name }` of the request's day; a bare
 *   weekday number is accepted for callers that have no calendar.
 */
export function requestCost(tokens, provider, model, hour, pricing, day) {
  const context = normalizeDay(day)
  const price = resolvePrice(pricing, provider, model)
  const timeMultiplier = multiplierFor(context.weekday, hour, modelTimeOfUse(pricing, provider, model), context.class)
  const modelMultiplierValue = modelMultiplier(pricing, provider, model)
  const contextMultiplierValue = contextMultiplierFor(pricing, provider, model, tokens)
  const cost = tokenCost(tokens, price) * timeMultiplier * modelMultiplierValue * contextMultiplierValue
  return convertCost(cost, resolveCurrency(pricing, provider, model), pricing)
}

/**
 * Cost for an aggregate-shaped bucket whose per-request records are unavailable
 * (a v1 cache row). It prices the whole bucket flat at the current hour and skips
 * the context tier, matching the shell's pre-context-tier behavior.
 */
export function legacyCost(tokens, provider, model, hour, pricing, day) {
  const context = normalizeDay(day)
  const price = resolvePrice(pricing, provider, model)
  const timeMultiplier = multiplierFor(context.weekday, hour, modelTimeOfUse(pricing, provider, model), context.class)
  const cost = tokenCost(tokens, price) * timeMultiplier * modelMultiplier(pricing, provider, model)
  return convertCost(cost, resolveCurrency(pricing, provider, model), pricing)
}

/**
 * Per-hour cost array (0…23) for one bucket, in a single pass over its request
 * records so a day chart never rescans the list once per hour.
 */
export function bucketHourlyCosts(bucket, pricing, day) {
  const context = normalizeDay(day)
  const out = new Array(24).fill(0)
  if (Array.isArray(bucket.usageRecords)) {
    for (const usage of bucket.usageRecords) {
      let hour = Number.isInteger(usage?.hour) ? usage.hour : new Date().getHours()
      if (hour < 0 || hour > 23) hour = new Date().getHours()
      out[hour] += requestCost(usage, bucket.provider, bucket.model, hour, pricing, context)
    }
    return out
  }
  for (let hour = 0; hour < 24; hour++) {
    const tokens = bucket.hourly?.[hour]
    out[hour] = tokens ? legacyCost(tokens, bucket.provider, bucket.model, hour, pricing, context) : 0
  }
  return out
}

/** Total cost of one bucket in the total currency. */
export function bucketCost(bucket, pricing, day) {
  const context = normalizeDay(day)
  if (!Array.isArray(bucket.hourly) && !Array.isArray(bucket.usageRecords)) {
    return legacyCost(bucket, bucket.provider, bucket.model, new Date().getHours(), pricing, context)
  }
  let total = 0
  for (const hourCost of bucketHourlyCosts(bucket, pricing, context)) total += hourCost
  return total
}

// ── local calendar helpers ───────────────────────────────────────────────────
// Day and hour bucketing follows the host's local calendar, which is what a
// "today" figure has to mean. `offsetMinutes()` is re-read per call rather than
// cached in a module constant so a host that changes zone (or crosses DST) is
// bucketed correctly on the next pass.

/** Minutes east of UTC for the host's current local time. */
export function offsetMinutes(now = Date.now()) {
  return -new Date(now).getTimezoneOffset()
}

/** Local calendar day key (`YYYY-MM-DD`) for an epoch millisecond timestamp. */
export function dayKey(ms) {
  const d = new Date(ms + offsetMinutes(ms) * 60000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** Local hour (0–23) for an epoch millisecond timestamp. */
export function localHour(ms) {
  return new Date(ms + offsetMinutes(ms) * 60000).getUTCHours()
}

/** ISO weekday (1=Monday … 7=Sunday) from a JS Date. */
export function weekdayOf(d) {
  return ((d.getDay() + 6) % 7) + 1
}

/** ISO weekday (1=Mon … 7=Sun) of a local `YYYY-MM-DD` day key. */
export function weekdayFromDayKey(dk) {
  const [y, m, d] = String(dk).split('-').map(Number)
  return weekdayOf(new Date(y, m - 1, d))
}

/**
 * The day context every cost function prices against: the local date key, its ISO
 * weekday, and whether the holiday calendar marks it a public holiday.
 *
 * Only two classes exist, because that is all the published policy distinguishes:
 * peak hours are 周一至周五 excluding public holidays, and *every* other hour —
 * "包括周末及中国法定节假日全天" — is off-peak. A weekend the State Council turns
 * into a working day (调休) is still a 周末, so it is deliberately NOT treated as a
 * working day here; doing so would charge peak rates on a day the page calls
 * off-peak in full.
 *
 * @param {string} dateKey - local `YYYY-MM-DD` day key.
 * @param {object} [rules] - resolved holiday rules; absent means "no holiday handling".
 * @returns {{date:string, weekday:number, class:'normal'|'holiday', name:string|null}}
 */
export function dayContext(dateKey, rules) {
  const weekday = weekdayFromDayKey(dateKey)
  let cls = 'normal'
  let name = null
  if (rules?.enabled) {
    const holidayName = rules.holidays?.get?.(dateKey)
    if (holidayName !== undefined) {
      cls = 'holiday'
      name = holidayName || null
    }
  }
  return { date: dateKey, weekday, class: cls, name }
}

/** A fresh 24-slot hourly token/request series. */
export function initHourly() {
  return Array.from({ length: 24 }, () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 }))
}

/**
 * Whether a weekday matches a `days` rule: `"all"` / `"weekday"` / `"weekend"` /
 * an array like `[1,2,3,4,5]`. A missing or unknown rule is lenient and matches
 * every day, which keeps older configs behaving exactly as they did.
 *
 * Matching is on the calendar weekday, which is what the published policy names
 * ("周一至周五"). A public holiday is handled separately, by {@link multiplierFor},
 * because it is off-peak whatever weekday it falls on.
 *
 * @param {number} weekday - ISO weekday (1=Mon … 7=Sun).
 * @param {unknown} days - the rule's `days` field.
 */
export function dayMatches(weekday, days) {
  if (days == null || days === '') return true
  if (typeof days === 'string') {
    const s = days.trim().toLowerCase()
    if (s === 'all') return true
    if (s === 'weekday' || s === 'workday') return weekday >= 1 && weekday <= 5
    if (s === 'weekend') return weekday >= 6
    return true
  }
  if (Array.isArray(days)) return days.some((d) => Number(d) === weekday)
  return true
}

/** Tolerate a bare weekday number as well as a `{ date, weekday, class }` context. */
function normalizeDay(day) {
  if (typeof day === 'number') return { date: null, weekday: day, class: 'normal', name: null }
  if (day && typeof day === 'object') return { class: 'normal', name: null, ...day }
  return { date: null, weekday: 1, class: 'normal', name: null }
}

/**
 * Peak/valley multiplier for one local hour on one day. Flat (1) when time-of-use
 * is off or the day does not match the `days` rule; the peak multiplier inside
 * `peakRanges`; the valley multiplier otherwise. The peak multiplier is a
 * surcharge and is floored at 1.
 *
 * A public holiday is off-peak for the whole day, which is DeepSeek's published
 * rule — so the holiday check comes first and overrides every `days` form.
 *
 * @param {number} weekday - ISO weekday (1=Mon … 7=Sun).
 * @param {number} hour - local hour (0–23).
 * @param {object} tou - the resolved time-of-use rule.
 * @param {'normal'|'holiday'} [dayClass] - holiday classification of the day.
 */
export function multiplierFor(weekday, hour, tou, dayClass = 'normal') {
  if (!tou || !tou.enabled) return 1
  if (dayClass === 'holiday') return 1
  if (!dayMatches(weekday, tou.days)) return 1
  for (const range of tou.peakRanges || []) {
    if (!Array.isArray(range) || range.length < 2) continue
    const [s, e] = range
    if (typeof s === 'number' && typeof e === 'number' && hour >= s && hour < e) {
      return Math.max(1, Number(tou.peakMultiplier) || 1)
    }
  }
  return Number(tou.valleyMultiplier ?? 1) || 0
}

/**
 * The peak/valley state of one day at one hour, for the panel's period indicator.
 *
 * @param {object} pricing - the normalized pricing document.
 * @param {string|null} provider - route provider, for a per-model rule lookup.
 * @param {string|null} model - route model.
 * @param {object|number} day - a `{ date, weekday, class, name }` context.
 * @param {number} [hour] - local hour to evaluate; defaults to the current hour.
 */
export function timeOfUseState(pricing, provider, model, day, hour = new Date().getHours()) {
  const context = normalizeDay(day)
  const tou = modelTimeOfUse(pricing, provider, model)
  const multiplier = multiplierFor(context.weekday, hour, tou, context.class)
  const peak = multiplier > 1
  return {
    enabled: Boolean(tou && tou.enabled),
    peak,
    label: peak ? 'peak' : 'valley',
    multiplier,
    dayClass: context.class,
    dayName: context.name ?? null,
  }
}
