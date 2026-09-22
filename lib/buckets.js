/**
 * dsh-usage-badge — the token bucket model and its stored form.
 *
 * A bucket is one (provider, model) route on one day: token totals, a 24-slot hourly
 * breakdown for the day chart, and the raw per-request records that let the pricing layer
 * apply a different multiplier to each request rather than pricing a day flat.
 *
 * This module owns that shape and its JSON representation, because two very different
 * places need to agree on it: the folder builds buckets while reading session logs, and the
 * cache store reads them back years later. Keeping the codec here means a store never has to
 * know what a bucket is — it moves `{ date: { routeKey: bucket } }` slices in and out.
 *
 * @module dsh-usage-badge/buckets
 */

import { initHourly } from './pricing.js'

/** Bucket key and display name used when a log records no provider/model. */
export const UNKNOWN = 'unknown'

/** A fresh, empty bucket for one route. */
export function emptyBucket(provider, model) {
  return {
    provider,
    model,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    requests: 0,
    hourly: initHourly(),
    usageRecords: [],
  }
}

/**
 * Add `source` into `target`.
 *
 * A missing per-request list marks a legacy aggregate row: mixing one into a
 * bucket that has a list would silently drop the aggregate's share from the
 * context-tier price, so the list is dropped to `null` for the whole bucket
 * instead, and that bucket falls back to flat pricing. Appending is looped rather
 * than spread because one day bucket can hold hundreds of thousands of requests,
 * which would overflow the argument list long before it exhausted memory.
 */
export function addBucket(target, source) {
  target.input += Number(source?.input) || 0
  target.cacheRead += Number(source?.cacheRead) || 0
  target.cacheWrite += Number(source?.cacheWrite) || 0
  target.output += Number(source?.output) || 0
  target.requests += Number(source?.requests) || 0
  if (!Array.isArray(target.hourly)) target.hourly = initHourly()
  if (Array.isArray(source?.hourly)) {
    for (let hour = 0; hour < 24; hour++) {
      const from = source.hourly[hour]
      const to = target.hourly[hour]
      if (!from || !to) continue
      to.input += Number(from.input) || 0
      to.cacheRead += Number(from.cacheRead) || 0
      to.cacheWrite += Number(from.cacheWrite) || 0
      to.output += Number(from.output) || 0
      to.requests += Number(from.requests) || 0
    }
  }
  if (!Array.isArray(target.usageRecords) || !Array.isArray(source?.usageRecords)) {
    target.usageRecords = null
  } else {
    for (const usage of source.usageRecords) {
      if (usage && typeof usage === 'object') target.usageRecords.push(usage)
    }
  }
}

/**
 * One day, as storable JSON: `{ routeKey: bucket }`.
 *
 * The bucket objects are handed over by reference; every store either stringifies the slice
 * immediately or replaces the whole entry, and the folder never mutates a bucket it has
 * already handed over (a re-fold builds fresh ones), so aliasing is safe and avoids copying
 * a day's worth of per-request records on every save.
 */
export function serializeDay(dayObj) {
  const routes = {}
  for (const [key, bucket] of dayObj ?? []) routes[key] = bucket
  return routes
}

/** The inverse of {@link serializeDay}, rebuilding the buckets' invariants as it goes. */
export function deserializeDay(routes) {
  const dayObj = new Map()
  for (const [key, source] of Object.entries(routes ?? {})) {
    if (!source || typeof source !== 'object') continue
    const bucket = emptyBucket(String(source.provider ?? UNKNOWN), String(source.model ?? UNKNOWN))
    addBucket(bucket, source)
    dayObj.set(key, bucket)
  }
  return dayObj
}

/** A whole session's days, as storable JSON: `{ date: { routeKey: bucket } }`. */
export function serializeDays(days) {
  const plain = {}
  for (const [date, dayObj] of days ?? []) plain[date] = serializeDay(dayObj)
  return plain
}

/** The inverse of {@link serializeDays}. */
export function deserializeDays(plain) {
  const days = new Map()
  for (const [date, routes] of Object.entries(plain ?? {})) {
    if (!routes || typeof routes !== 'object') continue
    days.set(date, deserializeDay(routes))
  }
  return days
}
