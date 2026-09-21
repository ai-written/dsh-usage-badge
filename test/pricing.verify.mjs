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
 *   1. case-insensitive override-key matching and its priority order
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
    'the cache also lives in that directory',
    listDataDir(own).includes('cache.json'),
    listDataDir(own).join(','),
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

finish()
