/**
 * Legal-holiday verification.
 *
 * DeepSeek's published peak/valley rule is defined in terms of the Chinese public
 * holiday calendar:
 *
 *   「北京时间周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00 为高峰时段；
 *     其余时段，包括周末及中国法定节假日全天均为空闲时段。」
 *
 * Two consequences are pinned here, and the second is the one that is easy to get
 * wrong: a weekday holiday is billed off-peak all day, and a **weekend stays
 * off-peak even when the State Council declares it a 调休 working day**, because
 * the page calls weekends off-peak in full rather than deferring to the working-day
 * calendar. Turning the calendar off restores the plain weekday-only behavior.
 *
 * Every cost assertion reads the *specific* day row, not today's total, because the
 * fixtures deliberately sit on dates other than the run date.
 *
 * Usage:
 *   node test/holidays.verify.mjs
 */

import {
  close,
  createChecker,
  makeHome,
  request,
  summaryFor,
  writePricing,
  writeSession,
} from './helpers.mjs'

const { check, finish } = createChecker('HOLIDAY VERIFY')

/** 1 token == 1 unit of cost at this rate, so a total reads directly as a multiple. */
const RATE = { inputPerMillion: 1e6, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0, currency: 'cny' }
const TOU = { enabled: true, days: 'weekday', peakMultiplier: 2, valleyMultiplier: 1, peakRanges: [[9, 12], [14, 18]] }

/** Local wall-clock timestamp for a date at a given hour. */
const at = (year, month, day, hour, minute = 30) => new Date(year, month - 1, day, hour, minute).getTime()
const key = (year, month, day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

/**
 * Price one 1000-input-token request on one date and return that date's row.
 *
 * @returns {Promise<{amount:number, row:object, calendar:object}>}
 */
async function dayFor(scenario, dateKey, moment, holidays) {
  const root = makeHome(scenario)
  writePricing(root, {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    multiplier: 1,
    default: RATE,
    timeOfUse: TOU,
    overrides: {},
    ...(holidays ? { holidays } : {}),
  })
  writeSession(root, 's', { provider: 'p', model: 'm', time: moment, input: 1000 })
  const snapshot = await summaryFor(root, scenario)
  const row = snapshot.days.find((day) => day.date === dateKey)
  if (!row) throw new Error(`no row for ${dateKey}; rows: ${snapshot.days.map((d) => d.date).join(', ')}`)
  return { amount: row.amount, row, calendar: snapshot.calendar, band: snapshot.band }
}

// ── 1. the calendar itself: coverage, counts and provenance ──────────────────
{
  const root = makeHome('calendar')
  writePricing(root, { default: RATE, timeOfUse: TOU, holidays: { source: 'cn' } })
  writeSession(root, 's', { provider: 'p', model: 'm', time: at(2026, 9, 21), input: 1000 })
  const { calendar } = await summaryFor(root, 'calendar').then((snapshot) => ({ calendar: snapshot.calendar }))

  check('calendar is on', calendar.enabled)
  check('calendar covers 2025 and 2026', calendar.years.includes('2025') && calendar.years.includes('2026'), calendar.years.join(','))
  check('2026 is not reported missing', !calendar.missingYears.includes('2026'), calendar.missingYears.join(','))
  // 2025: 1+8+3+5+3+8 = 28 holidays, 5 调休 workdays. 2026: 3+9+3+5+3+3+7 = 33, 6.
  check('the expanded calendar holds 61 holidays', calendar.counts.holidays === 61, String(calendar.counts.holidays))
  // The 调休 dates are recorded for audit but are not a pricing input, so they must
  // not appear as a resolved rule.
  check('the resolved rules carry no 调休 working days', calendar.counts.workdays === undefined, JSON.stringify(calendar.counts))
  check('2026-09-21 (a plain Monday) is not a holiday', calendar.today.class === 'normal', JSON.stringify(calendar.today))

  const { body } = await request(root, 'calendar-table', 'GET', '/usage-badge/config')
  const table = body.holidayTable
  const expectHoliday = ['2026-01-01', '2026-02-17', '2026-04-05', '2026-05-03', '2026-06-20', '2026-09-26', '2026-10-01']
  check('the 2026 holiday dates are present', expectHoliday.every((date) => table.holidays.includes(date)), expectHoliday.filter((d) => !table.holidays.includes(d)).join(','))
  const expectWorkday = ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']
  check('the 2026 调休 workdays are present', expectWorkday.every((date) => table.workdays.includes(date)), expectWorkday.filter((d) => !table.workdays.includes(d)).join(','))
  check('the calendar records its source documents', Boolean(table.source?.['2026']?.url && table.source?.['2025']?.url), JSON.stringify(Object.keys(table.source ?? {})))
}

// ── 2. a weekday holiday is off-peak all day ─────────────────────────────────
{
  // 2026-10-01 is a Thursday inside the National Day block; 2026-09-24 is a plain
  // Thursday, so the two differ only by the holiday calendar.
  const holiday = await dayFor('national-day', key(2026, 10, 1), at(2026, 10, 1, 10, 30), { source: 'cn' })
  check('a weekday holiday is billed off-peak all day (x1)', close(holiday.amount, 1000), `${holiday.amount}`)
  check('the holiday row is marked as a holiday', holiday.row.dayClass === 'holiday' && holiday.row.dayName === '国庆节', JSON.stringify({ c: holiday.row.dayClass, n: holiday.row.dayName }))

  const plain = await dayFor('plain-thursday', key(2026, 9, 24), at(2026, 9, 24, 10, 30), { source: 'cn' })
  check('an ordinary Thursday peak hour is still x2', close(plain.amount, 2000), `${plain.amount}`)

  const off = await dayFor('national-day-off', key(2026, 10, 1), at(2026, 10, 1, 10, 30))
  check('without the calendar the same day is an ordinary Thursday (x2)', close(off.amount, 2000), `${off.amount}`)
}

// ── 3. a 调休 weekend stays off-peak ─────────────────────────────────────────
// The easy mistake: treating a State Council 调休 working day as a working day for
// peak purposes. The page makes 「周末」 off-peak in full, and a 调休 day is still a
// 周末 — so charging peak there over-bills. These pin the correct reading.
{
  // 2026-09-20 is a Sunday the State Council made a working day; 2026-09-19 is the
  // ordinary Saturday beside it.
  const makeup = await dayFor('makeup-sunday', key(2026, 9, 20), at(2026, 9, 20, 10, 30), { source: 'cn' })
  check('a 调休 Sunday stays off-peak at a peak hour (x1)', close(makeup.amount, 1000), `${makeup.amount}`)
  check('the 调休 day is not classified as a holiday', makeup.row.dayClass === 'normal', String(makeup.row.dayClass))

  const saturday = await dayFor('ordinary-saturday', key(2026, 9, 19), at(2026, 9, 19, 10, 30), { source: 'cn' })
  check('an ordinary Saturday stays off-peak (x1)', close(saturday.amount, 1000), `${saturday.amount}`)

  const makeupOff = await dayFor('makeup-sunday-off', key(2026, 9, 20), at(2026, 9, 20, 10, 30))
  check('without the calendar the same Sunday is off-peak (x1)', close(makeupOff.amount, 1000), `${makeupOff.amount}`)
}

// ── 4. the Spring Festival block, and its two 调休 Saturdays ──────────────────
{
  const spring = await dayFor('spring-festival', key(2026, 2, 17), at(2026, 2, 17, 10, 30), { source: 'cn' })
  check('春节 2026-02-17 (a Tuesday) is off-peak all day', close(spring.amount, 1000), `${spring.amount}`)
  check('春节 is named on its row', spring.row.dayName === '春节', String(spring.row.dayName))

  const makeup = await dayFor('spring-makeup', key(2026, 2, 14), at(2026, 2, 14, 10, 30), { source: 'cn' })
  check('the 2026-02-14 调休 Saturday stays off-peak (x1)', close(makeup.amount, 1000), `${makeup.amount}`)
}

// ── 5. custom calendars ──────────────────────────────────────────────────────
{
  const custom = await dayFor('custom-extra', key(2026, 3, 5), at(2026, 3, 5, 10, 30), { source: 'custom', extra: ['2026-03-05'] })
  check('a custom-only calendar marks its own date off-peak', close(custom.amount, 1000), `${custom.amount}`)
  check('a custom holiday is labeled as such', custom.row.dayName === '自定义', String(custom.row.dayName))

  const extra = await dayFor('cn-plus-extra', key(2026, 3, 5), at(2026, 3, 5, 10, 30), { source: 'cn', extra: ['2026-03-05'] })
  check('extra dates are honored on top of the bundled calendar', close(extra.amount, 1000), `${extra.amount}`)

  // A `holidays.workdays` entry in an older config must be inert, not a silent
  // pricing change: the field is no longer a rule input.
  const customWorkday = await dayFor('custom-workday', key(2026, 3, 7), at(2026, 3, 7, 10, 30), { source: 'custom', workdays: ['2026-03-07'] })
  check('a stale holidays.workdays entry is ignored', close(customWorkday.amount, 1000), `${customWorkday.amount}`)

  const noSource = await dayFor('custom-none', key(2026, 3, 5), at(2026, 3, 5, 10, 30), { source: 'none', extra: ['2026-03-05'] })
  check('source "none" ignores even explicit extra dates', close(noSource.amount, 2000), `${noSource.amount}`)
}

// ── 6. a holiday is off-peak outside the peak windows too ────────────────────
{
  const evening = await dayFor('holiday-evening', key(2026, 10, 1), at(2026, 10, 1, 20, 30), { source: 'cn' })
  check('a holiday evening stays x1', close(evening.amount, 1000), `${evening.amount}`)
  const morning = await dayFor('holiday-morning', key(2026, 10, 1), at(2026, 10, 1, 8, 30), { source: 'cn' })
  check('a holiday outside the peak windows stays x1', close(morning.amount, 1000), `${morning.amount}`)
}

// ── 7. per-day verdicts inside one month ─────────────────────────────────────
{
  const root = makeHome('mixed-month')
  writePricing(root, {
    exchangeRate: 6.74,
    totalCurrency: 'cny',
    multiplier: 1,
    default: RATE,
    timeOfUse: TOU,
    overrides: {},
    holidays: { source: 'cn' },
  })
  writeSession(root, 'holiday', { provider: 'p', model: 'm', time: at(2026, 10, 2, 10, 30), input: 1000 })
  writeSession(root, 'workday', { provider: 'p', model: 'm', time: at(2026, 10, 9, 10, 30), input: 1000 })
  const snapshot = await summaryFor(root, 'mixed-month')
  const byDate = new Map(snapshot.days.map((day) => [day.date, day]))
  check('2026-10-02 (国庆) is x1', close(byDate.get('2026-10-02').amount, 1000), `${byDate.get('2026-10-02').amount}`)
  check('2026-10-09 (a plain Friday) is x2', close(byDate.get('2026-10-09').amount, 2000), `${byDate.get('2026-10-09').amount}`)
  check('the two days carry different classes', byDate.get('2026-10-02').dayClass === 'holiday' && byDate.get('2026-10-09').dayClass === 'normal')
}

finish()
