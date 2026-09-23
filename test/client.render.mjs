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

import { cleanupHomes, makeHome, mount, writePricing, writeSession } from './helpers.mjs'

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

// The host half runs against the fixture home through the shared harness, which also keeps its
// disposers so the cache store's file handle is released before the home is deleted.
const host = await mount(home, 'render')
const snapshot = (await host.call('GET', '/usage-badge/summary')).body
const config = (await host.call('GET', '/usage-badge/config')).body

const { parseOfficialPricing } = await import('../lib/official-pricing.js')
const official = parseOfficialPricing(readFileSync(new URL('./fixtures/pricing.zh.html', import.meta.url), 'utf8'), {
  url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
})

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
const hostSource = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
check('the row is a full-width footer row', /\.dub-pill\{[^}]*width:100%/.test(clientSource))
check('the row does not float over other controls', !/\.dub-pill\{[^}]*position:fixed/.test(clientSource))
check('the rail variant is a square', /\.dub-pill-rail\{[^}]*width:36px;height:36px/.test(clientSource))
check('dialog sits above the frame', /\.dub-mask\{[^}]*z-index:2147483/.test(clientSource))
check('the chart tooltip has its own positioned layer', /\.dub-plot\{position:relative\}/.test(clientSource))
// The bug this pins: DSH 0.1.7 changed --dsw-specific-menu from
// var(--dsw-alias-bg-layer-3) — an opaque surface, which is what 0.1.6 defined — to
// #f8f9fa94 in the light theme and #30313680 in the dark one. Those are frosted
// surfaces: the shell pairs them with backdrop-filter:var(--dsw-menu-backdrop-filter),
// so a rule that fills with the token and no blur reads as half transparent — the
// dialog panel and the chart tooltip let the conversation behind them show through.
// Both name the opaque layer token directly instead, which both versions define.
check('the dialog panel keeps an opaque surface',
  /\.dub-box\{[^}]*background:var\(--dsw-alias-bg-layer-3,#fff\)/.test(clientSource))
check('the chart tooltip keeps an opaque surface',
  /\.dub-tip\{[^}]*background:var\(--dsw-alias-bg-layer-3,#fff\)/.test(clientSource))
check('no surface fills with the translucent menu token',
  !/background:var\(--dsw-specific-menu/.test(clientSource), 'menu surfaces need a backdrop blur')

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
  // The peak marker must not borrow the brand token: --dsw-alias-brand-primary is the
  // ink colour, #0f1115 in the light theme and near-white in the dark one, so the peak
  // state read as an ordinary dark dot and the peak chip became white on white.
  check('the dot colours by peak state in the stylesheet',
    /\.dub-dot-peak\{background:var\(--dsw-static-amber-500,#f59e0b\)\}/.test(clientSource))
  check('no peak accent borrows the brand ink token',
    !/\.dub-(?:dot|chip)-peak\{[^}]*--dsw-alias-brand-primary/.test(clientSource) &&
      /\.dub-chip-peak\{background:var\(--dsw-static-amber-500,#f59e0b\);color:#111\}/.test(clientSource),
    'amber on both, in both themes')
  // The same token is a foreground colour, so it cannot be a filled background under
  // white text either — in the dark theme that pairs near-white with white.
  check('the ink token is never a filled background under white text',
    !/background:var\(--dsw-alias-brand-primary[^}]*color:#fff/.test(clientSource) &&
      /\.dub-btn-primary\{[^}]*background:var\(--dsw-static-deepseek-500,#4176e6\);color:#fff\}/.test(clientSource),
    'the apply button keeps a readable pair')
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
check('tooltip reports every visible series', /shown\.map\(\(series\) =>[\s\S]{0,400}dub-tip-value/.test(clientSource))
// Centre-anchoring alone pushes half the tooltip past the dialog's clipped box at
// either end of the axis, so it must be clamped.
check('the tooltip is clamped inside the chart', /left: `clamp\(86px,[\s\S]{0,80}calc\(100% - 86px\)\)/.test(clientSource))
check('the tooltip has a fixed width for that clamp to be exact', /\.dub-tip\{[^}]*width:172px/.test(clientSource))
check('hovering draws a guide line', /className: 'dub-guide'/.test(clientSource))
check('each series keeps its own scale', /series\.max \?\? Math\.max/.test(clientSource))

// ── 5b. the chart's legend toggles ───────────────────────────────────────────
// Every legend entry shows or hides its own series, so one metric can be read on its
// own — at its own scale and full height, instead of compressed against a neighbour
// that differs by orders of magnitude.
{
  const isolated = render({ initialSnapshot: snapshot, initialOpen: true, initialHidden: ['tokens', 'requests', 'hitRate'] })
  const withoutAmount = render({ initialSnapshot: snapshot, initialOpen: true, initialHidden: ['amount'] })
  const stroked = (markup) => (markup.match(/<path[^>]*stroke="#[0-9a-f]{6}"/gi) || []).length

  check('every legend entry is a toggle',
    (openMarkup.match(/class="dub-legend-item"/g) || []).length === 4 &&
      /onClick: \(\) => toggle\(series\.key\)/.test(clientSource),
    'four buttons, not labels')
  check('isolating a series draws only that series',
    stroked(isolated) === 1 && (isolated.match(/<circle/gi) || []).length === 24,
    `${stroked(isolated)} path(s), ${(isolated.match(/<circle/gi) || []).length} circles`)
  // The fill belongs to the amount series, so hiding it must not hand the fill to
  // whichever series happens to be first in the filtered list.
  check('hiding the amount series takes its area fill with it',
    !/fill="rgba\(31,111,235,0\.10\)"/.test(withoutAmount) && stroked(withoutAmount) === 3)
  check('a hidden series is greyed in the legend and can be brought back',
    isolated.includes('dub-legend-off') && isolated.includes('全部显示'))
  check('a fully visible legend offers no reset link', !openMarkup.includes('全部显示'))
  check('the click that would empty the plot resets instead',
    /next\.size >= SERIES\.length - 1/.test(clientSource), 'never hides all four')
  // Hiding the series that had the data must not strand the reader: the legend is the only
  // way back, so the empty state has to keep rendering it. The fixture's hours all have cache
  // reads, so the cache-hit series is zeroed here to leave one visible series with no data.
  {
    const noCacheHits = {
      ...snapshot,
      today: { ...snapshot.today, cacheRead: 0, hourly: snapshot.today.hourly.map((slot) => ({ ...slot, cacheRead: 0 })) },
    }
    const strandedMarkup = render({
      initialSnapshot: noCacheHits,
      initialOpen: true,
      initialHidden: ['amount', 'tokens', 'requests'],
    })
    check('an empty-looking plot keeps its legend, so the series can be brought back',
      strandedMarkup.includes('dub-legend') && strandedMarkup.includes('全部显示') &&
        strandedMarkup.includes('点上面的图例把其它序列显示出来'),
      'and says what happened')
  }
  check('the legend swatch colour is written in one place only',
    !/\.dub-legend-off \.dub-legend-swatch\{[^}]*color:/.test(clientSource) &&
      /\.dub-legend-off \.dub-legend-swatch\{background:/.test(clientSource))
}

const providers = snapshot.today.providers || []
check('provider tabs match the snapshot', providers.length <= 1
  ? !openMarkup.includes('dub-sep')
  : providers.every((row) => openMarkup.includes(row.provider)),
  `${providers.length} provider(s): ${providers.map((p) => p.provider).join(',') || 'none'}`)

// ── 6. the holiday calendar reaches the UI ───────────────────────────────────
check('the snapshot carries a calendar', Boolean(snapshot.calendar?.today), JSON.stringify(snapshot.calendar?.today))
check('config panel shows the holiday block', configMarkup.includes('法定节假日日历'))
check('config panel reports what the bundled table covers',
  configMarkup.includes('覆盖 2025、2026') && configMarkup.includes('法定节假日'),
  config.bundled?.years?.join(','))
check('config panel says 调休 workdays do not change pricing', configMarkup.includes('不影响计价'))
check('config panel names the source documents', configMarkup.includes('国办发明电'), 'source documents live in the tooltip')
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
// One page, one currency: the panel reads the CNY page and offers no language choice, because
// every total here is CNY and the USD column would need an exchange rate to mean anything.
check('the panel reads the CNY page and offers no language choice',
  configMarkup.includes('人民币') && !configMarkup.includes('English (USD)') &&
    /const OFFICIAL_SOURCE = 'zh-cn'/.test(clientSource) &&
    /official-pricing\?refresh=1&source=\$\{OFFICIAL_SOURCE\}/.test(clientSource))
check('config panel has an apply action', configMarkup.includes('应用官方价格'))
// The published list is still where official prices come from, and the panel opens with no form
// on screen: the row editor appears only once a row is opened (or added).
check('the closed panel keeps its row editor out of the way', !configMarkup.includes('<input'), 'no <input> until a row is opened')
check('config panel no longer offers a total-currency choice', !configMarkup.includes('合计币种'))
check('config panel names the published list as the official price source', configMarkup.includes('官方单价就是从这里来的'))
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
check('official table quotes the currency and fetch time', configMarkup.includes('人民币') && configMarkup.includes('单位：百万 tokens'))
check('official block repeats the policy line',
  configMarkup.includes('高峰时段') && configMarkup.includes('09:00–12:00') && configMarkup.includes('空闲时段价格为高峰时段价格的一半'))
check('official block names the retired model ids', configMarkup.includes('deepseek-v4-flash-vision-exp'), 'alias line')

// The published list is fetched from the network (the URL carries `refresh=1`, which bypasses
// the host's own cache) and it changes a few times a year — so it is fetched once per page load,
// on the first visit to the tab, and after that only when the button is pressed. Effects do not
// run under `renderToStaticMarkup`, so the fetch policy is pinned at the source, and the visible
// consequence — the age of the list — is pinned by rendering one.
check('the published list is fetched once per page load, not on every visit to the tab',
  /if \(!cachedOfficial\) void loadOfficial\(\)/.test(clientSource) &&
    !/useEffect\(\(\) => \{\s*void loadOfficial\(\)\s*\}/.test(clientSource),
  'the mount effect is guarded by the page-lifetime cache')
check('the button is still the way to ask again',
  /onClick: \(\) => void loadOfficial\(\), disabled: officialState === 'loading'/.test(clientSource) &&
    /official-pricing\?refresh=1&source=\$\{OFFICIAL_SOURCE\}/.test(clientSource),
  '重新获取 re-fetches, forcing past the host cache')
{
  const hoursAgo = Date.now() - 3 * 60 * 60 * 1000
  const stale = render({ initialSnapshot: snapshot, initialOpen: true, initialTab: 'config', initialConfig: config,
    initialOfficial: { ...official, fetchedAt: hoursAgo } })
  check('an aged list says how old it is', stale.includes('（3 小时前）'), 'the fetch time carries its age')
  const fresh = render({ initialSnapshot: snapshot, initialOpen: true, initialTab: 'config', initialConfig: config,
    initialOfficial: { ...official, fetchedAt: Date.now() } })
  check('a list fetched just now does not nag about its age', !/（\d+ 分钟前）/.test(fresh) && !/（\d+ 小时前）/.test(fresh), 'no age shown while fresh')
}

// The effective table is the plugin's own price rows read back, and now the place they
// are maintained from. Its own checks are below, next to the editor's.
check('config panel renders the effective default row', configMarkup.includes('当前生效单价') && configMarkup.includes('default:'))
// The model-prefix fallback is a switch, not a file-only setting: the block that shows
// which rows are in effect also has to show which row a model resolves to, and offer the
// action that changes it — otherwise a rule that re-prices history lives only in a file.
check('config panel shows the prefix fallback state', configMarkup.includes('前缀回退：开启'))
check('config panel offers to turn the prefix fallback off',
  configMarkup.includes('关闭前缀回退') && !configMarkup.includes('<input'), 'a button, not a field')
{
  const offConfig = { ...config, effective: { ...config.effective, modelPrefixFallback: false } }
  const offMarkup = render({ initialSnapshot: snapshot, initialOpen: true, initialTab: 'config', initialConfig: offConfig, initialOfficial: official })
  check('the fallback switch reflects the effective config',
    offMarkup.includes('前缀回退：已关闭') && offMarkup.includes('开启前缀回退'), 'off state rendered')
  check('both switches write through one config-route writer',
    /fetch\('\/usage-badge\/config', \{\s*\n\s*method: 'PUT'/.test(clientSource) &&
      /const writeConfig = async \(patch, setState, okValue\)/.test(clientSource) &&
      /toggleFallback = \(next\) => writeConfig\(\{ modelPrefixFallback: next \}/.test(clientSource) &&
      /toggleUnmatched = \(next\) => writeConfig\(\{ priceUnmatchedModels: next \}/.test(clientSource),
    'one writer, two fields')
  check('a switch reloads the summary, since both re-price history',
    /setState\(okValue\)\s*\n\s*await loadConfig\(\)\s*\n\s*reload\(\)/.test(clientSource))
}

// ── 7b. what an unmatched model costs, and who says so ───────────────────────
// The second switch: keep the `default` row pricing everything, or read "no row matched"
// as "no price". Whichever is in force the panel has to say which — and say where that
// default row came from, because a table with no `default` row of its own is priced by
// the built-in template, and those rates are nobody's choice.
{
  check('config panel states the unmatched-model policy',
    configMarkup.includes('未匹配的模型：按 default 行计价') && configMarkup.includes('改为不计价'))
  check('config panel names where the default row came from', configMarkup.includes('你的价格表'), config.defaultSource)
  const templateDefault = render({
    initialSnapshot: snapshot,
    initialOpen: true,
    initialTab: 'config',
    initialConfig: { ...config, defaultSource: 'template' },
    initialOfficial: official,
  })
  check('a table with no default row is labelled as the built-in template, with a way out',
    templateDefault.includes('兜底行还没有') && templateDefault.includes('添加兜底行') &&
      templateDefault.includes('点「添加兜底行」能自己写，或点「应用官方价格」按官方列表第一条生成'),
    'no silent template rates, and no dead end')
  // The row list shows the rows the table actually has. Rendering the built-in template as if it
  // were a row made a delete that had worked look like a delete that did nothing.
  const defaultRowCell = (markup) => /<td class="dub-model"[^>]*>default<\/td>/.test(markup)
  check('a template-backed default is not listed as a row',
    !defaultRowCell(templateDefault) && defaultRowCell(configMarkup),
    'the row appears exactly when the file has one')
  check('with no row on disk there is nothing to delete, only something to add',
    (templateDefault.match(/class="dub-op"/g) || []).length === 2 * Object.keys(config.effective.overrides).length,
    `${(templateDefault.match(/class="dub-op"/g) || []).length} row actions, no catch-all actions`)

  const offUnmatched = { ...config, effective: { ...config.effective, priceUnmatchedModels: false } }
  const unmatchedMarkup = render({
    initialSnapshot: snapshot,
    initialOpen: true,
    initialTab: 'config',
    initialConfig: offUnmatched,
    initialOfficial: official,
  })
  check('the unmatched switch reflects the effective config',
    unmatchedMarkup.includes('未匹配的模型：不计价') && unmatchedMarkup.includes('改为按 default 计价'), 'off state rendered')

  // What that switch produces: a route with tokens and no amount. The panel has to name
  // it, or the money that is missing reads as a model that is free.
  const unpricedSnapshot = {
    ...snapshot,
    unpriced: [{ provider: 'hsianglee', model: 'glm-5.3-flash', tokens: 1234567, requests: 9 }],
  }
  const unpricedMarkup = render({ initialSnapshot: unpricedSnapshot, initialOpen: true })
  check('usage panel names the models the amount is missing',
    unpricedMarkup.includes('1 个模型没有价格') && unpricedMarkup.includes('hsianglee|glm-5.3-flash') &&
      unpricedMarkup.includes('单价配置'),
    'and points at the switch that causes it')
  check('a fully priced snapshot carries no such warning', !openMarkup.includes('个模型没有价格'))
  check('the snapshot reports the unpriced routes', Array.isArray(snapshot.unpriced), JSON.stringify(snapshot.unpriced))
}
// The table is the editor now: rows can be added, changed and removed from here, so every
// row carries its own actions and the columns that decide a number are all visible.
{
  const rowCount = Object.keys(config.effective.overrides).length
  check('the effective table is offered as editable',
    configMarkup.includes('可编辑') && configMarkup.includes('新增一行'))
  // The catch-all row is in the table too: it is the row every unmatched model lands on, so it
  // gets the same actions as any other — and it is the only one whose delete has a way back.
  const defaultOps = config.defaultSource === 'file' ? 2 : 1
  check('every row can be edited or deleted',
    (configMarkup.match(/class="dub-op"/g) || []).length === 2 * rowCount + defaultOps,
    `${(configMarkup.match(/class="dub-op"/g) || []).length} actions for ${rowCount} rows + the catch-all`)
  // Every column is left-aligned, header included: pushing the action buttons to the right
  // edge left the header row ragged ("倍率" and "峰谷" left, "操作" alone on the right with
  // a wide gap before it). Sharing the left edge puts 操作 directly above 编辑.
  check('the action buttons and their header share the left edge',
    configMarkup.includes('<th>操作</th>') &&
      /\.dub-table-ops\{display:flex;gap:6px\}/.test(clientSource) &&
      !/dub-table-ops\{[^}]*justify-content:flex-end/.test(clientSource) &&
      !/dub-table-op\{/.test(clientSource),
    '操作 sits above 编辑')
  // The multiplier and the peak/valley rule are both editable, so both are always shown —
  // a factor that changes the number must never be something you have to go and read JSON
  // for, and a row that inherits the table rule has to be distinguishable from one that
  // opts out.
  check('the multiplier, peak/valley and action columns are always there',
    configMarkup.includes('>倍率<') && configMarkup.includes('>峰谷<') && configMarkup.includes('>操作<'))
  check('a row with no rule of its own reports the table rule', configMarkup.includes('跟随表级'))

  // A row that carries a factor shows it in that column.
  const withMultiplier = {
    ...config,
    effective: {
      ...config.effective,
      overrides: { ...config.effective.overrides, 'some-gateway-model': { inputPerMillion: 4, outputPerMillion: 20, multiplier: 0.08 } },
    },
  }
  const markup = render({ initialSnapshot: snapshot, initialOpen: true, initialTab: 'config', initialConfig: withMultiplier, initialOfficial: official })
  check('a row carrying a multiplier shows it', markup.includes('some-gateway-model') && />0\.08</.test(markup))

  // The row editor: prefilled from the row it was handed, never a blank template, and it
  // offers the peak/valley choice that decides whether this row uses the holiday calendar.
  const flash = config.effective.overrides['deepseek-flash']
  const editMarkup = render({
    initialSnapshot: snapshot,
    initialOpen: true,
    initialTab: 'config',
    initialConfig: config,
    initialOfficial: official,
    initialEdit: { entryKey: 'deepseek-flash', row: flash },
  })
  check('the row editor opens prefilled with the row it was given',
    editMarkup.includes('编辑 deepseek-flash') && /value="1"/.test(editMarkup) &&
      /value="0\.02"/.test(editMarkup) && /value="4"/.test(editMarkup),
    'not an empty form')
  check('the editor offers the peak/valley choice',
    editMarkup.includes('跟随表级') && editMarkup.includes('不参与峰谷') && editMarkup.includes('自定义'))
  check('the editor can delete the row it is editing', editMarkup.includes('删除此行'))

  // A row that carries its own rule opens the fields for it — including the switch that
  // decides whether the holiday calendar applies to this row at all.
  const customRow = { inputPerMillion: 1, outputPerMillion: 4, timeOfUse: { enabled: true, peakMultiplier: 3, days: 'all', honorHolidays: false } }
  const customMarkup = render({
    initialSnapshot: snapshot,
    initialOpen: true,
    initialTab: 'config',
    initialConfig: config,
    initialOfficial: official,
    initialEdit: { entryKey: 'row-with-rule', row: customRow },
  })
  check('a row with its own rule opens the rule fields, holiday switch included',
    customMarkup.includes('节假日按空闲') && customMarkup.includes('09:00–12:00、14:00–18:00') && /value="3"/.test(customMarkup),
    'the window comes from the table rather than being left empty')
  const inheritMarkup = render({
    initialSnapshot: snapshot,
    initialOpen: true,
    initialTab: 'config',
    initialConfig: config,
    initialOfficial: official,
    initialEdit: { entryKey: 'row-inheriting', row: { inputPerMillion: 2 } },
  })
  check('a row that inherits keeps the rule fields out of the way',
    !inheritMarkup.includes('节假日按空闲') && !inheritMarkup.includes('峰时窗口沿用表级'))

  const newRowMarkup = render({
    initialSnapshot: snapshot,
    initialOpen: true,
    initialTab: 'config',
    initialConfig: config,
    initialOfficial: official,
    initialEdit: { entryKey: null, row: null },
  })
  check('a new row opens an empty form',
    /class="dub-form"[\s\S]{0,200}新增一行/.test(newRowMarkup) && newRowMarkup.includes('>保存<') &&
      !newRowMarkup.includes('删除此行'))

  // The write path: the map sent is the map that lands, renames included.
  check('saving a row writes the whole override map through the config route',
    /const saveRow = async \(nextKey, row\)/.test(clientSource) &&
      /await writeConfig\(\{ overrides \}, setListState, 'saved'\)/.test(clientSource) &&
      /if \(edit\?\.entryKey && edit\.entryKey !== nextKey\) delete overrides\[edit\.entryKey\]/.test(clientSource),
    'a rename is a delete plus an add')
  check('deleting a row writes the map without it',
    /const deleteRow = async \(entryKey, isDefault = false\)/.test(clientSource) &&
      /await writeConfig\(\{ overrides \}, setListState, 'deleted'\)/.test(clientSource))
  // The catch-all is a document field, not a row in the map — saved and deleted as `default`.
  check('the catch-all row is saved and deleted as the document field it is',
    /await writeConfig\(\{ default: row \}, setListState, 'saved'\)/.test(clientSource) &&
      /await writeConfig\(\{ default: null \}, setListState, 'deleted-default'\)/.test(clientSource) &&
      /默认.*回到内置模板|回到内置模板计价/.test(clientSource),
    'delete leaves a way back through the official list')

  // The catch-all form: the fields that actually apply, and nothing that would silently do
  // nothing (multiplier and timeOfUse are read from the table, not from `default`).
  const defaultForm = render({
    initialSnapshot: snapshot,
    initialOpen: true,
    initialTab: 'config',
    initialConfig: config,
    initialOfficial: official,
    initialEdit: { entryKey: null, row: config.defaultRow, isDefault: true },
  })
  check('the catch-all row opens prefilled, with its key fixed',
    defaultForm.includes('编辑 default 兜底行') && defaultForm.includes('default（兜底行，键固定）') &&
      /value="0\.02"/.test(defaultForm) && /value="4"/.test(defaultForm),
    'the fixture default row is 1 / 0.02 / 0 / 4')
  // The editor must show the row the *file* has, not the template-merged view: otherwise a
  // field the user cleared reads as the template's value and the next save writes it back.
  {
    const partial = {
      ...config,
      effective: { ...config.effective, default: { inputPerMillion: 3, cacheReadPerMillion: 0.05, cacheWritePerMillion: 0, outputPerMillion: 4.5, currency: 'cny' } },
      defaultRow: { inputPerMillion: 3 },
    }
    const partialTable = render({ initialSnapshot: snapshot, initialOpen: true, initialTab: 'config', initialConfig: partial, initialOfficial: official })
    check('a partial catch-all row shows the fields it actually has',
      /<td class="dub-model"[^>]*>default<\/td><td>3<\/td><td>—<\/td><td>—<\/td>/.test(partialTable),
      'cleared fields read as cleared, not as the template')
    const partialForm = render({
      initialSnapshot: snapshot,
      initialOpen: true,
      initialTab: 'config',
      initialConfig: partial,
      initialOfficial: official,
      initialEdit: { entryKey: null, row: partial.defaultRow, isDefault: true },
    })
    check('and the editor seeds from the file, not from the merged view',
      /value="3"/.test(partialForm) && !/value="0\.05"/.test(partialForm) && !/value="4\.5"/.test(partialForm),
      'so clearing a field sticks')
  }
  check('the catch-all form offers no key field and no peak/valley selector',
    !defaultForm.includes('placeholder="模型名 / provider|模型名'), !defaultForm.includes('不参与峰谷') &&
      !defaultForm.includes('峰时倍率'),
    'fields that would not take effect are not offered')
  check('the catch-all form says why those fields are missing',
    defaultForm.includes('倍率与峰谷是表级设置') && defaultForm.includes('删除兜底行'))
  // A save must never drop a field the form does not show.
  check('the editor preserves the fields it does not show',
    /const next = \{ \.\.\.\(row \?\? \{\}\) \}/.test(clientSource) &&
      /const preserved = Object\.keys\(row \?\? \{\}\)\.filter/.test(clientSource) &&
      /本行另有字段原样保留/.test(clientSource))
  check('the editor refuses a non-numeric price instead of writing NaN',
    /不是数字/.test(clientSource) && /键不能为空/.test(clientSource))
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
  /function seriesPoint\(label, title, src, dayClass\)/.test(clientSource) &&
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

// ── 9b. the year view: the year list belongs to the data ─────────────────────
// A year older than the loading window exists only in the store, so the panel cannot derive the
// list from the snapshot's days: the host answers with the years it actually holds and the picker
// renders exactly those. Nothing here is a hard-coded year — the first day a new year has a
// request it appears on its own — and the months come from `/usage-badge/year`, not the snapshot.
{
  const axisLabels = (markup) => [...markup.matchAll(/class="dub-axis"[^>]*>([^<]+)</g)].map((match) => match[1])
  const yearData = {
    year: 2025,
    days: 40,
    months: Array.from({ length: 12 }, (_, index) => ({
      month: `2025-${String(index + 1).padStart(2, '0')}`,
      label: `${index + 1}月`,
      amount: index === 2 ? 12.5 : 0,
      requests: index === 2 ? 4 : 0,
      input: index === 2 ? 1000 : 0,
      cacheRead: index === 2 ? 3000 : 0,
      cacheWrite: 0,
      output: index === 2 ? 500 : 0,
      providers:
        index === 2
          ? [{ provider: 'deepseek-official', amount: 12.5, requests: 4, input: 1000, cacheRead: 3000, cacheWrite: 0, output: 500 }]
          : [],
    })),
    total: { amount: 12.5, requests: 4, input: 1000, cacheRead: 3000, cacheWrite: 0, output: 500 },
    // The year's days, as `/usage-badge/year` sends them: the heatmap draws the calendar year
    // from these, so a day with usage has to shade above the empty ones.
    daily: [
      { date: '2025-03-15', amount: 12.5, requests: 4, input: 1000, cacheRead: 3000, cacheWrite: 0, output: 500, dayClass: 'normal', dayName: null, providers: [{ provider: 'deepseek-official', amount: 12.5, requests: 4, input: 1000, cacheRead: 3000, cacheWrite: 0, output: 500 }] },
    ],
  }
  // The host sends the years as **strings** (they are built from date keys) while the picker stores
  // the selected one as a number. The fixture keeps that real shape on purpose: a numeric `years`
  // array is a shape the host never sends, and it hid a bug where `years.includes(2025)` was always
  // false and every selection snapped back to the newest year.
  const thisYear = new Date().getFullYear()
  const years = [String(thisYear), '2025']
  const renderedCells = (markup) => (markup.match(/class="dub-hm-cell dub-hm-l\d"/g) || []).length
  const monthMarks = (markup) => (markup.match(/class="dub-hm-month"/g) || []).length
  const view = render({
    initialSnapshot: { ...snapshot, years },
    initialOpen: true,
    initialRange: 'year',
    initialYear: 2025,
    initialYearData: yearData,
  })

  check(
    'the year picker offers exactly the years the host reported, newest first',
    (view.match(/<option/g) || []).length === years.length &&
      years.every((year, index) => view.indexOf(`${year} 年`) > (index === 0 ? -1 : view.indexOf(`${years[index - 1]} 年`))),
    `${(view.match(/<option[^>]*>[^<]*/g) || []).join(' ')}`,
  )
  check('the asked-for year is the selected option', /<option[^>]*selected[^>]*>2025 年</.test(view), '2025')
  const monthLabels = axisLabels(view)
  check(
    'the year view draws twelve calendar months',
    monthLabels.join(',') === Array.from({ length: 12 }, (_, index) => `${index + 1}月`).join(','),
    monthLabels.join(','),
  )
  check('the year view plots a point per month and series', (view.match(/<circle/gi) || []).length === 12 * 4, String((view.match(/<circle/gi) || []).length))
  check('the stat cards are that year’s totals', view.includes('¥12.50') && view.includes('75.0%'), 'amount and hit rate summed from the twelve months')
  // The heatmap follows the selected year instead of disappearing: a calendar-year grid
  // (Jan 1 → Dec 31) is exactly what a 53-column picture is for, and for a finished year every
  // one of its days is drawn — no "future" squares and none of the next year's.
  const jan1 = new Date(2025, 0, 1)
  const lead = (jan1.getDay() + 6) % 7
  check(
    'the year view draws that calendar year’s own heatmap',
    view.includes('2025 年活跃度') && renderedCells(view) === 365 + lead,
    `${renderedCells(view)} cells, expected ${365 + lead} (Jan 1 2025 is a ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][lead]} with ${lead} leading day(s))`,
  )
  check('a selection that is not the newest year is actually honoured', view.includes('2025 年活跃度') && !view.includes(`${thisYear} 年活跃度`), 'not pinned to the newest year')
  // The last column of a calendar year holds the next January, whose cells are skipped as future —
  // it must not be captioned 「1月」 over a week of December.
  check('no month label sits over a column that is entirely in the future', monthMarks(view) === 12, `${monthMarks(view)} month label(s)`)
  check('the year heatmap is fed the year’s own days, not the snapshot’s window', /const yearDays = yearData\?\.daily \?\?/.test(clientSource))
  // The year in progress stops at today: cells for days that have not happened would be grey
  // squares whose hover card reads 「无用量」, which is a different statement from "not yet".
  const jan1OfThisYear = new Date(thisYear, 0, 1)
  const leadOfThisYear = (jan1OfThisYear.getDay() + 6) % 7
  const today = new Date()
  const dayOfYear = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - jan1OfThisYear) / 86400000) + 1
  const currentView = render({
    initialSnapshot: { ...snapshot, years },
    initialOpen: true,
    initialRange: 'year',
    initialYear: thisYear,
    initialYearData: { ...yearData, year: thisYear, daily: yearData.daily.map((day) => ({ ...day, date: `${thisYear}-03-15` })) },
  })
  check(
    'the year in progress is drawn up to today, not to December',
    renderedCells(currentView) === dayOfYear + leadOfThisYear,
    `${renderedCells(currentView)} cells, expected ${dayOfYear + leadOfThisYear}`,
  )
  // A host older than the `daily` field still serves the months. For the year still running the
  // snapshot's days *are* that year's days, so the grid keeps its colours; for a past year there
  // is no substitute, and an empty grid would be a lie — so it says why instead.
  const degraded = render({
    initialSnapshot: { ...snapshot, years },
    initialOpen: true,
    initialRange: 'year',
    initialYear: thisYear,
    initialYearData: { ...yearData, year: thisYear, daily: undefined },
  })
  check(
    'an older host still gets a shaded year heatmap for the year in progress',
    /dub-hm-l[1-4]/.test(degraded) && !degraded.includes('宿主半是旧版本'),
    'the snapshot’s days stand in for the current year',
  )
  const degradedPast = render({
    initialSnapshot: { ...snapshot, years },
    initialOpen: true,
    initialRange: 'year',
    initialYear: 2025,
    initialYearData: { ...yearData, year: 2025, daily: undefined },
  })
  check(
    'and for a past year it says the host is old instead of drawing an empty grid',
    degradedPast.includes('宿主半是旧版本') && !degradedPast.includes('dub-hm-cell'),
    'a note, not a blank picture',
  )
  // A selected year that has since disappeared (the cache was deleted, or another store is in
  // use) must not leave the picker showing one year and the chart another.
  const missingYear = render({
    initialSnapshot: { ...snapshot, years: [String(thisYear)] },
    initialOpen: true,
    initialRange: 'year',
    initialYear: 1999,
    initialYearData: { ...yearData, year: thisYear, daily: yearData.daily.map((day) => ({ ...day, date: `${thisYear}-03-15` })) },
  })
  check(
    'a selected year that no longer exists falls back to the newest one',
    missingYear.includes(`${thisYear} 年活跃度`) && !missingYear.includes('1999 年活跃度'),
    'the picker and the chart cannot disagree',
  )
  check('the months are fetched from the store, not read out of the snapshot', /\/usage-badge\/year\?year=\$\{selectedYear\}/.test(clientSource))
  check(
    'the host’s string years are normalised before being compared with the numeric selection',
    /const yearsKnown = Array\.isArray\(snapshot\.years\)/.test(clientSource) &&
      /\(yearsKnown \? snapshot\.years : \[\]\)/.test(clientSource) &&
      /\.map\(Number\)/.test(clientSource),
    'string years vs a numeric selection',
  )
  check('the year payload’s year is compared numerically too', /Number\(yearData\?\.year\) === Number\(selectedYear\)/.test(clientSource), 'otherwise the same year is fetched twice')

  const noYears = render({ initialSnapshot: { ...snapshot, years: [] }, initialOpen: true, initialRange: 'year' })
  check(
    'with no years stored the picker says so, and no loading note is left hanging',
    noYears.includes('缓存里还没有带日期的数据') && !noYears.includes('正在从缓存里读'),
    'note instead of an empty control, and no note that can never clear',
  )
  // An older host sends no `years` field at all, which is not the same as a cache with no dated
  // data — that would be a false statement about a cache that has plenty.
  const noField = render({
    initialSnapshot: { ...snapshot, years: undefined },
    initialOpen: true,
    initialRange: 'year',
  })
  check(
    'a host that reports no year list is described as old, not as an empty cache',
    noField.includes('宿主半是旧版本') && !noField.includes('缓存里还没有带日期的数据'),
    'the two cases are told apart',
  )
}

// ── 10. the contributions heatmap ────────────────────────────────────────────
// The 用量 panel carries a year-at-a-glance grid under the range chart: one square
// per calendar day, Monday-first columns, shaded by a single metric. It is built
// from the calendar rather than from the days that have rows, so a quiet day keeps
// its square instead of vanishing from the picture — the whole point of the view.
{
  const levels = [...openMarkup.matchAll(/class="dub-hm-cell dub-hm-l(\d)"/g)].map((match) => match[1])
  // Rows are Monday-first, so today sits in row (getDay()+6)%7 and the rest of its
  // week must stay undrawn: 53 columns of 7, minus the days that are still to come.
  const row = (new Date().getDay() + 6) % 7
  const expectedCells = 53 * 7 - (6 - row)
  const monthLabels = (openMarkup.match(/class="dub-hm-month"/g) || []).length
  const metricButtons = [...openMarkup.matchAll(/class="dub-hm-metric[^"]*">([^<]+)</g)].map((match) => match[1])

  check('the usage panel draws the year heatmap', openMarkup.includes('近一年活跃度'), 'block title')
  check('the heatmap squares every day of the last year, stopping at today',
    levels.length === expectedCells, `${levels.length} cells, expected ${expectedCells} (weekday row ${row})`)
  check('the heatmap shades the days that had usage',
    levels.some((level) => level !== '0'), `levels present: ${[...new Set(levels)].sort().join('')}`)
  check('the heatmap counts the year in its header',
    /共 ¥\d+\.\d{2} · 5 天有用量/.test(openMarkup), 'the fixture has usage on 5 days')
  check('the heatmap labels the months and the weekday rows',
    monthLabels >= 11 && monthLabels <= 13 && (openMarkup.match(/class="dub-hm-wd"/g) || []).length === 3,
    `${monthLabels} month labels, 3 weekday labels`)
  check('the heatmap legend shows all five steps',
    [0, 1, 2, 3, 4].every((level) => openMarkup.includes(`dub-hm-swatch dub-hm-l${level}`)))
  check('the heatmap offers a metric selector that defaults to 金额',
    metricButtons.join(',') === '金额,Token,请求数' && openMarkup.includes('dub-hm-metric dub-hm-metric-on">金额'),
    metricButtons.join(','))
  // The heatmap must draw its squares as rects: the chart checks above count
  // circles and stroked paths exactly, so anything else would drift their numbers.
  check('the heatmap adds no circles or stroked paths to the chart',
    levels.length > 0 && (openMarkup.match(/<circle/gi) || []).length === 24 * 4,
    `${(openMarkup.match(/<circle/gi) || []).length} circles`)
  check('the heatmap geometry is well formed',
    !/NaN/.test(openMarkup) && openMarkup.includes('viewBox="0 0 660 96"'), 'no NaN coordinates')
  // The tooltip's position is a fraction of the grid, so the svg must live inside a
  // wrapper exactly as tall as itself — the block also holds the title and legend,
  // and hanging the tooltip off that would place it off by their height.
  check('the heatmap tooltip hangs off the grid, not the whole block',
    /\.dub-hm-plot\{position:relative\}/.test(clientSource) && /dub-hm-plot[^>]*><svg/.test(openMarkup))

  // A snapshot with no days at all must still draw the year, all of it unshaded:
  // the grid is the calendar's, not the log's.
  const emptyHeat = render({ initialSnapshot: emptySnapshot, initialOpen: true })
  check('the heatmap survives a snapshot with no days',
    /共 ¥0\.00 · 0 天有用量/.test(emptyHeat) &&
      !/class="dub-hm-cell dub-hm-l[1-4]"/.test(emptyHeat) &&
      (emptyHeat.match(/class="dub-hm-cell dub-hm-l0"/g) || []).length === expectedCells,
    'an empty year is drawn, not skipped')

  // The scale, the filter and the future-day cut are behaviour a static render
  // cannot reach, so they are pinned in the source.
  check('the heatmap shades by quartiles of the days that had usage',
    /ranked = values\.filter\(\(value\) => value > 0\)/.test(clientSource) &&
      /cut\(0\.25\)/.test(clientSource) && /cut\(0\.75\)/.test(clientSource))
  check('the heatmap follows the provider filter', /entryTotals\(day, provider\)/.test(clientSource))
  check('the heatmap never squares a day after its end bound', /const future = key > end/.test(clientSource), 'the bound is the range end, not a fixed "today"')
  // The hover card is the chart's card, not a look-alike: same container class, same
  // row markup, same four series and formatters, fed from the day's four metrics.
  check('the heatmap hover card is the chart tooltip, re-anchored',
    /className: `dub-tip dub-hm-tip\$\{hover\.up \? ' dub-hm-tip-up' : ''\}`/.test(clientSource) &&
      !/\.dub-hm-tip\{[^}]*background:/.test(clientSource),
    'no second card style')
  // The grid is the last block in a scrolling body, so a card opened downward from a
  // square near the bottom edge is cut off by that edge. Which way it opens has to be
  // measured against the scroller: the row number cannot know where the edge is.
  check('the heatmap hover card is placed against the body edge, not the row',
    /function cardPlacement\(square, plot\)/.test(clientSource) &&
      /\.closest\?\.\('\.dub-body'\)/.test(clientSource) &&
      /below < HEAT_CARD_HEIGHT \+ HEAT_CARD_CLEARANCE && below <= above/.test(clientSource),
    'measured, not guessed from the row')
  check('the card is clamped inside the scrolling body, so it cannot be cut off',
    /Math\.min\(Math\.max\(wanted, box\.top \+ 4\), box\.bottom - HEAT_CARD_HEIGHT - 4\)/.test(clientSource) &&
      /cardPlacement\(event\.currentTarget, plotRef\.current\)/.test(clientSource) &&
      /ref: plotRef/.test(clientSource),
    'clamped into the scroller it was measured against')
  check('the heatmap hover card lists the same four series as the chart',
    /dub-tip dub-hm-tip[\s\S]{0,900}SERIES\.map\(\(series\) =>[\s\S]{0,400}series\.format\(hover\.metrics\?\.\[series\.key\]/.test(clientSource),
    '金额 / token 总量 / 请求数 / 缓存命中率')
  check('the heatmap card and the chart card share one metric definition',
    /function metricsOf\(src\)/.test(clientSource) &&
      /\.\.\.metricsOf\(src\)/.test(clientSource) && /metricsOf\(totals\)/.test(clientSource),
    'metricsOf feeds both')
  check('the heatmap hover card names the day, its holiday or its silence',
    /function heatTitle/.test(clientSource) && /quiet \? '无用量'/.test(clientSource))
  // Centre-anchoring alone pushes half the card past the dialog's clipped box at
  // either end of the year, so it is clamped the way the chart's tooltip is.
  check('the heatmap tooltip is clamped inside the block',
    /left: `clamp\(86px,[\s\S]{0,90}calc\(100% - 86px\)\)/.test(clientSource))
}

// ── 12. the row editor's guards, and what it seeds new rows from ─────────────
{
  // Currency is gone from the panel — every total here is CNY — but a row that still carries one
  // (an advanced, hand-written field) must keep it and say so, rather than losing it on a save.
  const usdRow = render({
    initialSnapshot: snapshot, initialOpen: true, initialTab: 'config', initialConfig: config,
    initialOfficial: official, initialEdit: { entryKey: 'usd-row', row: { inputPerMillion: 1, currency: 'USD' } },
  })
  check('the row editor offers no currency choice any more',
    !/<label>币种<\/label>/.test(usdRow) && !/value="usd"/.test(usdRow),
    'one currency: CNY')
  check('a row that still carries a currency keeps it, and says so',
    usdRow.includes('本行另有字段原样保留') && /currency=(?:&quot;|")USD/.test(usdRow),
    'preserved rather than silently dropped')

  // An old host sends none of the new fields, so the panel must not claim the catch-all row is
  // missing — that would be a guess, and a wrong one whenever the file has it.
  const oldHost = render({
    initialSnapshot: snapshot, initialOpen: true, initialTab: 'config',
    initialConfig: { ...config, apiVersion: undefined, defaultSource: undefined, defaultRow: undefined },
    initialOfficial: official,
  })
  check('an old host is not told the catch-all row is missing',
    !oldHost.includes('兜底行还没有') && oldHost.includes('未知（宿主是旧版本，重启后可见）'),
    'it says it cannot tell instead')

  // Guarding a save is the only thing standing between an open form and a silent revert: the
  // official apply rewrites same-named rows while the form is still holding the old values.
  check('a save refuses to land on a key that is already taken',
    /const taken = Object\.keys\(overrides\)\.find\(\(key\) => sameKey\(key, nextKey\)/.test(clientSource) &&
      /已有「\$\{taken\}」这一行/.test(clientSource),
    'case-insensitively, since resolution ignores case')
  check('a save refuses to revert a row that changed underneath it',
    /rowDigest\(overrides\[edit\.entryKey\] \?\? null\) !== rowDigest\(edit\.row \?\? null\)/.test(clientSource) &&
      /rowDigest\(config\?\.defaultRow \?\? null\) !== rowDigest\(edit\.row \?\? null\)/.test(clientSource))
  check('a new custom peak/valley rule starts from the table policy, not a guess',
    /days: tou \? named\(tou\.days\) \?\? '' : named\(tableRule\?\.days\) \?\? 'weekday'/.test(clientSource) &&
      /honorHolidays: tou \? tou\.honorHolidays !== false : tableRule\?\.honorHolidays !== false/.test(clientSource),
    'so one row cannot quietly contradict the table on holidays or weekends')
  check('a custom rule says when the table has no windows to inherit',
    /表级也没有峰时窗口/.test(clientSource))
  check('an all-empty catch-all row is refused rather than written',
    /兜底行至少要填一个值/.test(clientSource), 'it would be a key that does nothing')
}

// ── 13. the host-half handshake ──────────────────────────────────────────────
// The host half is loaded when DSH starts while this bundle is re-read on every page load, so
// "changed the host half, refreshed the page" is a normal state — and in it a write the host
// does not understand comes back 200 and does nothing, which is indistinguishable from a
// broken button. The two constants must agree, and a mismatch has to be announced.
{
  const hostVersion = Number(/export const HOST_API_VERSION = (\d+)/.exec(hostSource)?.[1])
  const clientVersion = Number(/const REQUIRED_HOST_API = (\d+)/.exec(clientSource)?.[1])
  check('the two halves agree on the host API version',
    Number.isFinite(hostVersion) && hostVersion === clientVersion, `${hostVersion} vs ${clientVersion}`)
  check('the config route reports it', config.apiVersion === hostVersion, `${config.apiVersion} vs ${hostVersion}`)
  check('a matching host produces no warning', !configMarkup.includes('宿主半还是旧版本'))

  // The banner belongs to the dialog, not to the config tab: someone who only ever opens 用量
  // still has to be told that the host is older, because 「按年」 and the switches depend on it.
  const usageTab = {
    initialSnapshot: { ...snapshot, years: [new Date().getFullYear()] },
    initialOpen: true,
    initialTab: 'usage',
  }
  check(
    'a version mismatch is announced on the usage tab too',
    render({ ...usageTab, initialConfig: { ...config, apiVersion: clientVersion - 1 } }).includes('宿主半还是旧版本'),
    'the note sits above the tabs',
  )
  check(
    'and a matching host stays quiet on the usage tab',
    !render({ ...usageTab, initialConfig: config }).includes('宿主半还是旧版本'),
    'no warning when the halves agree',
  )

  const stale = render({
    initialSnapshot: snapshot,
    initialOpen: true,
    initialTab: 'config',
    initialConfig: { ...config, apiVersion: clientVersion - 1 },
    initialOfficial: official,
  })
  check('an older host is announced instead of leaving dead buttons',
    stale.includes('宿主半还是旧版本') && stale.includes('重启客户端'), 'the fix is named')
  check('a host that does not report a version at all counts as older',
    render({
      initialSnapshot: snapshot,
      initialOpen: true,
      initialTab: 'config',
      initialConfig: { ...config, apiVersion: undefined },
      initialOfficial: official,
    }).includes('宿主半还是旧版本'))
  const newer = render({
    initialSnapshot: snapshot,
    initialOpen: true,
    initialTab: 'config',
    initialConfig: { ...config, apiVersion: clientVersion + 1 },
    initialOfficial: official,
  })
  check('a newer host asks for a refresh instead', newer.includes('界面是旧版本') && newer.includes('刷新页面'))
}

// ── 11. verdict ──────────────────────────────────────────────────────────────
cleanupHomes()
const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) {
  console.error(`\nFAILED:\n${failed.map((c) => `  - ${c.label}${c.detail ? ` (${c.detail})` : ''}`).join('\n')}`)
  process.exitCode = 1
}
