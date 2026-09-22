/**
 * Host-half smoke test.
 *
 * Mounts the plugin against a minimal fake cordis context, calls the summary
 * route with a fake request/response pair, and prints what the browser half
 * would render. This exercises the real fold, the real pricing math and the real
 * route handler without needing a running DSH host.
 *
 * Usage:
 *   node test/smoke.mjs                      # against the real $DSH_HOME
 *   DSH_HOME=/tmp/fixture node test/smoke.mjs
 */

import { apply, inject, name } from '../lib/index.js'

/** Minimal stand-in for a cordis context carrying only what this plugin uses. */
function createFakeContext() {
  const routes = []
  const disposers = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    effect(body) {
      const dispose = body()
      disposers.push(dispose)
      return dispose
    },
  }
  return { ctx, routes, disposers }
}

/** Minimal stand-in for an incoming message. */
function createFakeRequest(method, url, body) {
  return {
    method,
    url,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, listener) {
      if (event === 'data' && body !== undefined) listener(Buffer.from(body))
      if (event === 'end') listener()
      return this
    },
    destroy() {},
  }
}

/** Minimal stand-in for a server response that captures what was written. */
function createFakeResponse() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(chunk) {
      this.body = chunk ? Buffer.from(chunk).toString('utf8') : ''
    },
  }
}

const { ctx, routes } = createFakeContext()
apply(ctx)

const route = routes.find((r) => r.path === '/usage-badge')
if (!route) throw new Error('the plugin registered no /usage-badge route')

const res = createFakeResponse()
await route.handler(createFakeRequest('GET', '/usage-badge/summary'), res)
if (res.status !== 200) throw new Error(`summary route answered ${res.status}: ${res.body}`)

const snapshot = JSON.parse(res.body)
const fmt = (n) => new Intl.NumberFormat('en-US').format(n)
const money = (n) => `¥${Number(n).toFixed(2)}`

console.log(`plugin:      ${name} (inject: ${inject.join(', ')})`)
console.log(`sessions:    ${snapshot.status.sessions}`)
console.log(`log files:   ${snapshot.status.files}`)
console.log(`fold:        ${snapshot.status.folded} folded in ${snapshot.status.ms}ms`)
console.log(`currency:    ${snapshot.currency} @ ${snapshot.exchangeRate}`)
console.log(`badge:       ${money(snapshot.badge.amount)}  (${snapshot.badge.date})`)
console.log(`today:       ${fmt(snapshot.today.requests)} requests, ` +
  `${fmt(snapshot.today.input)} uncached-in, ${fmt(snapshot.today.cacheRead)} cache-read, ` +
  `${fmt(snapshot.today.cacheWrite)} cache-write, ${fmt(snapshot.today.output)} out`)
console.log(`band:        ${snapshot.band.enabled ? snapshot.band.label : 'off'} (x${snapshot.band.multiplier})` +
  `, day class: ${snapshot.band.dayClass}${snapshot.band.dayName ? ` (${snapshot.band.dayName})` : ''}`)
const calendar = snapshot.calendar ?? {}
// Only the holiday count is in the snapshot: 调休 working days do not affect pricing (the
// published policy makes every weekend off-peak regardless), so they are recorded for audit in
// the bundled table and reported by `/config`, not carried in every poll.
console.log(`calendar:    ${calendar.enabled ? 'on' : 'off'}` +
  (calendar.enabled ? ` covering ${calendar.years?.join(',')} (${calendar.counts?.holidays} holidays)` : '') +
  (calendar.missingYears?.length ? `, missing ${calendar.missingYears.join(',')}` : ''))
console.log(`days kept:   ${snapshot.days.length}`)
console.log(`providers:   ${snapshot.today.providers.map((p) => `${p.provider}=${money(p.amount)}`).join('  ') || '(none today)'}`)
console.log('\nlast 7 days with activity:')
for (const day of snapshot.days.slice(0, 7)) {
  console.log(`  ${day.date}  ${money(day.amount).padStart(10)}  ${fmt(day.requests).padStart(6)} req  ` +
    `${day.providers.map((p) => p.provider).join(',')}`)
}
const hourly = snapshot.today.hourly.filter((h) => h.requests > 0)
console.log(`\ntoday's active hours: ${hourly.map((h) => `${h.hour}:${money(h.amount)}`).join('  ') || '(none)'}`)

// What the year heatmap will shade. The grid itself belongs to the browser half;
// what it needs from here is a year of day amounts, and a year that is either empty
// or all in one step renders flat — worth seeing on the data rather than only in
// the picture. The five steps are quartiles of the days that had usage, as there.
const cutoff = new Date()
cutoff.setDate(cutoff.getDate() - 370)
const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`
const yearAmounts = snapshot.days.filter((day) => day.date >= cutoffKey).map((day) => day.amount)
const ranked = yearAmounts.filter((value) => value > 0).sort((a, b) => a - b)
const cut = (p) => (ranked.length ? ranked[Math.min(ranked.length - 1, Math.floor(p * ranked.length))] : 0)
const buckets = [0, 0, 0, 0, 0]
for (const value of yearAmounts) {
  const step = value <= 0 ? 0 : value <= cut(0.25) ? 1 : value <= cut(0.5) ? 2 : value <= cut(0.75) ? 3 : 4
  buckets[step] += 1
}
console.log(`\nheatmap year: ${ranked.length} day(s) with usage out of ${yearAmounts.length} kept, ` +
  `best ${money(ranked.at(-1) ?? 0)}`)
console.log(`  shades:     ${buckets.map((count, step) => `L${step}=${count}`).join('  ')}` +
  `  (cut at ${money(cut(0.25))} / ${money(cut(0.5))} / ${money(cut(0.75))})`)
