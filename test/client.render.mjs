/**
 * Browser-half render test.
 *
 * Loads the client bundle through a stand-in module loader, checks the slot
 * registration it makes, and renders the real component to static markup against
 * a snapshot produced by the real host half over a hermetic fixture home — never
 * the developer's live `DSH_HOME`, which a test must not fold or rewrite.
 *
 * Both panels are rendered: 用量 (the pill's ranges, stats and chart) and 单价配置
 * (the official-price block, the holiday calendar block and the read-only price table).
 * This catches what a syntax check cannot — a broken money format, an empty chart,
 * a crash on a provider with no rows for the selected range, a missing holiday
 * badge, and a registration that would shadow a shipped overlay entry.
 *
 * Usage:
 *   node test/client.render.mjs
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'

import { cleanupHomes, makeHome, writePricing, writeSession } from './helpers.mjs'

const nodeRequire = createRequire(import.meta.url)
const React = nodeRequire('react')

// ── 1. a hermetic fixture home ───────────────────────────────────────────────
const home = makeHome('render')
const at = (dayOffset, hour, minute = 30) => {
  const d = new Date()
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}
writePricing(home, {
  exchangeRate: 6.74,
  totalCurrency: 'cny',
  multiplier: 1,
  default: { inputPerMillion: 1, cacheReadPerMillion: 0.02, cacheWritePerMillion: 0, outputPerMillion: 4, currency: 'cny' },
  timeOfUse: { enabled: true, days: 'weekday', peakMultiplier: 2, valleyMultiplier: 1, peakRanges: [[9, 12], [14, 18]] },
  holidays: { source: 'cn' },
  overrides: {
    'deepseek-flash': { inputPerMillion: 1, cacheReadPerMillion: 0.02, cacheWritePerMillion: 0, outputPerMillion: 4, currency: 'cny' },
    'deepseek-v4-pro': { inputPerMillion: 4.5, cacheReadPerMillion: 0.15, cacheWritePerMillion: 0, outputPerMillion: 13.5, currency: 'cny' },
  },
})
// Two providers today (so the provider filter renders), earlier days so the 7-day
// and 30-day ranges have bars, and peak-hour requests so both the band chip and
// the peak multiplier are exercised.
writeSession(home, 'today-a', { provider: 'alpha', model: 'deepseek-flash', time: at(0, 9), input: 200000, cacheRead: 400000, output: 50000 })
writeSession(home, 'today-b', { provider: 'beta', model: 'deepseek-v4-pro', time: at(0, 16), input: 120000, cacheRead: 80000, output: 30000 })
for (const offset of [-1, -2, -3, -10]) {
  writeSession(home, `past${offset}`, { provider: 'alpha', model: 'deepseek-flash', time: at(offset, 10), input: 100000, output: 20000 })
}

const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const { apply: applyHost } = await import('../lib/index.js')

const hostRoutes = []
const hostCtx = {
  webServer: {
    register(route) {
      hostRoutes.push(route)
      return () => {}
    },
  },
  effect(body) {
    const dispose = body()
    return typeof dispose === 'function' ? dispose : () => {}
  },
}
applyHost(hostCtx)
if (previousHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = previousHome

const snapshotResponse = { body: '' }
await hostRoutes[0].handler(
  {
    method: 'GET',
    url: '/usage-badge/summary',
    socket: { remoteAddress: '127.0.0.1' },
    on(event, listener) {
      if (event === 'end') listener()
      return this
    },
    destroy() {},
  },
  {
    writeHead() {},
    end(chunk) {
      snapshotResponse.body = chunk ? Buffer.from(chunk).toString('utf8') : ''
    },
  },
)
const snapshot = JSON.parse(snapshotResponse.body)

// The config panel's own data comes from the same mounted host, and the official
// price list from a captured page, so neither the render nor the test needs the
// network.
const configResponse = { body: '' }
await hostRoutes[0].handler(
  {
    method: 'GET',
    url: '/usage-badge/config',
    socket: { remoteAddress: '127.0.0.1' },
    on(event, listener) {
      if (event === 'end') listener()
      return this
    },
    destroy() {},
  },
  {
    writeHead() {},
    end(chunk) {
      configResponse.body = chunk ? Buffer.from(chunk).toString('utf8') : ''
    },
  },
)
const config = JSON.parse(configResponse.body)

const { parseOfficialPricing } = await import('../lib/official-pricing.js')
const official = parseOfficialPricing(readFileSync(new URL('./fixtures/pricing.zh.html', import.meta.url), 'utf8'), {
  url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
})
official.sources = { 'zh-cn': { label: '中文页（人民币）' }, en: { label: 'English (USD)' } }

// ── 2. load the client bundle through a stand-in loader ──────────────────────
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
}
await import('../lib/client.js')

if (!loaded) throw new Error('the client bundle registered nothing with __ModuleLoader__')
if (loaded.id !== 'dsh-usage-badge') throw new Error(`unexpected module id: ${loaded.id}`)

const plugin = loaded.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`the client bundle required an unexpected module: ${specifier}`)
})

const checks = []
const check = (label, condition, detail = '') => {
  checks.push({ label, ok: Boolean(condition), detail })
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

check('exports apply()', typeof plugin.apply === 'function')
check('exports inject', Array.isArray(plugin.inject), JSON.stringify(plugin.inject))
check('injects the slot registry', plugin.inject.includes('slots'))

// ── 3. what the plugin registers ─────────────────────────────────────────────
const registrations = []
const clientCtx = {
  slots: {
    register(options, component) {
      registrations.push({ entry: options, component, slotName: null })
      return () => {}
    },
    inject(slotName, register) {
      const before = registrations.length
      const dispose = register()
      for (let i = before; i < registrations.length; i++) registrations[i].slotName = slotName
      return typeof dispose === 'function' ? dispose : () => {}
    },
  },
  effect(body) {
    const dispose = body()
    return typeof dispose === 'function' ? dispose : () => {}
  },
}
plugin.apply(clientCtx)

const registration = registrations[0]
check('registered exactly one entry', registrations.length === 1)
// The sidebar declares this seat for actions beside Settings at the foot of the
// column; using it is what makes the row align with the shipped rows instead of
// floating over them.
check('registers into sidebar.footer.action', registration?.slotName === 'sidebar.footer.action', registration?.slotName)
check('uses the footer seat name and its own id',
  registration?.entry?.name === 'sidebar.footer.action' && registration?.entry?.id === 'usage-badge',
  JSON.stringify(registration?.entry))
check('registers a component', typeof registration?.component === 'function')

// ── 4. render: closed (the row) ──────────────────────────────────────────────
// Hooks need the React renderer's dispatcher, so the component is rendered as an
// element rather than called directly.
const Badge = registration.component
const render = (props) => renderToStaticMarkup(React.createElement(Badge, props))

const openMarkup = render({ initialSnapshot: snapshot, initialOpen: true })
const configMarkup = render({ initialSnapshot: snapshot, initialOpen: true, initialTab: 'config', initialConfig: config, initialOfficial: official })
const closedMarkup = render({ initialSnapshot: snapshot })
const loadingMarkup = render({})
const railMarkup = render({ initialSnapshot: snapshot, wide: false })

const badgeText = `¥${snapshot.badge.amount.toFixed(2)}`
check('closed render shows the badge amount', closedMarkup.includes(badgeText), badgeText)
check('closed render draws no dialog', !closedMarkup.includes('用量统计'))
check('zero-state render still shows a row', loadingMarkup.includes('dub-pill') && loadingMarkup.includes('…'))
check('the expanded column gets a labelled row', closedMarkup.includes('今日用量') && !closedMarkup.includes('dub-pill-rail'))
check('the collapsed rail gets the square variant', railMarkup.includes('dub-pill-rail'), 'rail variant')
check('the rail row still shows the amount', railMarkup.includes(badgeText), badgeText)

// The stylesheet is injected by an effect, which a static render does not run, so
// the layout contract is checked against the source.
const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
check('the row is a full-width footer row', /\.dub-pill\{[^}]*width:100%/.test(clientSource))
check('the row does not float over other controls', !/\.dub-pill\{[^}]*position:fixed/.test(clientSource))
check('the rail variant is a square', /\.dub-pill-rail\{[^}]*width:36px;height:36px/.test(clientSource))
check('dialog sits above the frame', /\.dub-mask\{[^}]*z-index:2147483/.test(clientSource))
check('the chart tooltip has its own positioned layer', /\.dub-plot\{position:relative\}/.test(clientSource))

// The row reports the day's token total, and keeps the compact peak/valley dot —
// which now carries the band text as its own tooltip so it explains itself.
check('the row no longer draws a ¥ glyph', !closedMarkup.includes('dub-pill-icon'))
// today's two fixture sessions: (200k+400k+50k) + (120k+80k+30k) = 880k tokens.
check('the row shows the day token total', closedMarkup.includes('880.0K tokens'), 'token total')
{
  const withBand = (peak) => ({ ...snapshot, band: { enabled: true, peak, multiplier: peak ? 2 : 1, dayClass: 'normal', dayName: null } })
  const peakMarkup = render({ initialSnapshot: withBand(true) })
  const offMarkup = render({ initialSnapshot: withBand(false) })
  check('the peak dot is coloured orange', peakMarkup.includes('dub-dot dub-dot-peak'), 'peak class')
  check('the off-peak dot is plain', offMarkup.includes('class="dub-dot"') && !offMarkup.includes('dub-dot-peak'), 'valley class')
  check('the dot explains itself on hover', peakMarkup.includes('title="峰时 ×2"'), 'dot tooltip')
  // The bug this pins: an absolutely positioned dot escapes the row and floats
  // above the text instead of sitting beside the label.
  check('the dot is a flow item, never absolutely positioned',
    /\.dub-dot\{flex:none/.test(clientSource) && !/\.dub-dot\{[^}]*position:absolute/.test(clientSource))
  check('the dot colours by peak state in the stylesheet', /\.dub-dot-peak\{background:var\(--dsw-alias-brand-primary/.test(clientSource))
}
check('the rail variant hides the extra fields',
  /\.dub-pill-rail \.dub-pill-label,\.dub-pill-rail \.dub-pill-tokens,\.dub-pill-rail \.dub-dot\{display:none\}/.test(clientSource))
{
  // The row reads label → dot → token total → amount, and the amount is last so it
  // stays the rightmost, strongest element.
  const atLabel = closedMarkup.indexOf('今日用量')
  const atDot = closedMarkup.indexOf('dub-dot')
  const atTokens = closedMarkup.indexOf('dub-pill-tokens')
  const atAmount = closedMarkup.indexOf('dub-pill-amount')
  check('the row orders label, dot, tokens, amount',
    atLabel >= 0 && atDot > atLabel && atTokens > atDot && atAmount > atTokens,
    `${atLabel} < ${atDot} < ${atTokens} < ${atAmount}`)
}

// ── 5. render: the 用量 panel ────────────────────────────────────────────────
check('dialog renders its title', openMarkup.includes('用量统计'))
check('dialog offers both panels', openMarkup.includes('用量') && openMarkup.includes('单价配置'))
for (const label of ['24 小时', '近 7 日', '近 30 日', '近 12 个月']) {
  check(`dialog offers the ${label} range`, openMarkup.includes(label))
}
check('dialog shows request/token/hit-rate stats',
  openMarkup.includes('请求数') && openMarkup.includes('Token') && openMarkup.includes('缓存命中率'))

// The chart mirrors the desktop shell: four smoothed series over one index axis,
// with a legend naming them.
check('chart draws the four shell series',
  ['金额（¥）', 'token 总量', '请求数', '缓存命中率（%）'].every((label) => openMarkup.includes(label)))
check('chart renders as svg with a legend', openMarkup.includes('dub-svg') && openMarkup.includes('dub-legend'))
// The plot owns the tooltip's coordinate space, so the svg must live inside it —
// otherwise the tooltip is positioned from the legend and can overlap it.
check('the svg is nested inside the plot layer', /dub-plot[^>]*><svg/.test(openMarkup))
const seriesPaths = (openMarkup.match(/<path[^>]*stroke="#[0-9a-f]{6}"/gi) || []).length
check('chart drew four series paths', seriesPaths === 4, `${seriesPaths} stroked paths`)
const circles = (openMarkup.match(/<circle/gi) || []).length
check('chart drew points for every slot and series', circles === 24 * 4, `${circles} circles`)
check('the amount series is filled', /fill="rgba\(31,111,235,0\.10\)"/.test(openMarkup))
check('the hit-rate series is dashed', /stroke-dasharray="5 3"/.test(openMarkup))
check('x labels are drawn on a stride', openMarkup.includes('>0<') && openMarkup.includes('>22<'), 'stride labels')

// The hover tooltip is rendered by an interaction the static pass cannot produce,
// so its presence and content are pinned in the source.
check('chart has a hover tooltip', /className: 'dub-tip'/.test(clientSource) && /dub-tip-value/.test(clientSource))
check('chart tracks the hovered index', /onMouseMove: \(event\) => setHover\(indexAt\(event\)\)/.test(clientSource))
check('tooltip reports every series', /SERIES\.map\(\(series\) =>[\s\S]{0,400}dub-tip-value/.test(clientSource))
// Centre-anchoring alone pushes half the tooltip past the dialog's clipped box at
// either end of the axis, so it must be clamped.
check('the tooltip is clamped inside the chart', /left: `clamp\(86px,[\s\S]{0,80}calc\(100% - 86px\)\)/.test(clientSource))
check('the tooltip has a fixed width for that clamp to be exact', /\.dub-tip\{[^}]*width:172px/.test(clientSource))
check('hovering draws a guide line', /className: 'dub-guide'/.test(clientSource))
check('each series keeps its own scale', /series\.max \?\? Math\.max/.test(clientSource))

const providers = snapshot.today.providers || []
check('provider tabs match the snapshot', providers.length <= 1
  ? !openMarkup.includes('dub-sep')
  : providers.every((row) => openMarkup.includes(row.provider)),
  `${providers.length} provider(s): ${providers.map((p) => p.provider).join(',') || 'none'}`)

// ── 6. the holiday calendar reaches the UI ───────────────────────────────────
check('the snapshot carries a calendar', Boolean(snapshot.calendar?.today), JSON.stringify(snapshot.calendar?.today))
check('config panel shows the holiday block', configMarkup.includes('法定节假日日历'))
check('config panel reports what the bundled table covers',
  configMarkup.includes('内置日历覆盖') && configMarkup.includes('法定节假日'),
  config.bundled?.years?.join(','))
check('config panel says 调休 workdays do not change pricing', configMarkup.includes('不影响计价'))
check('config panel names the source documents', configMarkup.includes('国办发明电'), 'source documents rendered')
check('config panel says the calendar is off when it is off',
  config.bundled && !config.calendar.enabled ? configMarkup.includes('未启用') : true,
  `enabled=${config.calendar?.enabled}`)

// A holiday today must replace the peak/valley chip with an all-day-off-peak one.
const holidaySnapshot = {
  ...snapshot,
  calendar: { ...snapshot.calendar, enabled: true, today: { date: '2026-10-01', class: 'holiday', name: '国庆节' } },
}
const holidayMarkup = render({ initialSnapshot: holidaySnapshot, initialOpen: true })
check('a holiday today shows the all-day-off-peak chip', holidayMarkup.includes('国庆节 · 全天空闲'), 'holiday chip')

// A 调休 working day gets no special labelling: the page makes weekends off-peak,
// so such a day reads as an ordinary day and follows the peak/valley windows.
const makeupSnapshot = {
  ...snapshot,
  calendar: { ...snapshot.calendar, enabled: true, today: { date: '2026-09-20', class: 'normal', name: null } },
}
const makeupMarkup = render({ initialSnapshot: makeupSnapshot, initialOpen: true })
check('a 调休 day today is not labeled as a working day', !makeupMarkup.includes('调休上班'), 'no makeup chip')

// ── 7. render: the 单价配置 panel ────────────────────────────────────────────
check('config panel has an official-pricing block', configMarkup.includes('官方定价'))
check('config panel offers both official sources', configMarkup.includes('中文页（人民币）') && configMarkup.includes('English (USD)'))
check('config panel has an apply action', configMarkup.includes('应用官方价格'))
// Prices come from the published list, so the manual knobs are gone rather than
// merely hidden behind a save button. Asserted on the controls, not on the words:
// the note explaining this does mention 汇率/币种.
check('config panel has no editable rate or price fields', !configMarkup.includes('<input'), 'no <input> in the panel')
check('config panel no longer offers a total-currency choice', !configMarkup.includes('合计币种'))
check('config panel names the published list as the only price source', configMarkup.includes('这是唯一的单价来源'))
// Switching tabs unmounts the panel, so returning to it must render the list it
// already fetched rather than blanking it back to the loading placeholder — that
// swap is the flicker. The cache lives for the life of the page.
check('the config panel seeds itself from the last successful fetch',
  /useState\(initialOfficial \?\? cachedOfficial\)/.test(clientSource) &&
    /useState\(initialConfig \?\? cachedConfig\)/.test(clientSource))
check('a refresh only shows the loading line when there is nothing to show',
  /if \(!cachedOfficial\) setOfficialState\('loading'\)/.test(clientSource))
check('a failed refresh keeps the last good list', /if \(!cachedOfficial\) setOfficial\(null\)/.test(clientSource))

// The published list itself, with the numbers the page quotes.
check('official table lists the published models',
  configMarkup.includes('deepseek-flash') && configMarkup.includes('deepseek-v4-pro'))
check('official table shows the off-peak and peak rates',
  configMarkup.includes('¥1 / ¥0.02 / ¥4') && configMarkup.includes('¥2 / ¥0.04 / ¥8'),
  'flash off-peak ¥1/¥0.02/¥4 and peak ¥2/¥0.04/¥8')
check('official table quotes the currency and source', configMarkup.includes('CNY') && configMarkup.includes('api-docs') === false)
check('official block repeats the policy line',
  configMarkup.includes('高峰时段') && configMarkup.includes('09:00–12:00') && configMarkup.includes('空闲时段价格为高峰时段价格的一半'))
check('official block names the retired model ids', configMarkup.includes('deepseek-v4-flash-vision-exp'), 'alias line')

// The effective table is the plugin's own config read back, shown read-only.
check('config panel renders the effective default row', configMarkup.includes('当前生效单价') && configMarkup.includes('default:'))
check('the effective table is marked read-only', configMarkup.includes('只读'))
check('a pure official-price table shows no multiplier column', !configMarkup.includes('>倍率<'))
{
  // A row that carries a factor must reveal it: a hidden multiplier would change
  // the number the panel reports with no trace in the panel.
  const withMultiplier = {
    ...config,
    effective: {
      ...config.effective,
      overrides: { ...config.effective.overrides, 'some-gateway-model': { inputPerMillion: 4, outputPerMillion: 20, multiplier: 0.08 } },
    },
  }
  const markup = render({ initialSnapshot: snapshot, initialOpen: true, initialTab: 'config', initialConfig: withMultiplier, initialOfficial: official })
  check('a row carrying a multiplier reveals the column', markup.includes('>倍率<') && markup.includes('some-gateway-model'))
}
check('config panel lists the effective override keys',
  configMarkup.includes('deepseek-flash') && configMarkup.includes('deepseek-v4-pro'),
  Object.keys(config.effective?.overrides ?? {}).join(','))

// ── 8. edge cases must not crash ─────────────────────────────────────────────
const emptySnapshot = {
  ...snapshot,
  badge: { date: snapshot.badge.date, amount: 0, currency: 'cny' },
  today: { date: snapshot.today.date, amount: 0, requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, providers: [], hourly: [] },
  days: [],
}
check('usage panel survives an empty snapshot', render({ initialSnapshot: emptySnapshot, initialOpen: true }).includes('暂无用量'))
check('config panel survives an empty snapshot', render({ initialSnapshot: emptySnapshot, initialOpen: true, initialTab: 'config' }).includes('法定节假日日历'))

// A provider row whose hourly series is empty must still render its tab and must
// not break the shared chart, which is what a sparse provider looks like.
const first = snapshot.today.providers[0] ?? { provider: 'ghost', amount: 0, requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
const sparseSnapshot = {
  ...snapshot,
  today: { ...snapshot.today, providers: [first, { provider: 'ghost', amount: 1, requests: 1, input: 1, cacheRead: 0, cacheWrite: 0, output: 0, hourly: [] }] },
}
const sparseMarkup = render({ initialSnapshot: sparseSnapshot, initialOpen: true })
check('usage panel lists a provider with an empty hourly series', sparseMarkup.includes('ghost'))
check('sparse provider keeps the four series', (sparseMarkup.match(/<path[^>]*stroke="#[0-9a-f]{6}"/gi) || []).length === 4)

// Day rows carrying a holiday mark must shade the chart, which is how it explains
// a cheap day. The mark only exists on the day ranges (the 24-hour view has no day
// rows).
check('day rows carry their class into the chart points',
  /const point = \(label, title, src, dayClass\)/.test(clientSource) &&
    /entryTotals\(day, provider\),[\s\S]{0,40}day\.dayClass,/.test(clientSource))
check('holiday days shade the chart', /p\.dayClass === 'holiday'/.test(clientSource) && /dub-band-holiday/.test(clientSource))

// ── 9. the ranges are calendar windows, not "the last N days with usage" ─────
// The fixture has usage on today and on days -1, -2, -3 and -10. A window built
// from the days that have data would draw 5 points spanning 11 calendar days, so a
// quiet Saturday silently stretches 近 7 日 into 8 or more days and hides the gap.
// Enumerating the calendar keeps every day in its own slot, zeros included.
{
  const axisLabels = (markup) => [...markup.matchAll(/class="dub-axis"[^>]*>([^<]+)</g)].map((match) => match[1])
  const dayKey = (offset) => {
    const date = new Date()
    date.setDate(date.getDate() + offset)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }

  const week = render({ initialSnapshot: snapshot, initialOpen: true, initialRange: '7d' })
  const weekLabels = axisLabels(week)
  const expected = [-6, -5, -4, -3, -2, -1, 0].map((offset) => dayKey(offset).slice(5))
  check('7d draws exactly 7 slots', weekLabels.length === 7, weekLabels.join(' '))
  check('7d covers 7 consecutive calendar days ending today',
    weekLabels.join(',') === expected.join(','), `${weekLabels.join(',')} vs ${expected.join(',')}`)
  // Day -4 has no usage in the fixture and must still occupy its slot.
  check('7d keeps a day with no usage in its slot', weekLabels.includes(dayKey(-4).slice(5)), dayKey(-4))
  check('7d does not reach past the window', !weekLabels.includes(dayKey(-10).slice(5)), dayKey(-10))
  check('7d draws a point per day and series', (week.match(/<circle/gi) || []).length === 7 * 4)

  const year = render({ initialSnapshot: snapshot, initialOpen: true, initialRange: '12m' })
  const monthLabels = axisLabels(year)
  check('12m draws twelve calendar months', monthLabels.length === 12, monthLabels.join(' '))
}
check('there is no 调休 shading', !/dub-band-makeup/.test(clientSource))

// ── 9. verdict ───────────────────────────────────────────────────────────────
cleanupHomes()
const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) {
  console.error(`\nFAILED:\n${failed.map((c) => `  - ${c.label}${c.detail ? ` (${c.detail})` : ''}`).join('\n')}`)
  process.exitCode = 1
}
