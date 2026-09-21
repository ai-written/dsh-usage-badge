/**
 * One entry point for all suites.
 *
 * The host timezone is pinned before anything else runs. DeepSeek's peak window is
 * defined in Beijing time and the captured prices pages are Beijing-time pages, so
 * the assertions describe UTC+8 behaviour — but a CI runner defaults to UTC, where
 * four of them legitimately produce different numbers. The suite must not depend on
 * where it happens to run, so it declares the zone it is about.
 *
 * Setting this *here* rather than in each suite matters: the suites are imported
 * dynamically afterwards, so their module bodies already see the pinned zone.
 *
 * Usage:
 *   node test/all.mjs        # same as: npm test
 */

process.env.TZ = 'Asia/Shanghai'

const SUITES = [
  './manifest.verify.mjs',
  './pricing.verify.mjs',
  './holidays.verify.mjs',
  './official-pricing.verify.mjs',
  './client.render.mjs',
]

for (const suite of SUITES) await import(suite)
