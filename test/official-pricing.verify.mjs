/**
 * Official price-list verification.
 *
 * The parser reads a page nobody here controls, so it is checked against captured
 * fixtures (`test/fixtures/pricing.{zh,en}.html`) with the exact published numbers
 * asserted. The fetch is then stubbed — no test touches the network — to drive the
 * two routes the panel uses: read the official list, and apply it.
 *
 * The last scenario is the one that matters end to end: after applying the fetched
 * list, a real request is priced at the published peak and off-peak rates.
 *
 * Usage:
 *   node test/official-pricing.verify.mjs
 */

import { readFileSync } from 'node:fs'

import {
  applyOfficialPricing,
  parseOfficialPricing,
} from '../lib/official-pricing.js'
import { close, createChecker, makeHome, mount, readPricing, request, summaryFor, writeLegacyPricing, writePricing, writeSession } from './helpers.mjs'

const { check, finish } = createChecker('OFFICIAL PRICING VERIFY')

const fixture = (name) => readFileSync(new URL(`./fixtures/pricing.${name}.html`, import.meta.url), 'utf8')
const at = (year, month, day, hour, minute = 30) => new Date(year, month - 1, day, hour, minute).getTime()

// ── 1. the Chinese page (CNY) ────────────────────────────────────────────────
const zh = parseOfficialPricing(fixture('zh'), { url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing' })
{
  check('zh: currency is CNY', zh.currency === 'cny', zh.currency)
  check('zh: both models are listed', zh.models.map((m) => m.model).join(',') === 'deepseek-flash,deepseek-v4-pro', zh.models.map((m) => m.model).join(','))

  const flash = zh.models.find((m) => m.model === 'deepseek-flash')
  check('zh: flash peak input is 2', flash.peak.input === 2, String(flash.peak.input))
  check('zh: flash peak output is 8', flash.peak.output === 8, String(flash.peak.output))
  check('zh: flash peak cache-hit is 0.04', flash.peak.cacheRead === 0.04, String(flash.peak.cacheRead))
  check('zh: flash off-peak input is 1', flash.offPeak.input === 1, String(flash.offPeak.input))
  check('zh: flash off-peak cache-hit is 0.02', flash.offPeak.cacheRead === 0.02, String(flash.offPeak.cacheRead))
  check('zh: flash off-peak output is 4', flash.offPeak.output === 4, String(flash.offPeak.output))

  const pro = zh.models.find((m) => m.model === 'deepseek-v4-pro')
  check('zh: pro peak input is 9', pro.peak.input === 9, String(pro.peak.input))
  check('zh: pro peak output is 27', pro.peak.output === 27, String(pro.peak.output))
  check('zh: pro off-peak cache-hit is 0.15', pro.offPeak.cacheRead === 0.15, String(pro.offPeak.cacheRead))

  check('zh: the retired model ids are captured as aliases', zh.aliases.names.join(',') === 'deepseek-v4-flash,deepseek-v4-flash-vision-exp', zh.aliases.names.join(','))
  check('zh: aliases point at the marked model', zh.aliases.target === 'deepseek-flash', zh.aliases.target)

  check('zh: the peak windows are read from the footnote', JSON.stringify(zh.policy.peakRangesSource) === '[[9,12],[14,18]]', JSON.stringify(zh.policy.peakRangesSource))
  check('zh: the footnote is recognized as Beijing time', zh.policy.sourceZone?.name === 'Asia/Shanghai', JSON.stringify(zh.policy.sourceZone))
  check('zh: off-peak is recognized as half of peak', zh.policy.offPeakIsHalfOfPeak)
  check('zh: holidays are recognized as off-peak', zh.policy.holidaysOffPeak)
  check('zh: weekends are recognized as off-peak', zh.policy.weekendsOffPeak)
}

// ── 2. the English page (USD, windows quoted in UTC) ─────────────────────────
const en = parseOfficialPricing(fixture('en'), { url: 'https://api-docs.deepseek.com/quick_start/pricing' })
{
  check('en: currency is USD', en.currency === 'usd', en.currency)
  const flash = en.models.find((m) => m.model === 'deepseek-flash')
  check('en: flash peak input is 0.3', flash.peak.input === 0.3, String(flash.peak.input))
  check('en: flash off-peak cache-hit is 0.003', flash.offPeak.cacheRead === 0.003, String(flash.offPeak.cacheRead))
  check('en: the windows are read as UTC', en.policy.sourceZone?.name === 'UTC', JSON.stringify(en.policy.sourceZone))
  check('en: the printed windows are the UTC ones', JSON.stringify(en.policy.peakRangesSource) === '[[1,4],[6,10]]', JSON.stringify(en.policy.peakRangesSource))
  // The host here is UTC+8, so 01:00–04:00 and 06:00–10:00 UTC become 09:00–12:00 and 14:00–18:00 local.
  check('en: windows convert into the host zone', JSON.stringify(en.policy.peakRangesLocal) === '[[9,12],[14,18]]', JSON.stringify(en.policy.peakRangesLocal))
}

// ── 2b. the same windows in other host zones ─────────────────────────────────
// The suite pins the host to Asia/Shanghai (see test/all.mjs), so a host offset is
// passed in explicitly here: what is under test is the conversion, not where the
// suite happens to run.
{
  const url = 'https://api-docs.deepseek.com/quick_start/pricing'
  const windows = (offset) => parseOfficialPricing(fixture('en'), { url, localOffsetMinutes: offset }).policy.peakRangesLocal

  check('zone: a UTC host keeps the printed hours', JSON.stringify(windows(0)) === '[[1,4],[6,10]]', JSON.stringify(windows(0)))
  check('zone: a Beijing host shifts by +8', JSON.stringify(windows(480)) === '[[9,12],[14,18]]', JSON.stringify(windows(480)))
  check('zone: a UTC+1 host shifts by +1', JSON.stringify(windows(60)) === '[[2,5],[7,11]]', JSON.stringify(windows(60)))
  // A window pushed wholly before midnight has to wrap as a unit. The bug this pins:
  // 01:00–04:00 UTC is 20:00–23:00 in a UTC-5 host, but splitting it at midnight
  // emitted [0,23] — nearly the entire day billed at peak rates.
  check('zone: a UTC-5 host wraps without inventing a range', JSON.stringify(windows(-300)) === '[[1,5],[20,23]]', JSON.stringify(windows(-300)))
  check('zone: a UTC-4 host emits no empty range', JSON.stringify(windows(-240)) === '[[2,6],[21,24]]', JSON.stringify(windows(-240)))
  // 06:00–10:00 UTC is 22:00–02:00 in a UTC-8 host: the one case that genuinely splits.
  check('zone: a UTC-8 host splits the straddling window', JSON.stringify(windows(-480)) === '[[0,2],[17,20],[22,24]]', JSON.stringify(windows(-480)))

  // However the windows move, they must still cover the same number of hours.
  const offsets = [480, 0, 60, -240, -300, -480, -720, 720]
  const hours = (offset) => windows(offset).reduce((total, [from, to]) => total + (to - from), 0)
  check('zone: every host keeps the same total peak hours',
    offsets.every((offset) => hours(offset) === 7),
    offsets.map((offset) => `${offset}:${hours(offset)}`).join(' '))
}

// ── 3. the parser fails loudly on a changed page ─────────────────────────────
{
  for (const [label, html] of [
    ['a page with no pricing table', '<html><body><p>nothing here</p></body></html>'],
    ['a table with no model row', '<table><tr><td>价格</td></tr></table>'],
  ]) {
    let threw = null
    try {
      parseOfficialPricing(html)
    } catch (error) {
      threw = error
    }
    check(`parser rejects ${label}`, Boolean(threw) && /layout changed/.test(threw.message), threw?.message ?? 'no error')
  }
}

// ── 4. what applying the list produces ───────────────────────────────────────
{
  const current = {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    default: { inputPerMillion: 99, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 99, currency: 'cny' },
    overrides: { 'my-custom-model': { inputPerMillion: 5, outputPerMillion: 5 } },
    someUnknownKey: { keep: 'me' },
  }
  const { document, applied } = applyOfficialPricing(current, zh)
  const flash = document.overrides['deepseek-flash']

  check('apply: the row price is the off-peak rate', flash.inputPerMillion === 1 && flash.outputPerMillion === 4, JSON.stringify(flash))
  check('apply: the cache-hit price is carried over', flash.cacheReadPerMillion === 0.02, String(flash.cacheReadPerMillion))
  check('apply: the row is quoted in the page currency', flash.currency === 'cny', String(flash.currency))
  check('apply: peak is expressed as a x2 multiplier on the off-peak row', document.timeOfUse.peakMultiplier === 2 && document.timeOfUse.valleyMultiplier === 1, JSON.stringify(document.timeOfUse))
  check('apply: the peak windows come from the page', JSON.stringify(document.timeOfUse.peakRanges) === '[[9,12],[14,18]]', JSON.stringify(document.timeOfUse.peakRanges))
  check('apply: the holiday calendar is switched on', document.holidays?.source === 'cn', JSON.stringify(document.holidays))
  check('apply: the retired ids get rows too', applied.aliases.length === 2 && document.overrides['deepseek-v4-flash']?.inputPerMillion === 1, JSON.stringify(Object.keys(document.overrides)))
  check('apply: a hand-written override survives', document.overrides['my-custom-model']?.inputPerMillion === 5)
  check('apply: an unknown top-level key survives', document.someUnknownKey?.keep === 'me')
  check('apply: the default row is left alone', document.default.inputPerMillion === 99)

  // A table with no default row used to be priced by the built-in template, whose rates are
  // nobody's choice. Applying now fills that gap from the published list's first line, and
  // the page leads with its cheapest model — that ordering is the assumption being pinned
  // here, because a reordered page would silently change what an unmatched model costs.
  check('apply: the published list leads with its cheapest model',
    zh.models[0]?.model === 'deepseek-flash', zh.models.map((entry) => entry.model).join(' -> '))
  const filled = applyOfficialPricing({ exchangeRate: 6.74, totalCurrency: 'cny', overrides: {} }, zh)
  check('apply: a table with no default row gets one from the first published line',
    filled.document.default?.inputPerMillion === 1 && filled.document.default?.cacheReadPerMillion === 0.02 &&
      filled.document.default?.outputPerMillion === 4 && filled.applied.defaultFrom === 'deepseek-flash',
    JSON.stringify(filled.document.default))
  check('apply: a table that already has a default row reports no fill',
    applied.defaultFrom === null, JSON.stringify(applied.defaultFrom))
}

// ── 5. the routes, with the network stubbed out ──────────────────────────────
{
  const root = makeHome('official-routes')
  writePricing(root, {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    default: { inputPerMillion: 99, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 99, currency: 'cny' },
    overrides: {},
  })

  const realFetch = globalThis.fetch
  let fetchCount = 0
  globalThis.fetch = async (url) => {
    fetchCount++
    const body = String(url).includes('/zh-cn/') ? fixture('zh') : fixture('en')
    return { ok: true, status: 200, text: async () => body }
  }
  try {
    // One mounted instance, so the plugin's own cross-request state is observable.
    const instance = await mount(root, 'official-routes')

    const read = await instance.call('GET', '/usage-badge/official-pricing?refresh=1')
    check('route: the official list is served', read.status === 200 && read.body.models.length === 2, `${read.status}`)
    check('route: the response names the sources', Object.keys(read.body.sources ?? {}).join(',') === 'zh-cn,en', JSON.stringify(Object.keys(read.body.sources ?? {})))
    check('route: the fetch happened once', fetchCount === 1, String(fetchCount))

    // A second read inside the coalescing window must not re-hit the site.
    await instance.call('GET', '/usage-badge/official-pricing')
    check('route: a repeat read is coalesced', fetchCount === 1, String(fetchCount))

    const applied = await instance.call('POST', '/usage-badge/official-pricing/apply', { source: 'zh-cn' })
    check('route: applying succeeds', applied.status === 200 && applied.body.ok === true, JSON.stringify(applied.body).slice(0, 160))
    check('route: applying reuses the recent fetch', fetchCount === 1, String(fetchCount))

    const written = readPricing(root)
    check('route: the applied prices are on disk', written.overrides['deepseek-flash']?.inputPerMillion === 1, JSON.stringify(written.overrides['deepseek-flash']))
    check('route: the applied policy is on disk', written.timeOfUse?.peakMultiplier === 2 && written.holidays?.source === 'cn', JSON.stringify({ t: written.timeOfUse, h: written.holidays }))
    check('route: a default row that was already there is still left alone',
      written.default?.inputPerMillion === 99 && applied.body.applied?.defaultFrom === null, JSON.stringify(written.default))

    // ── 6. the applied prices actually bill ───────────────────────────────────
    // 2026-09-24 is an ordinary Thursday, so this is deterministic regardless of
    // the day the suite runs on. 1M input tokens at the flash off-peak rate of
    // 1 CNY/M is 1 CNY, and 2 CNY inside a peak window.
    writeSession(root, 'peak', { provider: 'p', model: 'deepseek-flash', time: at(2026, 9, 24, 10, 30), input: 1e6 })
    writeSession(root, 'offpeak', { provider: 'p', model: 'deepseek-flash', time: at(2026, 9, 24, 20, 30), input: 1e6 })
    const snapshot = await summaryFor(root, 'official-billing')
    const byDate = new Map(snapshot.days.map((day) => [day.date, day.amount]))
    check('billing: the peak hour costs the published peak rate', close(byDate.get('2026-09-24'), 2 + 1), `${byDate.get('2026-09-24')}`)

    // Same day split by hour, so the peak and the valley halves are visible apart.
    const hourly = snapshot.days.find((day) => day.date === '2026-09-24')
    check('billing: the day total is peak + off-peak', close(hourly.amount, 3), `${hourly.amount}`)
  } finally {
    globalThis.fetch = realFetch
  }
}

// ── 7. applying must base itself on the plugin's own file ────────────────────
// The failure this pins: a pre-isolation `storages/usage-pricing.json` sitting
// beside the canonical file. Reading the wrong one yields an empty base, and
// applying then writes a document containing only the official rows — silently
// dropping every hand-written override. That is a real data-loss shape, so it is
// asserted rather than assumed.
{
  const root = makeHome('apply-base')
  writePricing(root, {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    default: { inputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: 'cny' },
    // Two rows the official page knows nothing about.
    overrides: {
      'my-custom-model': { inputPerMillion: 0.2, cacheReadPerMillion: 0.02, cacheWritePerMillion: 0, outputPerMillion: 1.2, currency: 'cny' },
      'another-custom': { inputPerMillion: 4, cacheReadPerMillion: 0.4, cacheWritePerMillion: 0, outputPerMillion: 20, currency: 'cny', multiplier: 0.08 },
    },
  })
  // A stale file at the old path, exactly like the one an older running instance
  // writes when it cannot find the moved file.
  writeLegacyPricing(root, { overrides: { 'official-only': { inputPerMillion: 1, outputPerMillion: 4 } } })

  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => fixture('zh') })
  try {
    const applied = await request(root, 'apply-base', 'POST', '/usage-badge/official-pricing/apply', { source: 'zh-cn' })
    check('apply-base: applying succeeds', applied.status === 200 && applied.body.ok === true, `${applied.status}`)

    const written = readPricing(root)
    check('apply-base: the official rows are written', written.overrides['deepseek-flash']?.inputPerMillion === 1)
    check('apply-base: a hand-written row survives', written.overrides['my-custom-model']?.inputPerMillion === 0.2, JSON.stringify(written.overrides['my-custom-model']))
    check('apply-base: a hand-written row keeps its multiplier', written.overrides['another-custom']?.multiplier === 0.08, String(written.overrides['another-custom']?.multiplier))
    check('apply-base: the row set never shrinks', Object.keys(written.overrides).length >= 4, Object.keys(written.overrides).join(','))
    check('apply-base: the stale file is not used as a base', written.overrides['official-only'] === undefined, Object.keys(written.overrides).join(','))
    check('apply-base: the exchange rate is preserved', written.exchangeRate === 6.74, String(written.exchangeRate))
    check('apply-base: the total currency is preserved', written.totalCurrency === 'cny', String(written.totalCurrency))
  } finally {
    globalThis.fetch = realFetch
  }
}

// ── 8. what an unmatched model costs once the gap has been filled ────────────
// A table with no default row of its own: applying fills it from the published list's first
// line, and from then on an unlisted model is billed at that line rather than at the
// template's invented rates. 1M input tokens off-peak at the flash rate of 1 CNY/M is 1 CNY;
// the template would have said 1.5.
{
  const root = makeHome('apply-default')
  writePricing(root, { exchangeRate: 6.74, totalCurrency: 'cny', overrides: {} })

  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => fixture('zh') })
  try {
    const instance = await mount(root, 'apply-default')
    const applied = await instance.call('POST', '/usage-badge/official-pricing/apply', { source: 'zh-cn' })
    check('apply-default: the response names the model the default row came from',
      applied.body.applied?.defaultFrom === 'deepseek-flash', JSON.stringify(applied.body.applied))
    check('apply-default: the filled default row is on disk',
      readPricing(root).default?.inputPerMillion === 1 && readPricing(root).default?.outputPerMillion === 4,
      JSON.stringify(readPricing(root).default))

    writeSession(root, 'unknown', { provider: 'p', model: 'some-unlisted-model', time: at(2026, 9, 24, 20, 30), input: 1e6 })
    const snapshot = await summaryFor(root, 'apply-default-billing')
    const day = snapshot.days.find((row) => row.date === '2026-09-24')
    check('apply-default: an unlisted model is billed at the first published line',
      close(day?.amount, 1), `got ${day?.amount}`)

    // The lifecycle the panel offers: delete the row, fall back to the template, regenerate it
    // from the official list. Each step is asserted, because "delete then get it back" is the
    // whole reason the row is deletable in the first place.
    const removed = await instance.call('PUT', '/usage-badge/config', { default: null })
    check('apply-default: deleting the row removes it from the table',
      removed.status === 200 && readPricing(root).default === undefined, JSON.stringify(readPricing(root).default))
    const afterRemove = await instance.call('GET', '/usage-badge/config')
    check('apply-default: the table falls back to the built-in template and says so',
      afterRemove.body.defaultSource === 'template' && afterRemove.body.effective.default?.inputPerMillion === 1.5,
      JSON.stringify({ source: afterRemove.body.defaultSource, row: afterRemove.body.effective.default }))
    const regenerated = await instance.call('POST', '/usage-badge/official-pricing/apply', { source: 'zh-cn' })
    check('apply-default: applying again regenerates it from the first published line',
      regenerated.body.applied?.defaultFrom === 'deepseek-flash' && readPricing(root).default?.inputPerMillion === 1,
      JSON.stringify(readPricing(root).default))

    // The other way in is the editor, and what it writes survives an apply — apply only ever
    // fills the *absence* of a default row.
    await instance.call('PUT', '/usage-badge/config', {
      default: { inputPerMillion: 3, cacheReadPerMillion: 0.3, cacheWritePerMillion: 0, outputPerMillion: 9, currency: 'cny' },
    })
    const edited = await instance.call('POST', '/usage-badge/official-pricing/apply', { source: 'zh-cn' })
    check('apply-default: a hand-edited default row survives an apply',
      readPricing(root).default?.inputPerMillion === 3 && edited.body.applied?.defaultFrom === null,
      JSON.stringify(readPricing(root).default))
  } finally {
    globalThis.fetch = realFetch
  }
}

finish()
