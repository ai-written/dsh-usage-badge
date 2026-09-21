/**
 * dsh-usage-badge — DeepSeek's published price list.
 *
 * The official pricing page is Docusaurus server-rendered HTML, so it can be read
 * without a browser: one `<table>` holds the model columns and the price rows, and
 * the footnotes carry the policy that the price table alone does not express
 * (peak windows, their time zone, and that holidays are off-peak all day).
 *
 * Parsing a page we do not control is inherently brittle — the shape is asserted
 * and a mismatch raises a descriptive error rather than silently returning wrong
 * prices. `test/fixtures/` keeps the captured pages this parser is verified
 * against, so a change in the page shows up as a failing test.
 *
 * @module dsh-usage-badge/official-pricing
 */

/** The two published pages; the Chinese one quotes CNY and the English one USD. */
export const OFFICIAL_SOURCES = {
  'zh-cn': {
    url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
    currency: 'cny',
    label: '中文页（人民币）',
  },
  en: {
    url: 'https://api-docs.deepseek.com/quick_start/pricing',
    currency: 'usd',
    label: 'English page (USD)',
  },
}

/** Fetch timeout, so a hung docs site cannot hold a request open. */
const FETCH_TIMEOUT_MS = 15000

const decodeEntities = (text) =>
  text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")

const stripTags = (html) => decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

/** One `<tr>`'s cells, in document order. */
function parseRows(tableHtml) {
  return tableHtml
    .split(/<tr[^>]*>/i)
    .slice(1)
    .map((row) =>
      row
        .split(/<\/tr>/i)[0]
        .split(/<td[^>]*>/i)
        .slice(1)
        .map((cell) => ({
          html: cell.split(/<\/td>/i)[0],
          text: stripTags(cell.split(/<\/td>/i)[0]),
        }))
        .filter((cell) => cell.text !== '' || cell.html !== ''),
    )
}

const isPeriod = (text) => /空闲时段|高峰时段|off-?peak|^peak$/i.test(text)
const periodOf = (text) => (/空闲时段|off-?peak/i.test(text) ? 'offPeak' : 'peak')

/** Which token bucket a price row names, or null when the row is not a price row. */
function priceKindOf(text) {
  if (/缓存命中|cache\s*hit/i.test(text)) return 'cacheRead'
  if (/缓存未命中|cache\s*miss/i.test(text)) return 'input'
  if (/输出|output/i.test(text)) return 'output'
  return null
}

/** A price cell like `0.02元` or `$0.003` → its number and the currency it names. */
function parseAmount(text) {
  const match = /(\d+(?:\.\d+)?)/.exec(text)
  if (!match) return null
  const currency = /元|￥|¥|人民币/.test(text) ? 'cny' : /\$|USD/i.test(text) ? 'usd' : null
  return { value: Number(match[1]), currency }
}

/**
 * Shift published peak windows into the host's local hours.
 *
 * The Chinese page quotes 北京时间 and the English page quotes UTC for the same
 * windows, so the printed hours are only meaningful together with the zone. Since
 * the pricing config expresses `peakRanges` in local hours, the windows are
 * converted here and both forms are reported, letting the UI show "official
 * 01:00–04:00 UTC (≈ local 09:00–12:00)" instead of hiding the conversion.
 */
function toLocalRanges(ranges, sourceOffsetMinutes, localOffsetMinutes) {
  const delta = localOffsetMinutes - sourceOffsetMinutes
  const round = (value) => Math.round(value * 100) / 100
  const wrap = (minutes) => ((minutes % 1440) + 1440) % 1440
  const out = []
  for (const [start, end] of ranges) {
    let startMinutes = start * 60 + delta
    let endMinutes = end * 60 + delta

    // A window pushed entirely out of the day wraps as a whole. Only a window that
    // straddles midnight splits in two — splitting an out-of-range one instead
    // produced nonsense ranges (01:00–04:00 UTC in a UTC-5 host came out as
    // [0,23], i.e. almost the entire day at peak rates).
    if (endMinutes <= 0) {
      startMinutes += 1440
      endMinutes += 1440
    } else if (startMinutes >= 1440) {
      startMinutes -= 1440
      endMinutes -= 1440
    }

    if (startMinutes >= 0 && endMinutes <= 1440) {
      out.push([round(startMinutes / 60), round(endMinutes / 60)])
      continue
    }
    out.push([round(wrap(startMinutes) / 60), 24])
    out.push([0, round(wrap(endMinutes) / 60)])
  }
  return out.sort((a, b) => a[0] - b[0])
}

/**
 * Parse one captured or freshly fetched pricing page.
 *
 * @param {string} html - the page body.
 * @param {{url?:string, now?:number, localOffsetMinutes?:number}} [options]
 * @returns {object} the parsed prices and policy.
 * @throws {Error} when the page no longer has the expected shape.
 */
export function parseOfficialPricing(html, options = {}) {
  const url = options.url ?? OFFICIAL_SOURCES['zh-cn'].url
  const now = options.now ?? Date.now()
  const localOffsetMinutes = options.localOffsetMinutes ?? -new Date(now).getTimezoneOffset()

  const tables = html.match(/<table[^>]*>[\s\S]*?<\/table>/gi) ?? []
  const table = tables.find((candidate) => /价格|PRICING/i.test(stripTags(candidate)))
  if (!table) throw new Error('the pricing table was not found on the page (layout changed?)')

  const rows = parseRows(table)
  const modelRow = rows.find((cells) => /^(模型|MODEL)$/i.test(cells[0]?.text ?? ''))
  if (!modelRow) throw new Error('the model header row was not found in the pricing table (layout changed?)')

  // The first model may carry a `(1)` marker naming its legacy aliases.
  const models = []
  const footnotedModels = new Map()
  for (const [index, cell] of modelRow.slice(1).entries()) {
    const marker = /\((\d+)\)/.exec(cell.text)
    models.push({ model: cell.text.replace(/\(\d+\)/g, '').trim(), peak: {}, offPeak: {}, cacheWritePerMillion: 0 })
    if (marker) footnotedModels.set(Number(marker[1]), index)
  }
  if (models.length === 0 || models.some((entry) => !entry.model)) {
    throw new Error('the pricing table listed no model columns (layout changed?)')
  }

  let currency = null
  let kind = null
  let priceRows = 0
  for (const cells of rows) {
    // The period cell is located rather than assumed: the first price row carries
    // an extra leading `rowspan` cell ("价格"/"PRICING"), while the continuation
    // rows below it start straight at the period. Everything after the period cell
    // is a per-model value, and the cell just before it names the token bucket
    // when this row opens a new one.
    const periodIndex = cells.findIndex((cell) => isPeriod(cell.text))
    if (periodIndex === -1) continue
    if (periodIndex >= 1) {
      const named = priceKindOf(cells[periodIndex - 1].text)
      if (named) kind = named
    }
    if (!kind) continue
    const values = cells.slice(periodIndex + 1)
    if (values.length < models.length) {
      throw new Error(
        `a price row listed ${values.length} value(s) for ${models.length} model(s) (layout changed?)`,
      )
    }
    for (const [index, model] of models.entries()) {
      const amount = parseAmount(values[index].text)
      if (!amount) continue
      model[periodOf(cells[periodIndex].text)][kind] = amount.value
      if (amount.currency) currency = amount.currency
    }
    priceRows++
  }

  if (priceRows === 0) throw new Error('no price rows could be read from the pricing table (layout changed?)')

  for (const model of models) {
    for (const period of ['peak', 'offPeak']) {
      for (const key of ['input', 'cacheRead', 'cacheWrite', 'output']) {
        if (model[period][key] === undefined) model[period][key] = 0
      }
    }
  }

  // ── policy footnotes ───────────────────────────────────────────────────────
  const footnotes = new Map()
  for (const match of html.matchAll(/<p>\s*\((\d+)\)([\s\S]*?)<\/p>/gi)) {
    footnotes.set(Number(match[1]), match[2])
  }
  const policyHtml = [...footnotes.entries()].map(([, body]) => body).find((body) => /高峰时段|Peak hours/i.test(body))
  if (!policyHtml) throw new Error('the peak-hours footnote was not found on the page (layout changed?)')
  const policyText = stripTags(policyHtml)

  const ranges = []
  for (const match of policyText.matchAll(/(\d{1,2}):(\d{2})\s*[-–—~至]\s*(\d{1,2}):(\d{2})/g)) {
    ranges.push([Number(match[1]) + Number(match[2]) / 60, Number(match[3]) + Number(match[4]) / 60])
  }
  if (ranges.length === 0) throw new Error('no peak-hour windows could be read from the footnote (layout changed?)')

  const sourceZone = /北京时间/.test(policyText) ? { name: 'Asia/Shanghai', offsetMinutes: 480 } : /UTC/.test(policyText) ? { name: 'UTC', offsetMinutes: 0 } : null

  // Footnote (1) names the retired model ids that are still served and billed at
  // the marked model's price, so they get their own override rows.
  const [markedFootnote, markedIndex] = footnotedModels.entries().next().value ?? []
  const aliases = []
  if (markedFootnote !== undefined) {
    const footnoteHtml = footnotes.get(markedFootnote) ?? ''
    if (/legacy|旧模型名|已下线/i.test(stripTags(footnoteHtml))) {
      for (const match of footnoteHtml.matchAll(/<code>([^<]+)<\/code>/g)) {
        const name = decodeEntities(match[1]).trim()
        if (name && !models.some((model) => model.model === name)) aliases.push(name)
      }
    }
  }
  const aliasTarget = models[markedIndex ?? 0].model

  return {
    ok: true,
    url,
    fetchedAt: now,
    currency: currency ?? OFFICIAL_SOURCES['zh-cn'].currency,
    models,
    aliases: { target: aliasTarget, names: aliases },
    policy: {
      text: policyText,
      peakRangesSource: ranges,
      sourceZone,
      // Converted into the host's local hours, which is what `timeOfUse.peakRanges` means.
      peakRangesLocal: toLocalRanges(ranges, sourceZone?.offsetMinutes ?? localOffsetMinutes, localOffsetMinutes),
      localOffsetMinutes,
      offPeakIsHalfOfPeak: /一半|half of the peak/i.test(policyText),
      weekendsOffPeak: /周末|weekends/i.test(policyText),
      holidaysOffPeak: /法定节假日|public holidays/i.test(policyText),
    },
  }
}

/**
 * Fetch and parse a published pricing page.
 *
 * @param {{source?:'zh-cn'|'en', url?:string, now?:number, fetchImpl?:Function}} [options]
 * @returns {Promise<object>} the parsed result.
 */
export async function fetchOfficialPricing(options = {}) {
  const source = OFFICIAL_SOURCES[options.source] ?? OFFICIAL_SOURCES['zh-cn']
  const url = options.url ?? source.url
  const doFetch = options.fetchImpl ?? fetch
  const response = await doFetch(url, {
    headers: { 'user-agent': 'dsh-usage-badge', accept: 'text/html' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`the pricing page answered HTTP ${response.status}`)
  const html = await response.text()
  return parseOfficialPricing(html, { url, now: options.now })
}

/**
 * Build the pricing document that applying an official price list produces.
 *
 * The row price is the **off-peak** rate and the peak multiplier is 2, which is
 * the same shape the desktop shell already used and follows the page's own rule
 * that off-peak is half of peak. Applying also switches the holiday calendar on,
 * because the published peak windows are defined as excluding Chinese public
 * holidays — without it a weekday holiday would be billed at peak.
 *
 * Unknown keys in the existing document survive, so hand-written rows elsewhere
 * are not lost.
 *
 * @param {object} current - the raw user pricing document.
 * @param {object} parsed - a {@link parseOfficialPricing} result.
 * @returns {{document:object, applied:{models:string[], aliases:string[], peakRanges:number[][]}}}
 */
export function applyOfficialPricing(current, parsed) {
  const next = current && typeof current === 'object' ? { ...current } : {}
  const overrides = { ...(next.overrides ?? {}) }
  const applied = []

  const rowFor = (base) => ({
    inputPerMillion: base.offPeak.input,
    cacheReadPerMillion: base.offPeak.cacheRead,
    cacheWritePerMillion: base.offPeak.cacheWrite ?? 0,
    outputPerMillion: base.offPeak.output,
    currency: parsed.currency,
    multiplier: 1,
  })

  for (const entry of parsed.models) {
    overrides[entry.model] = { ...(overrides[entry.model] ?? {}), ...rowFor(entry) }
    applied.push(entry.model)
  }

  // Retired ids the page says are still served and billed at the same price.
  const aliasNames = []
  const target = parsed.models.find((entry) => entry.model === parsed.aliases.target) ?? parsed.models[0]
  for (const name of parsed.aliases.names ?? []) {
    overrides[name] = { ...(overrides[name] ?? {}), ...rowFor(target) }
    aliasNames.push(name)
  }

  next.overrides = overrides
  next.timeOfUse = {
    ...(next.timeOfUse ?? {}),
    enabled: true,
    days: 'weekday',
    peakMultiplier: 2,
    valleyMultiplier: 1,
    peakRanges: parsed.policy.peakRangesLocal,
  }
  if (parsed.policy.holidaysOffPeak) {
    next.holidays = { ...(next.holidays ?? {}), source: 'cn' }
  }

  return {
    document: next,
    applied: { models: applied, aliases: aliasNames, peakRanges: parsed.policy.peakRangesLocal },
  }
}
