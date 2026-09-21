/**
 * Live check against the published pricing pages.
 *
 * `official-pricing.verify.mjs` runs offline against captured fixtures, so it can
 * only prove the parser still matches the pages as they were captured. This script
 * fetches the real pages and diffs the parse against what the fixtures produce,
 * which is how a change on DeepSeek's side shows up as a clear signal instead of
 * silently stale prices.
 *
 * It needs the network, so it is not part of `npm test`.
 *
 * Usage:
 *   node test/official-pricing.live.mjs
 */

import { readFileSync } from 'node:fs'

import { OFFICIAL_SOURCES, fetchOfficialPricing, parseOfficialPricing } from '../lib/official-pricing.js'

const fixture = (name) => readFileSync(new URL(`./fixtures/pricing.${name}.html`, import.meta.url), 'utf8')

/** Fixture file name per source id: the captured pages predate the `zh-cn` id. */
const FIXTURE_NAME = { 'zh-cn': 'zh', en: 'en' }

/** Format one per-million price in the page's currency. */
const fmt = (amount, cur) => (cur === 'usd' ? '$' : '¥') + String(Number(Number(amount).toFixed(4)))

let drifted = 0
for (const id of Object.keys(OFFICIAL_SOURCES)) {
  const source = OFFICIAL_SOURCES[id]
  console.log(`\n=== ${id} — ${source.url}`)
  let live
  try {
    live = await fetchOfficialPricing({ source: id })
  } catch (error) {
    console.log(`  FETCH/PARSE FAILED: ${error.message}`)
    drifted++
    continue
  }

  const captured = parseOfficialPricing(fixture(FIXTURE_NAME[id] ?? id), { url: source.url })
  console.log(`  currency: ${live.currency}   models: ${live.models.map((m) => m.model).join(', ')}`)
  for (const model of live.models) {
    console.log(
      `  ${model.model.padEnd(16)}` +
        `  off-peak in/cache/out ${fmt(model.offPeak.input, live.currency)}/${fmt(model.offPeak.cacheRead, live.currency)}/${fmt(model.offPeak.output, live.currency)}` +
        `   peak ${fmt(model.peak.input, live.currency)}/${fmt(model.peak.cacheRead, live.currency)}/${fmt(model.peak.output, live.currency)}`,
    )
  }
  console.log(`  peak windows: ${JSON.stringify(live.policy.peakRangesSource)} ${live.policy.sourceZone?.name ?? '(zone not stated)'}`)
  console.log(`  local windows: ${JSON.stringify(live.policy.peakRangesLocal)}  (host offset ${live.policy.localOffsetMinutes} min)`)
  console.log(`  holidays off-peak: ${live.policy.holidaysOffPeak}   weekends off-peak: ${live.policy.weekendsOffPeak}`)
  console.log(`  retired ids: ${live.aliases.names.join(', ') || '(none)'}`)

  const liveNumbers = JSON.stringify(live.models)
  const capturedNumbers = JSON.stringify(captured.models)
  if (liveNumbers !== capturedNumbers) {
    console.log('  ⚠ prices differ from the captured fixture — refresh test/fixtures/ and re-run npm test')
    drifted++
  }
  if (JSON.stringify(live.policy.peakRangesSource) !== JSON.stringify(captured.policy.peakRangesSource)) {
    console.log('  ⚠ peak windows differ from the captured fixture')
    drifted++
  }
}

console.log(drifted === 0 ? '\nLIVE CHECK: both pages still parse and match the fixtures' : `\nLIVE CHECK: ${drifted} difference(s) found`)
process.exitCode = drifted === 0 ? 0 : 2
