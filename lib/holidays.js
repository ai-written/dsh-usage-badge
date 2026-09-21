/**
 * dsh-usage-badge — the legal-holiday calendar behind the peak/valley rule.
 *
 * DeepSeek's published policy is explicit about holidays:
 *
 * > 空闲时段价格为高峰时段价格的一半。北京时间周一至周五（**不含中国法定节假日**）
 * > 9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及**中国法定节假日全天均为空闲时段**。
 *
 * So a weekday holiday must be billed entirely off-peak, and a 调休 weekend that
 * the State Council turns into a working day must be billed as a working day
 * again. Both directions need the real calendar, which is why this module ships
 * one rather than inferring from the weekday alone.
 *
 * The bundled table is per-year data transcribed from the State Council notices
 * (see `holidays-cn.json`, which records document numbers and URLs). A year the
 * table does not cover is reported rather than guessed, and `config.holidays`
 * can always add or override dates by hand.
 *
 * @module dsh-usage-badge/holidays
 */

import { readFileSync } from 'node:fs'

import { dayKey } from './pricing.js'

const TABLE_URL = new URL('./holidays-cn.json', import.meta.url)

let bundledCache = null

/** Expand an inclusive `YYYY-MM-DD` range into its dates, walking in UTC to dodge DST. */
function expandRange(from, to) {
  const out = []
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return out
  for (let ms = start; ms <= end; ms += 86400000) out.push(new Date(ms).toISOString().slice(0, 10))
  return out
}

/**
 * Load and expand the bundled calendar.
 *
 * @returns {{holidays: Map<string,string>, workdays: Set<string>, years: Set<string>, source: object}|null}
 *   `holidays` maps a date to its festival name; `null` when the bundled file
 *   cannot be read, which is treated as "no bundled calendar" rather than a crash.
 */
export function loadBundledTable() {
  if (bundledCache !== null) return bundledCache
  try {
    const raw = JSON.parse(readFileSync(TABLE_URL, 'utf8'))
    const holidays = new Map()
    const workdays = new Set()
    const years = new Set()
    for (const [year, data] of Object.entries(raw.years ?? {})) {
      years.add(year)
      for (const block of data.blocks ?? []) {
        for (const date of expandRange(block.from, block.to)) holidays.set(date, block.name ?? '')
      }
      for (const date of data.workdays ?? []) workdays.add(date)
    }
    bundledCache = { holidays, workdays, years, source: raw.source ?? {}, note: raw.note ?? '' }
  } catch {
    bundledCache = { holidays: new Map(), workdays: new Set(), years: new Set(), source: {}, note: '' }
  }
  return bundledCache
}

/**
 * Resolve the day-classification rules a pricing document asks for.
 *
 * The document opts in through a top-level `holidays` object, kept separate from
 * `timeOfUse` because it answers a different question: `timeOfUse` says *when*
 * peak windows are, `holidays` says *which days* they can apply to at all. It also
 * means one holiday calendar governs every per-model `timeOfUse` row.
 *
 * | `holidays.source` | meaning |
 * |---|---|
 * | absent / `"none"` | no holiday handling — the historical behavior |
 * | `"cn"` | the bundled China calendar, plus any `extra` dates |
 * | `"custom"` | only `extra` dates, no bundled calendar |
 *
 * Only *holidays* affect pricing. The bundled table also records the 调休 working
 * days, and they are deliberately not resolved into a rule here: the published
 * policy makes every weekend off-peak in full, and a 调休 day is still a 周末, so
 * treating one as a working day would charge peak rates on a day the page calls
 * off-peak. The dates stay in the data file as provenance.
 *
 * @param {object|undefined} config - the pricing document's `holidays` field.
 * @returns {{enabled:boolean, holidays:Map<string,string>, source:object, years:Set<string>, missingYears:string[]}}
 */
export function resolveHolidayRules(config) {
  const source = config?.source === 'cn' || config?.source === 'custom' ? config.source : 'none'
  const bundled = source === 'cn' ? loadBundledTable() : { holidays: new Map(), workdays: new Set(), years: new Set(), source: {} }
  const enabled = source !== 'none'

  const holidays = new Map(enabled && source === 'cn' ? bundled.holidays : [])
  for (const date of config?.extra ?? []) if (typeof date === 'string' && date) holidays.set(date.trim(), '自定义')

  // A year with no bundled block is worth surfacing: its holidays would otherwise
  // silently be treated as ordinary weekdays.
  const missingYears = []
  if (enabled && source === 'cn') {
    const thisYear = new Date().getFullYear()
    for (const year of [thisYear, thisYear + 1]) {
      if (!bundled.years.has(String(year))) missingYears.push(String(year))
    }
  }

  return { enabled, holidays, source: bundled.source, years: bundled.years, missingYears, source_kind: source }
}

/**
 * Classify one date under the resolved rules.
 *
 * @param {string} date - local `YYYY-MM-DD` day key.
 * @param {object} rules - result of {@link resolveHolidayRules}.
 * @returns {{class:'holiday'|'normal', name:string|null}}
 */
export function classifyDate(date, rules) {
  if (!rules?.enabled) return { class: 'normal', name: null }
  const name = rules.holidays?.get?.(date)
  if (name !== undefined) return { class: 'holiday', name: name || null }
  return { class: 'normal', name: null }
}

/**
 * The holiday-related facts the browser half displays: whether the calendar is on,
 * which years it covers, and how the current day is classified.
 */
export function describeCalendar(rules, now = Date.now()) {
  const date = dayKey(now)
  const today = classifyDate(date, rules)
  return {
    enabled: Boolean(rules?.enabled),
    source: rules?.source_kind ?? 'none',
    years: [...(rules?.years ?? [])].sort(),
    missingYears: rules?.missingYears ?? [],
    today: { date, class: today.class, name: today.name },
    counts: { holidays: rules?.holidays?.size ?? 0 },
  }
}
