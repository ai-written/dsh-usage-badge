/**
 * End-to-end pricing verification.
 *
 * Drives the real host half over throwaway homes containing synthetic session logs
 * and asserts exact costs. The first case is ported from the desktop shell's
 * `pricing-key-case.verify.mjs` — the same fixtures and the same expected numbers —
 * so it proves the ported pricing model resolves override rows identically rather
 * than merely looking similar.
 *
 * Covered:
 *   1. case-insensitive override-key matching and its priority order, including the
 *      `model-*` family rows that follow the exact keys
 *   2. the context-length tier (strictly-above threshold, compact "128K" form)
 *   3. peak/valley `days` rules against crafted weekday/weekend timestamps
 *
 * The holiday calendar and the published price list have their own suites
 * (`holidays.verify.mjs`, `official-pricing.verify.mjs`).
 *
 * Usage:
 *   node test/pricing.verify.mjs
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  close,
  createChecker,
  listDataDir,
  makeHome,
  mount,
  readPricing,
  request,
  summaryFor,
  writeLegacyPricing,
  writePricing,
  writeSession,
} from './helpers.mjs'

const { check, finish } = createChecker('PRICING VERIFY')

const now = Date.now()
const at = (year, month, day, hour, minute = 30) => new Date(year, month - 1, day, hour, minute).getTime()
const key = (year, month, day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

// ── 1. override-key matching (ported from the shell's pricing-key-case verify) ─
{
  const root = makeHome('keycase')
  const cases = [
    { dir: 's1', provider: 'hsianglee', model: 'deepseek-flash' }, // row "deepSeek-flash"
    { dir: 's2', provider: 'Hsianglee', model: 'deepseek-FLASH-2' }, // row "hsianglee|deepseek-flash-2"
    { dir: 's3', provider: 'p3', model: 'mixed' }, // exact row "mixed"
    { dir: 's4', provider: 'p4', model: 'MIXED' }, // case-only -> first row "MiXeD"
    { dir: 's5', provider: 'p5', model: 'unlisted-model' }, // default row
  ]
  for (const [index, item] of cases.entries()) {
    writeSession(root, item.dir, { ...item, time: now - 60000 - index, input: 1000 })
  }
  // Every rate is a whole multiple of the 1e6 denominator, so 1000 input tokens
  // cost exactly rate/1000 in the total currency.
  const rate = (m) => ({ inputPerMillion: m, cacheReadPerMillion: m, cacheWritePerMillion: m, outputPerMillion: m, currency: 'cny' })
  writePricing(root, {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    multiplier: 1,
    default: rate(1e6),
    overrides: {
      'deepSeek-flash': rate(3e6),
      'hsianglee|deepseek-flash-2': rate(4e6),
      MiXeD: rate(5e6),
      mixed: rate(7e6),
    },
  })

  const snapshot = await summaryFor(root, 'keycase')
  const byProvider = new Map(snapshot.today.providers.map((row) => [row.provider, row.amount]))
  const expected = new Map([
    ['hsianglee', 3000],
    ['Hsianglee', 4000],
    ['p3', 7000],
    ['p4', 5000],
    ['p5', 1000],
  ])
  for (const [provider, want] of expected) {
    const got = byProvider.get(provider)
    check(`key-case: ${provider} -> ${want}`, got !== undefined && close(got, want), `got ${got}`)
  }
  const dayTotal = [...expected.values()].reduce((sum, value) => sum + value, 0)
  check(`key-case: day total ${dayTotal}`, close(snapshot.today.amount, dayTotal), `got ${snapshot.today.amount}`)
  const providerSum = snapshot.today.providers.reduce((sum, row) => sum + row.amount, 0)
  check('key-case: provider rows sum to the day total', close(providerSum, snapshot.today.amount), `got ${providerSum}`)
  check('key-case: badge is the CNY day total', close(snapshot.badge.amount, dayTotal), `got ${snapshot.badge.amount}`)
}

// ── 2. context-length tier ───────────────────────────────────────────────────
// Each case gets its own home with a single request, so every assertion reads as
// one unambiguous number rather than an arithmetic puzzle.
{
  // Cache reads are priced at zero here on purpose: the cost then reflects only
  // the input tokens, so a doubled total proves the *context size* crossed the
  // threshold rather than the price of the cache tokens themselves.
  const rate = { inputPerMillion: 1e6, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: 'cny' }
  const pricing = {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    multiplier: 1,
    default: rate,
    // Compact threshold form, applied to every route without its own rule.
    contextMultiplier: { threshold: '128K', multiplier: 2 },
    overrides: {},
  }

  const cases = [
    { name: 'below', usage: { input: 100000 }, want: 100000, note: '100k input stays at x1' },
    { name: 'at', usage: { input: 128000 }, want: 128000, note: 'exactly at the threshold stays at x1 (strictly-greater)' },
    { name: 'above', usage: { input: 130000 }, want: 260000, note: '130k input is charged at x2' },
    { name: 'above-cache', usage: { input: 100000, cacheRead: 50000 }, want: 200000, note: 'cache tokens count toward the context size' },
  ]

  for (const item of cases) {
    const root = makeHome(`context-${item.name}`)
    writePricing(root, pricing)
    writeSession(root, 's', { provider: 'p', model: 'm', time: now, ...item.usage })
    const snapshot = await summaryFor(root, `context-${item.name}`)
    check(`context tier: ${item.note}`, close(snapshot.today.amount, item.want), `got ${snapshot.today.amount}, want ${item.want}`)
  }
}

// ── 3. peak / valley `days` rules ────────────────────────────────────────────
{
  const root = makeHome('tou')
  const rate = { inputPerMillion: 1e6, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: 'cny' }
  writePricing(root, {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    multiplier: 1,
    default: rate,
    // 2026-01-05 is a Monday and 2026-01-10 is a Saturday.
    timeOfUse: { enabled: true, days: 'weekday', peakMultiplier: 2, valleyMultiplier: 1, peakRanges: [[9, 12]] },
    overrides: {},
  })
  const mondayPeak = at(2026, 1, 5, 10, 30)
  const mondayValley = at(2026, 1, 5, 20, 30)
  const saturdayPeak = at(2026, 1, 10, 10, 30)
  // Guard the fixtures: if these dates stop being a Monday and a Saturday, the
  // assertions below would fail for a reason that has nothing to do with pricing.
  const isoWeekday = (ms) => ((new Date(ms).getDay() + 6) % 7) + 1
  check('time-of-use fixture: 2026-01-05 is a Monday', isoWeekday(mondayPeak) === 1, `got weekday ${isoWeekday(mondayPeak)}`)
  check('time-of-use fixture: 2026-01-10 is a Saturday', isoWeekday(saturdayPeak) === 6, `got weekday ${isoWeekday(saturdayPeak)}`)

  writeSession(root, 'mon-peak', { provider: 'p', model: 'm', time: mondayPeak, input: 1000 })
  writeSession(root, 'mon-valley', { provider: 'p', model: 'm', time: mondayValley, input: 1000 })
  writeSession(root, 'sat-peak', { provider: 'p', model: 'm', time: saturdayPeak, input: 1000 })

  const snapshot = await summaryFor(root, 'tou')
  const byDate = new Map(snapshot.days.map((day) => [day.date, day.amount]))
  check('time-of-use: Monday 10:30 is peak (x2)', close(byDate.get(key(2026, 1, 5)), 1000 + 1000 * 2), `got ${byDate.get(key(2026, 1, 5))}`)
  check('time-of-use: Saturday is outside days:"weekday", so x1', close(byDate.get(key(2026, 1, 10)), 1000), `got ${byDate.get(key(2026, 1, 10))}`)
  // Without a holiday calendar the days rule is the whole story, which is the
  // behavior every existing config keeps.
  check('time-of-use: no calendar means no holiday handling', snapshot.calendar?.enabled === false, JSON.stringify(snapshot.calendar?.enabled))
}

// ── 4. a per-model multiplier and a cross-currency row ───────────────────────
{
  const root = makeHome('multiplier')
  writePricing(root, {
    exchangeRate: 7,
    totalCurrency: 'cny',
    multiplier: 1,
    default: { inputPerMillion: 1e6, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: 'cny' },
    // `x2` overrides only the multiplier, so it inherits the default row's price.
    overrides: { x2: { multiplier: 2 }, 'usd-row': { inputPerMillion: 1e6, currency: 'usd' } },
  })
  writeSession(root, 'a', { provider: 'p', model: 'x2', time: now - 2000, input: 1000 })
  writeSession(root, 'b', { provider: 'p', model: 'usd-row', time: now - 1000, input: 1000 })
  const snapshot = await summaryFor(root, 'multiplier')
  // 1000 tokens at 1e6 per million is 1000 units. The x2 row doubles it; the USD
  // row is converted into the CNY total at the configured rate of 7.
  check('a per-model multiplier stacks on the inherited price', close(snapshot.today.amount, 2000 + 7000), `got ${snapshot.today.amount}`)
  check('the converted row reports its own provider', snapshot.today.providers.length === 1, String(snapshot.today.providers.length))
}

// ── 5. file ownership: every file the plugin owns sits in its own directory ──
// The shared `storages` root also holds harness caches, so a plugin file left
// there is one a user cannot attribute. These checks pin the layout, and pin the
// migration fallback that keeps a pre-isolation install working.
{
  const RATE = { inputPerMillion: 1e6, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: 'cny' }

  // (a) the canonical location wins, and is reported as the source
  const own = makeHome('own-dir')
  writePricing(own, { exchangeRate: 6.74, totalCurrency: 'cny', default: RATE, overrides: {} })
  writeSession(own, 's', { provider: 'p', model: 'm', time: now, input: 1000 })
  // A summary request is what awaits the fold; the cache is persisted right after
  // it, so the layout is inspected only once that has happened.
  const ownSnapshot = await summaryFor(own, 'own-dir')
  check('the fold ran before the layout check', ownSnapshot.status.folded === 1, String(ownSnapshot.status.folded))
  const ownConfig = await request(own, 'own-dir-config', 'GET', '/usage-badge/config')
  check(
    'reads the price table from its own directory',
    ownConfig.body.paths.pricingSource === join(own, 'storages', 'usage-badge', 'pricing.json'),
    String(ownConfig.body.paths.pricingSource),
  )
  check(
    'the cache also lives in that directory, in whichever store this runtime offers',
    ownConfig.body.paths.cache === join(own, 'storages', 'usage-badge', `${ownConfig.body.paths.cacheKind === 'json' ? 'cache.json' : 'cache.sqlite'}`) &&
      listDataDir(own).includes(ownConfig.body.paths.cacheKind === 'json' ? 'cache.json' : 'cache.sqlite'),
    `${ownConfig.body.paths.cacheKind}: ${listDataDir(own).join(',')}`,
  )
  check(
    'nothing else is written into the shared storages root',
    readdirSync(join(own, 'storages')).join(',') === 'usage-badge',
    readdirSync(join(own, 'storages')).join(','),
  )

  // (b) a pre-isolation install still works: the legacy file is read as a fallback
  const legacy = makeHome('legacy-dir')
  writeLegacyPricing(legacy, { exchangeRate: 6.74, totalCurrency: 'cny', default: RATE, overrides: {} })
  const legacyConfig = await request(legacy, 'legacy-dir', 'GET', '/usage-badge/config')
  check(
    'falls back to the pre-isolation path when the new one is absent',
    legacyConfig.body.paths.pricingSource === join(legacy, 'storages', 'usage-pricing.json'),
    String(legacyConfig.body.paths.pricingSource),
  )

  // (c) the first write migrates: the canonical file appears, the legacy one is
  // left exactly as it was rather than being silently rewritten or deleted
  const legacyBefore = readFileSync(join(legacy, 'storages', 'usage-pricing.json'), 'utf8')
  const written = await request(legacy, 'legacy-write', 'PUT', '/usage-badge/config', { exchangeRate: 7.5 })
  check('a write succeeds against a legacy install', written.status === 200 && written.body.ok === true, `${written.status}`)
  check('the write created the canonical file', readPricing(legacy).exchangeRate === 7.5, String(readPricing(legacy).exchangeRate))
  check(
    'the legacy file is left untouched',
    readFileSync(join(legacy, 'storages', 'usage-pricing.json'), 'utf8') === legacyBefore,
  )
  const afterMigrate = await request(legacy, 'legacy-read-2', 'GET', '/usage-badge/config')
  check(
    'after migrating, the canonical file is the one read',
    afterMigrate.body.paths.pricingSource === join(legacy, 'storages', 'usage-badge', 'pricing.json'),
    String(afterMigrate.body.paths.pricingSource),
  )
}

// ── 6. family rows: a trailing `*` on the model part ─────────────────────────
// `deepseek-flash-*` prices every suffixed variant of a family, which is how a
// gateway's dated or experimental model ids get a price without a row per name.
// Each case gets its own provider so one amount reads as one rule.
{
  const root = makeHome('family')
  const rate = (m) => ({ inputPerMillion: m, cacheReadPerMillion: m, cacheWritePerMillion: m, outputPerMillion: m, currency: 'cny' })
  const cases = [
    { provider: 'p1', model: 'deepseek-flash-preview' }, // the pure family shape covers a suffixed name
    { provider: 'p3', model: 'deepseek-v4-pro' }, // an exact row outranks every family row
    { provider: 'p4', model: 'deepseek-flash-preview-turbo' }, // the longest prefix is the most specific
    { provider: 'p5', model: 'deepseek-nova-1' }, // family prefixes match case-insensitively
    { provider: 'p6', model: 'solaris-1' }, // the `*|family` shape covers every provider
    { provider: 'p7', model: 'deepseek-wide-1' }, // the pure shape outranks `provider|family`
    { provider: 'p8', model: 'zenith-tiny-1' }, // a family row may carry only a multiplier
    { provider: 'p9', model: 'orion-1' }, // `provider|family` applies when nothing broader does
  ]
  for (const [index, item] of cases.entries()) {
    writeSession(root, `f${index}`, { ...item, time: now - 60000 - index, input: 1000 })
  }
  writePricing(root, {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    multiplier: 1,
    default: rate(1e6),
    overrides: {
      'deepseek-flash-*': rate(3e6),
      'deepseek-flash-preview-*': rate(11e6),
      'deepseek-v4-pro': rate(9e6),
      'DEEPSEEK-NOVA-*': rate(13e6),
      '*|solaris-*': rate(15e6),
      'deepseek-*': rate(5e6),
      'p7|deepseek-*': rate(7e6),
      'p9|orion-*': rate(17e6),
      'zenith-*': { multiplier: 2 },
      // A lone `*` has never matched anything and must not become a catch-all: if it
      // did, every expectation below would collapse onto this rate.
      '*': rate(99e6),
    },
  })

  const snapshot = await summaryFor(root, 'family')
  const byProvider = new Map(snapshot.today.providers.map((row) => [row.provider, row.amount]))
  const expected = new Map([
    ['p1', 3000],
    ['p3', 9000],
    ['p4', 11000],
    ['p5', 13000],
    ['p6', 15000],
    ['p7', 5000],
    ['p8', 2000],
    ['p9', 17000],
  ])
  for (const [provider, want] of expected) {
    const got = byProvider.get(provider)
    check(`family row: ${provider} -> ${want}`, got !== undefined && close(got, want), `got ${got}`)
  }
  check('family row: a lone `*` never applies', ![...byProvider.values()].includes(99000), 'a bare `*` stays inert')
}

// ── 7. family rows: the star is a suffix, not a separator ────────────────────
// `deepseek-flash-*` covers `deepseek-flash-preview` but not `deepseek-flash` itself;
// `deepseek-flash*` (no separator) covers both. Two providers, two amounts.
{
  const root = makeHome('family-edge')
  const rate = (m) => ({ inputPerMillion: m, cacheReadPerMillion: m, cacheWritePerMillion: m, outputPerMillion: m, currency: 'cny' })
  writePricing(root, {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    multiplier: 1,
    default: rate(1e6),
    overrides: { 'deepseek-flash-*': rate(3e6), 'deepseek-flash*': rate(4e6) },
  })
  writeSession(root, 'bare', { provider: 'bare', model: 'deepseek-flash', time: now, input: 1000 })
  writeSession(root, 'suffixed', { provider: 'suffixed', model: 'deepseek-flash-preview', time: now - 1000, input: 1000 })

  const snapshot = await summaryFor(root, 'family-edge')
  const byProvider = new Map(snapshot.today.providers.map((row) => [row.provider, row.amount]))
  check('family row: `deepseek-flash*` covers the unsuffixed name', close(byProvider.get('bare'), 4000), `got ${byProvider.get('bare')}`)
  check('family row: the longer `deepseek-flash-*` wins on the suffixed name',
    close(byProvider.get('suffixed'), 3000), `got ${byProvider.get('suffixed')}`)
}

// ── 8. the model-prefix fallback: an official row covers its own variants ────
// The published list writes `deepseek-flash`; a gateway serves `deepseek-flash-preview`.
// Nobody should have to hand-write a row for that, so an ordinary row also prices the
// suffixed variants of its own name — provided a separator follows the prefix.
{
  const root = makeHome('prefix-fallback')
  const rate = (m) => ({ inputPerMillion: m, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: 'cny' })
  const cases = [
    { provider: 'pb1', model: 'deepseek-flash-preview' }, // 3000 — the fallback itself
    { provider: 'pb2', model: 'deepseek-flash' }, // 3000 — the exact row
    { provider: 'pb3', model: 'deepseek-flash-20260901' }, // 3000 — another suffix
    { provider: 'pb4', model: 'DeepSeek-Flash-Preview' }, // 3000 — case-insensitive
    { provider: 'pb5', model: 'deepseek-flashpreview' }, // 1000 — no separator, so the shorter `deepseek` wins
    { provider: 'pb6', model: 'gpt-4o' }, // 2000 — `gpt-4` must not swallow a different model
    { provider: 'pb7', model: 'gpt-4-turbo' }, // 5000 — a separator does match
    { provider: 'pb8', model: 'deepseek-v4-flash-vision-exp-v2' }, // 9000 — the longest prefix wins
  ]
  for (const [index, item] of cases.entries()) {
    writeSession(root, `b${index}`, { ...item, time: now - 60000 - index, input: 1000 })
  }
  writePricing(root, {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    multiplier: 1,
    default: rate(2e6),
    overrides: {
      deepseek: rate(1e6),
      'deepseek-flash': rate(3e6),
      'gpt-4': rate(5e6),
      'deepseek-v4-flash-vision-exp': rate(9e6),
    },
  })

  const snapshot = await summaryFor(root, 'prefix-fallback')
  const byProvider = new Map(snapshot.today.providers.map((row) => [row.provider, row.amount]))
  const expected = new Map([
    ['pb1', 3000],
    ['pb2', 3000],
    ['pb3', 3000],
    ['pb4', 3000],
    ['pb5', 1000],
    ['pb6', 2000],
    ['pb7', 5000],
    ['pb8', 9000],
  ])
  for (const [provider, want] of expected) {
    const got = byProvider.get(provider)
    check(`prefix fallback: ${provider} -> ${want}`, got !== undefined && close(got, want), `got ${got}`)
  }
}

// ── 9. the fallback switch, and the explicit family row that outlives it ─────
{
  const rate = (m) => ({ inputPerMillion: m, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: 'cny' })
  const table = (fallback) => ({
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    multiplier: 1,
    default: rate(2e6),
    modelPrefixFallback: fallback,
    overrides: { 'deepseek-nova': rate(4e6), 'deepseek-flash-*': rate(7e6) },
  })

  for (const [name, fallback, want] of [
    ['on', true, 4000],
    ['off', false, 2000],
  ]) {
    const root = makeHome(`prefix-${name}`)
    writePricing(root, table(fallback))
    writeSession(root, 'implicit', { provider: 'implicit', model: 'deepseek-nova-9', time: now, input: 1000 })
    writeSession(root, 'explicit', { provider: 'explicit', model: 'deepseek-flash-preview', time: now - 1000, input: 1000 })
    const snapshot = await summaryFor(root, `prefix-${name}`)
    const byProvider = new Map(snapshot.today.providers.map((row) => [row.provider, row.amount]))
    check(`prefix fallback ${name}: an ordinary row ${fallback ? 'covers' : 'does not cover'} its suffixed variant`,
      close(byProvider.get('implicit'), want), `got ${byProvider.get('implicit')}, want ${want}`)
    check(`prefix fallback ${name}: an explicit \`*\` family row matches either way`,
      close(byProvider.get('explicit'), 7000), `got ${byProvider.get('explicit')}`)
    const config = await request(root, `prefix-${name}-config`, 'GET', '/usage-badge/config')
    check(`prefix fallback ${name}: reported by the config route`,
      config.body.effective.modelPrefixFallback === fallback, String(config.body.effective.modelPrefixFallback))
  }
}

// ── 10. the panel's switches, over the route, without a restart ──────────────
// The buttons in the panel perform this exact pair: a PUT, then re-read the summary.
// Mounting once and issuing every call to that one instance is what proves the new value
// is picked up in-process, rather than only after the host is restarted. Two routes: one
// the table can price, one nothing matches.
{
  const root = makeHome('prefix-put')
  const rate = (m) => ({ inputPerMillion: m, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: 'cny' })
  writePricing(root, {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    multiplier: 1,
    default: rate(2e6),
    overrides: { 'deepseek-nova': rate(4e6) },
  })
  writeSession(root, 's', { provider: 'p', model: 'deepseek-nova-9', time: now, input: 1000 })
  writeSession(root, 'u', { provider: 'q', model: 'unknown-9', time: now - 1000, input: 1000 })

  const amountOf = (body, provider) => (body.today.providers.find((row) => row.provider === provider) ?? {}).amount
  const { call } = await mount(root, 'prefix-put')
  const before = await call('GET', '/usage-badge/summary')
  check('the fallback is on unless the table says otherwise', close(amountOf(before.body, 'p'), 4000), `got ${amountOf(before.body, 'p')}`)
  check('an unmatched model is priced by the default row unless told otherwise',
    close(amountOf(before.body, 'q'), 2000), `got ${amountOf(before.body, 'q')}`)

  const off = await call('PUT', '/usage-badge/config', { modelPrefixFallback: false })
  check('the prefix switch goes through the config route',
    off.status === 200 && off.body.effective.modelPrefixFallback === false, `${off.status}`)
  check('the prefix switch is persisted to the price table',
    readPricing(root).modelPrefixFallback === false, JSON.stringify(readPricing(root).modelPrefixFallback))

  const afterOff = await call('GET', '/usage-badge/summary')
  check('turning the prefix fallback off re-prices in the same process',
    close(amountOf(afterOff.body, 'p'), 2000), `got ${amountOf(afterOff.body, 'p')}`)

  const on = await call('PUT', '/usage-badge/config', { modelPrefixFallback: true })
  const afterOn = await call('GET', '/usage-badge/summary')
  check('turning it back on restores the family price',
    on.status === 200 && close(amountOf(afterOn.body, 'p'), 4000), `got ${amountOf(afterOn.body, 'p')}`)

  const silent = await call('PUT', '/usage-badge/config', { priceUnmatchedModels: false })
  const afterSilent = await call('GET', '/usage-badge/summary')
  check('the unmatched switch goes through the config route',
    silent.status === 200 && silent.body.effective.priceUnmatchedModels === false, `${silent.status}`)
  check('an unmatched model stops contributing an amount',
    close(amountOf(afterSilent.body, 'q'), 0), `got ${amountOf(afterSilent.body, 'q')}`)
  check('but its tokens are still counted', afterSilent.body.today.input === 2000, String(afterSilent.body.today.input))
  check('and the snapshot names the route it left unpriced',
    afterSilent.body.unpriced.some((row) => row.provider === 'q' && row.model === 'unknown-9' && row.tokens === 1000),
    JSON.stringify(afterSilent.body.unpriced))
  check('a priced route is never listed as unpriced', afterSilent.body.unpriced.length === 1, JSON.stringify(afterSilent.body.unpriced))

  const back = await call('PUT', '/usage-badge/config', { priceUnmatchedModels: true })
  const afterBack = await call('GET', '/usage-badge/summary')
  check('turning unmatched pricing back on restores the estimate',
    back.status === 200 && close(amountOf(afterBack.body, 'q'), 2000) && afterBack.body.unpriced.length === 0,
    `got ${amountOf(afterBack.body, 'q')}`)

  // The row editor's write path: it sends the whole override map, so the map it sends is
  // the map that lands, and nothing else in the document is disturbed.
  const saved = await call('PUT', '/usage-badge/config', {
    overrides: { 'deepseek-nova': rate(4e6), 'unknown-9': { inputPerMillion: 5e6, currency: 'cny' } },
  })
  const afterRow = await call('GET', '/usage-badge/summary')
  const written = readPricing(root)
  check('a row written through the config route prices the model it names',
    saved.status === 200 && close(amountOf(afterRow.body, 'q'), 5000), `${saved.status}, q=${amountOf(afterRow.body, 'q')}`)
  check('the whole map lands and the rest of the document survives',
    written.overrides['unknown-9']?.inputPerMillion === 5e6 &&
      written.overrides['deepseek-nova']?.inputPerMillion === 4e6 &&
      written.priceUnmatchedModels === true && written.modelPrefixFallback === true,
    JSON.stringify(written))
}

// ── 11. which routes count as matched, when unmatched models are not priced ──
// "Matched" means the table has something to say about the model — it does not require
// the row to define a rate. A row carrying only a multiplier still counts, and the
// `default` row supplies whatever it leaves out.
{
  const root = makeHome('unpriced')
  const rate = (m) => ({ inputPerMillion: m, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: 'cny' })
  const cases = [
    { provider: 'p1', model: 'deepseek-nova-9' }, // the prefix row matches
    { provider: 'p2', model: 'nothing-known' }, // nothing matches at all
    { provider: 'p3', model: 'anything' }, // `p3|*` matches
    { provider: 'p4', model: 'mult-only' }, // a row that only sets a multiplier still matches
  ]
  for (const [index, item] of cases.entries()) {
    writeSession(root, `u${index}`, { ...item, time: now - 60000 - index, input: 1000 })
  }
  writePricing(root, {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    multiplier: 1,
    default: rate(2e6),
    priceUnmatchedModels: false,
    overrides: { 'deepseek-nova': rate(4e6), 'p3|*': rate(1e6), 'mult-only': { multiplier: 3 } },
  })

  const snapshot = await summaryFor(root, 'unpriced')
  const byProvider = new Map(snapshot.today.providers.map((row) => [row.provider, row.amount]))
  check('unpriced: a prefix row still prices its route', close(byProvider.get('p1'), 4000), `got ${byProvider.get('p1')}`)
  check('unpriced: `provider|*` counts as a match', close(byProvider.get('p3'), 1000), `got ${byProvider.get('p3')}`)
  check('unpriced: a row carrying only a multiplier counts as a match',
    close(byProvider.get('p4'), 6000), `got ${byProvider.get('p4')}`)
  check('unpriced: an unmatched model contributes no amount', close(byProvider.get('p2'), 0), `got ${byProvider.get('p2')}`)
  check('unpriced: the day total leaves it out', close(snapshot.today.amount, 11000), `got ${snapshot.today.amount}`)
  check('unpriced: its tokens are still counted', snapshot.today.input === 4000, String(snapshot.today.input))
  check('unpriced: only the unmatched route is reported',
    snapshot.unpriced.length === 1 && snapshot.unpriced[0].provider === 'p2' &&
      snapshot.unpriced[0].model === 'nothing-known' && snapshot.unpriced[0].tokens === 1000,
    JSON.stringify(snapshot.unpriced))
}

// ── 12. peak/valley against hand-written rows ────────────────────────────────
// The table's `timeOfUse` is what turns a row's rates into peak/valley rates, so it has
// to reach every row — including ones written by hand long after the table was applied.
// A row may carry a rule of its own instead, and that rule replaces the table's *whole*
// rule rather than merging with it.
{
  const root = makeHome('row-tou')
  const rate = (m) => ({ inputPerMillion: m, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: 'cny' })
  const peakRule = (multiplier) => ({ enabled: true, days: 'weekday', peakMultiplier: multiplier, valleyMultiplier: 1, peakRanges: [[9, 12]] })
  writePricing(root, {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    multiplier: 1,
    default: rate(1e6),
    timeOfUse: peakRule(2),
    holidays: { source: 'cn' },
    overrides: {
      inherits: {},
      'own-rule': { timeOfUse: peakRule(3) },
      'family-*': { timeOfUse: peakRule(4) },
      'opted-out': { timeOfUse: { enabled: false } },
      partial: { timeOfUse: { enabled: true, days: 'weekday', peakRanges: [[9, 12]] } },
      'ignores-holidays': { timeOfUse: { ...peakRule(5), honorHolidays: false } },
    },
  })
  // 2026-01-05 is a Monday (peak window at 10:30, valley at 20:30); 2026-01-01 is 元旦,
  // a Thursday inside the same window, so only the calendar can make it off-peak.
  const mondayPeak = at(2026, 1, 5, 10, 30)
  const mondayValley = at(2026, 1, 5, 20, 30)
  const newYearPeak = at(2026, 1, 1, 10, 30)
  const cases = [
    { provider: 'p1', model: 'inherits', time: mondayPeak },
    { provider: 'p2', model: 'own-rule', time: mondayPeak },
    { provider: 'p3', model: 'family-1', time: mondayPeak },
    { provider: 'p4', model: 'opted-out', time: mondayPeak },
    { provider: 'p5', model: 'partial', time: mondayPeak },
    { provider: 'p6', model: 'inherits', time: mondayValley },
    { provider: 'p7', model: 'own-rule', time: newYearPeak },
    { provider: 'p8', model: 'ignores-holidays', time: newYearPeak },
  ]
  for (const [index, item] of cases.entries()) {
    writeSession(root, `r${index}`, { ...item, input: 1000 })
  }
  const isoWeekday = (ms) => ((new Date(ms).getDay() + 6) % 7) + 1
  check('row time-of-use fixture: the dates are the weekdays the assertions assume',
    isoWeekday(mondayPeak) === 1 && isoWeekday(newYearPeak) === 4, `${isoWeekday(mondayPeak)}, ${isoWeekday(newYearPeak)}`)

  const snapshot = await summaryFor(root, 'row-tou')
  const amountOf = (date, provider) => {
    const day = snapshot.days.find((row) => row.date === date)
    return day ? (day.providers.find((row) => row.provider === provider) ?? {}).amount : undefined
  }
  const monday = key(2026, 1, 5)

  check("a hand-written row with no rule of its own follows the table's peak multiplier",
    close(amountOf(monday, 'p1'), 2000), `got ${amountOf(monday, 'p1')}`)
  check("...and the valley side of that same row", close(amountOf(monday, 'p6'), 1000), `got ${amountOf(monday, 'p6')}`)
  check("a row may carry its own rule, which replaces the table's for its route",
    close(amountOf(monday, 'p2'), 3000), `got ${amountOf(monday, 'p2')}`)
  check("a prefix row's rule reaches the models it covers",
    close(amountOf(monday, 'p3'), 4000), `got ${amountOf(monday, 'p3')}`)
  check('a row can switch peak/valley off for itself', close(amountOf(monday, 'p4'), 1000), `got ${amountOf(monday, 'p4')}`)
  // Replaced whole, not merged: a row that forgets `peakMultiplier` charges no peak
  // surcharge at all, rather than quietly inheriting the table's x2.
  check("a row's rule replaces the table's wholesale, footgun included",
    close(amountOf(monday, 'p5'), 1000), `got ${amountOf(monday, 'p5')}`)
  // The calendar is not per row: one holiday calendar governs every rule there is.
  check("the holiday calendar overrides even a row's own peak rule",
    close(amountOf(key(2026, 1, 1), 'p7'), 1000), `got ${amountOf(key(2026, 1, 1), 'p7')}`)
  // ...unless the rule declines it, which is what a gateway that never heard of 国庆节
  // needs: same holiday, same hour, and it charges its own peak multiplier.
  check('a row can decline the holiday calendar and charge peak on a holiday anyway',
    close(amountOf(key(2026, 1, 1), 'p8'), 5000), `got ${amountOf(key(2026, 1, 1), 'p8')}`)
}

// ── 13. the holiday calendar can be declined table-wide too ──────────────────
// Same flag at the top level, for a table whose every row belongs to a provider that runs
// its own windows: say it once instead of on every row.
{
  const root = makeHome('tou-holidays-off')
  const rate = { inputPerMillion: 1e6, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: 'cny' }
  writePricing(root, {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    multiplier: 1,
    default: rate,
    timeOfUse: { enabled: true, days: 'weekday', peakMultiplier: 2, valleyMultiplier: 1, peakRanges: [[9, 12]], honorHolidays: false },
    holidays: { source: 'cn' },
    overrides: { inherits: {} },
  })
  // 2026-01-01 is 元旦, a Thursday inside the window.
  writeSession(root, 'ny', { provider: 'p', model: 'inherits', time: at(2026, 1, 1, 10, 30), input: 1000 })

  const snapshot = await summaryFor(root, 'tou-holidays-off')
  const day = snapshot.days.find((row) => row.date === key(2026, 1, 1))
  check('the table itself can decline the holiday calendar',
    close(day?.amount, 2000), `got ${day?.amount}`)
  check('the calendar is still on, and still labels the day', day?.dayClass === 'holiday' && day?.dayName === '元旦',
    `${day?.dayClass}/${day?.dayName}`)
}

// ── 14. a `null` override row is skipped, not fatal ──────────────────────────
// The exact-key path has always ignored a null row; the prefix path did not, so one null row plus
// one suffixed model made every price lookup throw and `/summary` answer 500 — reachable by
// hand-editing the file, or by a PUT that leaves the key behind. A null row means "no row".
{
  const root = makeHome('null-row')
  const rate = (m) => ({ inputPerMillion: m, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: 'cny' })
  writePricing(root, { exchangeRate: 6.74, totalCurrency: 'cny', multiplier: 1, default: rate(2e6), overrides: { 'deepseek-nova': null } })
  writeSession(root, 'prefixed', { provider: 'p', model: 'deepseek-nova-9', time: now, input: 1000 })
  writeSession(root, 'exact', { provider: 'q', model: 'deepseek-nova', time: now - 1000, input: 1000 })

  const snapshot = await summaryFor(root, 'null-row')
  const byProvider = new Map(snapshot.today.providers.map((row) => [row.provider, row.amount]))
  check('a null row is skipped by the prefix path too, not fatal',
    close(byProvider.get('p'), 2000), `got ${byProvider.get('p')}`)
  check('and by the exact path, as it always was', close(byProvider.get('q'), 2000), `got ${byProvider.get('q')}`)
}

// ── 15. writing the catch-all row: it is replaced, not merged ────────────────
// The editor sends the whole row it was showing, so a field the user cleared has to disappear.
// Merging (the older behaviour) made clearing a field a silent no-op that still reported success,
// and left an unwanted currency or rate with no way to remove it from the panel.
{
  const root = makeHome('config-write')
  const rate = (m) => ({ inputPerMillion: m, cacheReadPerMillion: 0.5, cacheWritePerMillion: 0.1, outputPerMillion: m, currency: 'cny' })
  writePricing(root, { exchangeRate: 6.74, totalCurrency: 'cny', multiplier: 1, default: rate(2e6), overrides: {} })
  const { call } = await mount(root, 'config-write')

  const cleared = await call('PUT', '/usage-badge/config', { default: { inputPerMillion: 3 } })
  check('a catch-all row is written exactly as sent, cleared fields included',
    cleared.status === 200 && JSON.stringify(readPricing(root).default) === JSON.stringify({ inputPerMillion: 3 }),
    JSON.stringify(readPricing(root).default))
  const afterClear = await call('GET', '/usage-badge/config')
  check('what it leaves out falls back to the template in the effective view',
    afterClear.body.effective.default?.cacheReadPerMillion === 0.05, JSON.stringify(afterClear.body.effective.default))

  // A row that says nothing at all is not a row: `{}` still takes every rate from the template, so
  // reporting it as the user's would hide exactly what `defaultSource` exists to reveal.
  await call('PUT', '/usage-badge/config', { default: {} })
  const afterEmpty = await call('GET', '/usage-badge/config')
  check('an empty catch-all row reads as the template, not as the user\'s row',
    afterEmpty.body.defaultSource === 'template' && afterEmpty.body.defaultRow === null,
    JSON.stringify({ source: afterEmpty.body.defaultSource, row: afterEmpty.body.defaultRow }))

  // And the round trip the panel's delete + regenerate relies on, over the real route.
  await call('PUT', '/usage-badge/config', { default: { inputPerMillion: 7, outputPerMillion: 7 } })
  const restored = await call('GET', '/usage-badge/config')
  check('a row with values in it is the user\'s row again',
    restored.body.defaultSource === 'file' && restored.body.defaultRow?.inputPerMillion === 7,
    JSON.stringify(restored.body.defaultRow))
}

finish()
