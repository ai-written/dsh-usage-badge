/**
 * dsh-usage-badge — browser half.
 *
 * A single hand-written client bundle: it registers one entry into the layout's
 * `shell.overlay` seat (the frame-wide floating layer the layout docs describe as
 * the home for "a badge, a toast stack or a status pill") and renders the ¥ pill
 * plus its dialog.
 *
 * No build step: the module is written directly in the loader's factory form, so
 * `lib/client.js` is both the source and the artifact. Only `react` is required
 * from the platform module table; no chart library is bundled, because the bars
 * are plain flexbox.
 *
 * Two panels hang off the dialog:
 *   - 用量      — the ranges, the provider filter, the totals and the chart.
 *   - 单价配置  — the published price list fetched live on every open, the
 *                 currency/rate fields, and the holiday calendar state.
 */

window.__ModuleLoader__.load({
  id: 'dsh-usage-badge',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** How often the pill re-reads the host snapshot. */
    const POLL_MS = 5000

    const RANGES = [
      { id: '24h', label: '24 小时' },
      { id: '7d', label: '近 7 日' },
      { id: '30d', label: '近 30 日' },
      { id: '12m', label: '近 12 个月' },
    ]

    const TABS = [
      { id: 'usage', label: '用量' },
      { id: 'config', label: '单价配置' },
    ]

    const OFFICIAL_SOURCES = [
      { id: 'zh-cn', label: '中文页（人民币）' },
      { id: 'en', label: 'English (USD)' },
    ]

    const CSS = `
.dub-pill{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;height:36px;padding:0 8px;border:0;border-radius:12px;background:0 0;color:var(--dsw-alias-label-secondary,#666);font:inherit;font-size:14px;line-height:22px;cursor:pointer;text-align:left}
.dub-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));color:var(--dsw-alias-label-primary,#111)}
.dub-pill-rail{width:36px;height:36px;padding:0;justify-content:center;gap:0}
.dub-pill-rail .dub-pill-label,.dub-pill-rail .dub-pill-tokens,.dub-pill-rail .dub-dot{display:none}
.dub-pill-rail .dub-pill-amount{margin-left:0;font-size:11px;font-weight:600}
.dub-pill-off{opacity:.55}
.dub-pill-label{flex:none}
/* Peak/valley marker: grey off-peak, brand-orange while the peak multiplier is in
   force. A plain flow item — an absolutely positioned one escapes the row. */
.dub-dot{flex:none;width:6px;height:6px;border-radius:3px;background:var(--dsw-alias-label-tertiary,#999)}
.dub-dot-peak{background:var(--dsw-alias-brand-primary,#d97706)}
.dub-pill-tokens{margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-variant-numeric:tabular-nums}
.dub-pill-amount{flex:none;margin-left:6px;color:var(--dsw-alias-label-primary,#111);font-variant-numeric:tabular-nums;font-weight:500}
.dub-mask{position:fixed;inset:0;z-index:2147483600;pointer-events:auto;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.34)}
.dub-box{width:min(720px,100vw - 48px);max-height:min(680px,100vh - 80px);display:flex;flex-direction:column;overflow:hidden;border-radius:14px;border:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));background:var(--dsw-specific-menu,var(--dsw-alias-bg-l1,#fff));color:var(--dsw-alias-label-primary,#111);box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgba(0,0,0,.28))}
.dub-head{display:flex;align-items:center;gap:10px;padding:14px 18px 10px}
.dub-title{font-size:14px;font-weight:600;flex:1}
.dub-chip{font-size:11px;padding:1px 7px;border-radius:9px;background:var(--dsw-alias-fill-l2,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}
.dub-chip-peak{background:var(--dsw-alias-brand-primary,#d97706);color:#fff}
.dub-chip-holiday{background:#16a34a;color:#fff}
.dub-x{border:0;background:0 0;color:inherit;font-size:18px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px;opacity:.7}
.dub-x:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}
.dub-tabs{display:flex;gap:6px;padding:0 18px 10px;flex-wrap:wrap;align-items:center}
.dub-tab{font-size:12px;padding:3px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));background:0 0;color:inherit;cursor:pointer}
.dub-tab-on{background:var(--dsw-alias-fill-l2,rgba(128,128,128,.16));border-color:transparent;font-weight:600}
.dub-panetabs{padding:0 18px 8px;gap:0}
.dub-panetabs .dub-tab{border:0;border-bottom:2px solid transparent;border-radius:0;padding:4px 12px;font-size:13px;opacity:.7}
.dub-panetabs .dub-tab-on{background:0 0;border-bottom-color:var(--dsw-alias-label-primary,#111);font-weight:600;opacity:1}
.dub-sep{width:1px;height:16px;background:var(--dsw-alias-border-l1,rgba(128,128,128,.25));margin:0 4px}
.dub-body{padding:0 18px 14px;overflow:auto}
.dub-stats{display:flex;gap:22px;flex-wrap:wrap;padding:10px 0 14px;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}
.dub-stat{display:flex;flex-direction:column;gap:2px}
.dub-stat-k{font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}
.dub-stat-v{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
.dub-chartwrap{padding-top:6px}
.dub-plot{position:relative}
.dub-legend{display:flex;gap:14px;flex-wrap:wrap;padding:2px 0 6px;font-size:11px;color:var(--dsw-alias-label-secondary,#666)}
.dub-legend-item{display:inline-flex;align-items:center;gap:5px}
.dub-legend-swatch{flex:none;width:11px;height:11px;border-radius:3px}
.dub-svg{display:block;width:100%;height:auto;overflow:visible}
.dub-grid{stroke:var(--dsw-alias-border-l1,rgba(128,128,128,.18));stroke-width:1}
.dub-guide{stroke:var(--dsw-alias-border-l3,rgba(128,128,128,.5));stroke-width:1;stroke-dasharray:3 3}
.dub-band-holiday{fill:rgba(22,163,74,.10)}
.dub-axis{fill:var(--dsw-alias-label-tertiary,#8b949e);font-size:10px;text-anchor:middle}
.dub-tip{position:absolute;top:18px;transform:translateX(-50%);pointer-events:none;box-sizing:border-box;width:172px;padding:8px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));background:var(--dsw-specific-menu,var(--dsw-alias-bg-l1,#fff));box-shadow:0 6px 20px rgba(0,0,0,.18);font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#666);z-index:2}
.dub-tip-title{font-weight:600;color:var(--dsw-alias-label-primary,#111);margin-bottom:2px}
.dub-tip-row{display:flex;align-items:center;gap:6px;white-space:nowrap}
.dub-tip-label{flex:1}
.dub-tip-value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#111)}
.dub-empty{padding:34px 0;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}
.dub-block{border:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:10px;padding:12px 14px;margin:12px 0}
.dub-block-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.dub-block-title{font-size:13px;font-weight:600;flex:1}
.dub-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary,#666);padding:3px 0}
.dub-table{width:100%;border-collapse:collapse;font-size:12px;margin:6px 0}
.dub-table th{text-align:left;font-weight:600;color:var(--dsw-alias-label-secondary,#666);padding:4px 8px 4px 0;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));white-space:nowrap}
.dub-table td{padding:4px 8px 4px 0;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12));font-variant-numeric:tabular-nums;white-space:nowrap}
.dub-table td.dub-model{font-family:var(--dsw-font-mono,monospace);color:var(--dsw-alias-label-primary,#111)}
.dub-note{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:1.5}
.dub-warn{color:#b45309;font-size:11px}
.dub-policy{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);line-height:1.6;border-left:2px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));padding-left:8px;margin-top:6px}
.dub-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 18px;border-top:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));font-size:12px;color:var(--dsw-alias-label-secondary,#666)}
.dub-foot input,.dub-foot select,.dub-block input,.dub-block select{font:inherit;font-size:12px;padding:2px 6px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));background:var(--dsw-alias-bg-l1,transparent);color:inherit;width:88px}
.dub-btn{font:inherit;font-size:12px;padding:3px 10px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));background:0 0;color:inherit;cursor:pointer;white-space:nowrap}
.dub-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}
.dub-btn:disabled{opacity:.5;cursor:default}
.dub-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff}
.dub-btn-primary:hover{opacity:.9;background:var(--dsw-alias-brand-primary,#3b82f6)}
`

    /** Inject the stylesheet once per document, guarded the way shipped plugins do. */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      const tagId = 'dsh-usage-badge/style.css'
      if (document.querySelector(`style[data-plugin-css="${tagId}"]`)) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-usage-badge'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const money = (value) => `¥${(Number(value) || 0).toFixed(2)}`

    /** A per-million price, keeping the small cache-hit rates legible. */
    function price(value, currency) {
      const symbol = currency === 'usd' ? '$' : '¥'
      const number = Number(value) || 0
      return symbol + String(Number(number.toFixed(number >= 1 ? 2 : 4)))
    }

    /** Compact token counts, so a header row stays readable at every range. */
    function tokens(value) {
      const n = Number(value) || 0
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
      if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
      return String(n)
    }

    const totalTokens = (t) => (t.input || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0) + (t.output || 0)

    /** Share of input tokens served from cache; 0 when the range has no input. */
    function hitRate(t) {
      const input = (t.input || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0)
      return input > 0 ? (t.cacheRead || 0) / input : 0
    }

    const EMPTY_TOTALS = { amount: 0, requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }

    /** One day entry reduced to a single provider (or kept whole). */
    function entryTotals(entry, provider) {
      if (!provider) return entry
      return (entry.providers || []).find((p) => p.provider === provider) ?? EMPTY_TOTALS
    }

    function sumTotals(list) {
      const out = { ...EMPTY_TOTALS }
      for (const item of list) {
        out.amount += item.amount || 0
        out.requests += item.requests || 0
        out.input += item.input || 0
        out.cacheRead += item.cacheRead || 0
        out.cacheWrite += item.cacheWrite || 0
        out.output += item.output || 0
      }
      return out
    }

    const pad2 = (value) => String(value).padStart(2, '0')

    /** The local `YYYY-MM-DD` key of a Date. */
    const dayKeyOf = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`

    /**
     * The last `count` calendar days ending at `endKey`, oldest first.
     *
     * Enumerated from the calendar, not from the days that happen to have usage: the
     * host only reports days with requests, so taking "the last 7 of those" stretches
     * the window to whatever 7 days last had data and hides the gaps instead of
     * showing them. A quiet Saturday is still a day.
     */
    function lastDays(endKey, count) {
      const [year, month, day] = endKey.split('-').map(Number)
      const cursor = new Date(year, month - 1, day)
      const out = []
      for (let index = 0; index < count; index++) {
        out.unshift(dayKeyOf(cursor))
        cursor.setDate(cursor.getDate() - 1)
      }
      return out
    }

    /** The last `count` calendar months ending at `endKey`'s month, oldest first. */
    function lastMonths(endKey, count) {
      const [year, month] = endKey.split('-').map(Number)
      const out = []
      for (let index = count - 1; index >= 0; index--) {
        const cursor = new Date(year, month - 1 - index, 1)
        out.push(`${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}`)
      }
      return out
    }

    /** The day a snapshot is anchored on: the host's own "today". */
    function anchorDate(snapshot) {
      return snapshot.badge?.date ?? snapshot.today?.date ?? snapshot.days?.[0]?.date ?? ''
    }

    /**
     * Build the chart points and totals for one range under one provider filter.
     *
     * Each point carries all four plotted metrics, mirroring the desktop shell's
     * chart (amount, token volume, request count and cache-hit rate). Every range
     * answers from the same snapshot, so switching a tab or a provider never issues
     * another request.
     */
    function buildSeries(snapshot, range, provider) {
      /** One point from any of the shapes the host sends. */
      const point = (label, title, src, dayClass) => ({
        label,
        title,
        dayClass,
        amount: Number(src.amount) || 0,
        tokens: totalTokens(src),
        requests: Number(src.requests) || 0,
        hitRate: hitRate(src) * 100,
        // Raw input-side buckets, so a range total can compute one exact hit rate.
        input: (Number(src.input) || 0) + (Number(src.cacheRead) || 0) + (Number(src.cacheWrite) || 0),
        cacheRead: Number(src.cacheRead) || 0,
      })

      if (range === '24h') {
        const today = snapshot.today
        const row = provider ? (today.providers || []).find((p) => p.provider === provider) : null
        const hourly = (provider ? row?.hourly : today.hourly) || []
        return {
          points: hourly.map((slot) => point(String(slot.hour), `${String(slot.hour).padStart(2, '0')}:00`, slot)),
          marks: false,
        }
      }

      if (range === '12m') {
        const byMonth = new Map()
        for (const day of snapshot.days) {
          const key = day.date.slice(0, 7)
          if (!byMonth.has(key)) byMonth.set(key, [])
          byMonth.get(key).push(entryTotals(day, provider))
        }
        // Twelve calendar months, so a month with no usage keeps its empty slot
        // instead of quietly pushing an older month into the window.
        return {
          points: lastMonths(anchorDate(snapshot), 12).map((key) =>
            point(key.slice(2), key, sumTotals(byMonth.get(key) ?? [])),
          ),
          marks: false,
        }
      }

      const count = range === '7d' ? 7 : 30
      const byDate = new Map(snapshot.days.map((day) => [day.date, day]))
      return {
        points: lastDays(anchorDate(snapshot), count).map((date) => {
          const day = byDate.get(date)
          if (!day) return point(date.slice(5), `${date}（无用量）`, EMPTY_TOTALS)
          return point(
            date.slice(5),
            `${date}${day.dayName ? `  ${day.dayName}` : ''}`,
            entryTotals(day, provider),
            day.dayClass,
          )
        }),
        marks: true,
      }
    }

    /** Which x labels to draw: all when few, otherwise an even stride. */
    function labelVisible(index, length) {
      if (length <= 12) return true
      const stride = Math.ceil(length / 12)
      return index % stride === 0 || index === length - 1
    }

    // ── the chart ─────────────────────────────────────────────────────────────
    // Plotted metrics and their styling, copied from the desktop shell's chart so
    // the two read the same: blue amount (filled), green token volume, purple
    // request count, dashed amber cache-hit rate on its own 0–100 scale.
    const SERIES = [
      { key: 'amount', label: '金额（¥）', color: '#1f6feb', fill: 'rgba(31,111,235,0.10)', radius: 3, format: (v) => money(v) },
      { key: 'tokens', label: 'token 总量', color: '#2da44e', radius: 3, format: (v) => tokens(v) },
      { key: 'requests', label: '请求数', color: '#8250df', radius: 2, format: (v) => String(v) },
      { key: 'hitRate', label: '缓存命中率（%）', color: '#e8930c', dash: '5 3', radius: 3, max: 100, format: (v) => `${v.toFixed(1)}%` },
    ]

    const CHART = { width: 640, height: 180, top: 10, bottom: 24, side: 10, tension: 0.35 }

    /** Horizontal position of point `index` of `count` inside the viewBox. */
    const chartX = (index, count) => {
      const span = CHART.width - CHART.side * 2
      return count <= 1 ? CHART.side + span / 2 : CHART.side + (index / (count - 1)) * span
    }

    /** Vertical position of `value` under a series' own scale. */
    const chartY = (value, max) => {
      const span = CHART.height - CHART.top - CHART.bottom
      const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
      return CHART.top + span - ratio * span
    }

    /**
     * A smoothed path through the points, using the same cardinal-spline shape
     * Chart.js draws at `tension: 0.35`.
     */
    function smoothPath(points) {
      if (points.length === 0) return ''
      if (points.length < 3) return `M${points.map((p) => `${p.x},${p.y}`).join('L')}`
      const t = CHART.tension
      let d = `M${points[0].x},${points[0].y}`
      for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i - 1] ?? points[i]
        const p1 = points[i]
        const p2 = points[i + 1]
        const p3 = points[i + 2] ?? p2
        const c1x = p1.x + ((p2.x - p0.x) / 6) * t * 2
        const c1y = p1.y + ((p2.y - p0.y) / 6) * t * 2
        const c2x = p2.x - ((p3.x - p1.x) / 6) * t * 2
        const c2y = p2.y - ((p3.y - p1.y) / 6) * t * 2
        d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`
      }
      return d
    }

    /**
     * The usage chart: four smoothed series over a shared index axis, with a
     * hover tooltip that reports every series at the hovered index — the same
     * `interaction: { mode: 'index' }` behavior the shell's chart has.
     */
    function UsageChart({ points }) {
      const [hover, setHover] = React.useState(null)
      const count = points.length
      const hasData = count > 0 && points.some((p) => SERIES.some((s) => (p[s.key] || 0) > 0))
      if (!hasData) return h('div', { className: 'dub-empty' }, '该区间暂无用量')

      const plotted = SERIES.map((series) => {
        const max = series.max ?? Math.max(...points.map((p) => p[series.key] || 0), 0)
        const coords = points.map((p, index) => ({ x: chartX(index, count), y: chartY(p[series.key] || 0, max || 1) }))
        return { series, coords, max }
      })

      const gridY = [0, 0.25, 0.5, 0.75, 1].map((ratio) => CHART.top + ratio * (CHART.height - CHART.top - CHART.bottom))
      const baseline = CHART.height - CHART.bottom
      const amountSeries = plotted[0]

      /** Nearest index for a pointer position, from the viewBox x it maps to. */
      const indexAt = (event) => {
        const box = event.currentTarget.getBoundingClientRect()
        const ratio = box.width > 0 ? (event.clientX - box.left) / box.width : 0
        const x = ratio * CHART.width
        const span = CHART.width - CHART.side * 2
        const raw = count <= 1 ? 0 : ((x - CHART.side) / span) * (count - 1)
        return Math.min(count - 1, Math.max(0, Math.round(raw)))
      }

      const hovered = hover === null ? null : points[hover]

      return h(
        'div',
        { className: 'dub-chartwrap' },
        h(
          'div',
          { className: 'dub-legend' },
          SERIES.map((series) =>
            h(
              'span',
              { className: 'dub-legend-item', key: series.key },
              h('span', { className: 'dub-legend-swatch', style: { background: series.color } }),
              series.label,
            ),
          ),
        ),
        h(
          'div',
          { className: 'dub-plot' },
          h(
          'svg',
          {
            className: 'dub-svg',
            viewBox: `0 0 ${CHART.width} ${CHART.height}`,
            onMouseMove: (event) => setHover(indexAt(event)),
            onMouseLeave: () => setHover(null),
          },
          // Faint horizontal grid, as the shell's left value axis draws.
          gridY.map((y, index) =>
            h('line', {
              key: `grid${index}`,
              x1: CHART.side,
              x2: CHART.width - CHART.side,
              y1: y,
              y2: y,
              className: 'dub-grid',
            }),
          ),
          // Public holidays get a full-height band behind the series.
          points.map((p, index) =>
            p.dayClass === 'holiday'
              ? h('rect', {
                  key: `mark${index}`,
                  x: chartX(index, count) - (CHART.width - CHART.side * 2) / Math.max(1, count) / 2,
                  y: CHART.top,
                  width: Math.max(2, (CHART.width - CHART.side * 2) / Math.max(1, count)),
                  height: baseline - CHART.top,
                  className: 'dub-band-holiday',
                })
              : null,
          ),
          // The amount series is filled, matching the shell's filled first dataset.
          h('path', {
            d: `${smoothPath(amountSeries.coords)}L${amountSeries.coords.at(-1)?.x ?? CHART.side},${baseline}L${amountSeries.coords[0]?.x ?? CHART.side},${baseline}Z`,
            fill: amountSeries.series.fill,
            stroke: 'none',
          }),
          ...plotted.map(({ series, coords }) =>
            h('path', {
              key: series.key,
              d: smoothPath(coords),
              fill: 'none',
              stroke: series.color,
              strokeWidth: 2,
              strokeDasharray: series.dash,
              strokeLinecap: 'round',
            }),
          ),
          ...plotted.flatMap(({ series, coords }) =>
            coords.map((c, index) =>
              h('circle', {
                key: `${series.key}-${index}`,
                cx: c.x,
                cy: c.y,
                r: series.radius,
                fill: '#fff',
                stroke: series.color,
                strokeWidth: 2,
              }),
            ),
          ),
          // Guide line at the hovered index.
          hovered
            ? h('line', {
                x1: chartX(hover, count),
                x2: chartX(hover, count),
                y1: CHART.top,
                y2: baseline,
                className: 'dub-guide',
              })
            : null,
          // X labels, thinned the way `maxTicksLimit` thins them.
          points.map((p, index) =>
            labelVisible(index, count)
              ? h(
                  'text',
                  { key: `lab${index}`, x: chartX(index, count), y: CHART.height - 6, className: 'dub-axis' },
                  p.label,
                )
              : null,
          ),
        ),
        hovered
          ? h(
              'div',
              {
                className: 'dub-tip',
                // The tooltip is centre-anchored on its point, so at either end half
                // of it would fall outside the dialog's clipped box. The clamp keeps
                // it fully inside however narrow the panel gets, in one declaration:
                // 86px is half of the tooltip's own width.
                style: { left: `clamp(86px, ${(chartX(hover, count) / CHART.width) * 100}%, calc(100% - 86px))` },
              },
              h('div', { className: 'dub-tip-title' }, hovered.title),
              SERIES.map((series) =>
                h(
                  'div',
                  { className: 'dub-tip-row', key: series.key },
                  h('span', { className: 'dub-legend-swatch', style: { background: series.color } }),
                  h('span', { className: 'dub-tip-label' }, series.label),
                  h('span', { className: 'dub-tip-value' }, series.format(hovered[series.key] || 0)),
                ),
              ),
            )
          : null,
        ),
      )
    }

    /** The period badge: the holiday calendar outranks the peak/valley window. */
    function bandChip(snapshot) {
      const calendar = snapshot.calendar
      const band = snapshot.band
      const today = calendar?.today
      if (calendar?.enabled && today?.class === 'holiday') {
        return { text: `${today.name ?? '法定节假日'} · 全天空闲`, peak: false, holiday: true }
      }
      if (band?.enabled) return { text: `${band.peak ? '峰时' : '谷时'} ×${band.multiplier}`, peak: band.peak, holiday: false }
      return null
    }

    function Stat({ label, value }) {
      return h('div', { className: 'dub-stat' }, h('div', { className: 'dub-stat-k' }, label), h('div', { className: 'dub-stat-v' }, value))
    }

    /** The 用量 panel: ranges, provider filter, totals and the chart. */
    function UsagePanel({ snapshot, initialRange = '24h' }) {
      const [range, setRange] = React.useState(initialRange)
      const [provider, setProvider] = React.useState('')
      const providers = snapshot.today.providers || []
      const series = buildSeries(snapshot, range, provider)
      // The stat cards describe exactly what the chart plots, so they are summed
      // from the same points rather than read from a separate total. Summing the
      // raw token buckets keeps the aggregate hit rate exact instead of averaging
      // per-point percentages.
      const totals = series.points.reduce(
        (acc, item) => ({
          amount: acc.amount + item.amount,
          requests: acc.requests + item.requests,
          tokens: acc.tokens + item.tokens,
          input: acc.input + item.input,
          cacheRead: acc.cacheRead + item.cacheRead,
        }),
        { amount: 0, requests: 0, tokens: 0, input: 0, cacheRead: 0 },
      )
      const hitPercent = totals.input > 0 ? (totals.cacheRead / totals.input) * 100 : 0

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dub-tabs' },
          RANGES.map((item) =>
            h(
              'button',
              { key: item.id, className: `dub-tab${range === item.id ? ' dub-tab-on' : ''}`, onClick: () => setRange(item.id) },
              item.label,
            ),
          ),
          providers.length > 1 ? h('span', { className: 'dub-sep' }) : null,
          providers.length > 1
            ? [
                h(
                  'button',
                  { key: '__all', className: `dub-tab${provider === '' ? ' dub-tab-on' : ''}`, onClick: () => setProvider('') },
                  '全部',
                ),
                ...providers.map((row) =>
                  h(
                    'button',
                    {
                      key: row.provider,
                      className: `dub-tab${provider === row.provider ? ' dub-tab-on' : ''}`,
                      onClick: () => setProvider(row.provider),
                    },
                    row.provider,
                  ),
                ),
              ]
            : null,
        ),
        h(
          'div',
          { className: 'dub-body' },
          h(
            'div',
            { className: 'dub-stats' },
            h(Stat, { label: '金额', value: money(totals.amount) }),
            h(Stat, { label: '请求数', value: String(totals.requests || 0) }),
            h(Stat, { label: 'Token', value: tokens(totals.tokens) }),
            h(Stat, { label: '缓存命中率', value: `${hitPercent.toFixed(1)}%` }),
          ),
          h(UsageChart, { points: series.points }),
          series.marks
            ? h('div', { className: 'dub-note', style: { paddingTop: '8px' } }, '绿色背景色带标示法定节假日（全天按空闲时段计价）')
            : null,
        ),
      )
    }

    /**
     * The last successful 单价配置 payloads, kept for the life of the page.
     *
     * Switching tabs unmounts this panel, so without a cache every return to the tab
     * starts from the loading placeholder and swaps its contents in a moment later —
     * a visible flicker. Holding the last answer lets the panel render it straight
     * away and refresh behind it.
     */
    let cachedConfig = null
    let cachedOfficial = null

    /**
     * The 单价配置 panel.
     *
     * The published price list is fetched live every time this panel opens, which
     * is what makes the official numbers visible without a background poll. The
     * host coalesces requests that land within a few seconds of each other so
     * reopening the panel cannot hammer the docs site.
     */
    function ConfigPanel({ snapshot, reload, initialConfig = null, initialOfficial = null }) {
      const [source, setSource] = React.useState('zh-cn')
      const [official, setOfficial] = React.useState(initialOfficial ?? cachedOfficial)
      const [officialState, setOfficialState] = React.useState(
        (initialOfficial ?? cachedOfficial) ? 'ready' : 'loading',
      )
      const [applyState, setApplyState] = React.useState('idle')
      const [config, setConfig] = React.useState(initialConfig ?? cachedConfig)

      const loadOfficial = React.useCallback(async (which) => {
        // Only show the placeholder when there is nothing to show: flipping to
        // 'loading' with a table already on screen blanks it for a frame.
        if (!cachedOfficial) setOfficialState('loading')
        try {
          const response = await fetch(`/usage-badge/official-pricing?refresh=1&source=${which}`, { cache: 'no-store' })
          const body = await response.json()
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
          cachedOfficial = body
          setOfficial(body)
          setOfficialState('ready')
        } catch (error) {
          // A failed refresh keeps the last good list on screen; the warning says why.
          if (!cachedOfficial) setOfficial(null)
          setOfficialState(`failed: ${error?.message ?? error}`)
        }
      }, [])

      const loadConfig = React.useCallback(async () => {
        try {
          const response = await fetch('/usage-badge/config', { cache: 'no-store' })
          if (response.ok) {
            cachedConfig = await response.json()
            setConfig(cachedConfig)
          }
        } catch {
          // The effective config is informative here; a failure leaves the rest of
          // the panel usable.
        }
      }, [])

      React.useEffect(() => {
        void loadOfficial(source)
      }, [loadOfficial, source])

      React.useEffect(() => {
        void loadConfig()
      }, [loadConfig])

      const applyOfficial = async () => {
        setApplyState('saving')
        try {
          const response = await fetch('/usage-badge/official-pricing/apply', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source }),
          })
          const body = await response.json()
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
          setApplyState('applied')
          await loadConfig()
          reload()
        } catch (error) {
          setApplyState(`failed: ${error?.message ?? error}`)
        }
      }

      const effective = config?.effective
      const calendar = config?.calendar ?? snapshot.calendar
      const bundled = config?.bundled
      const overrides = Object.entries(effective?.overrides ?? {})
      const rowsWithMultiplier = overrides.some(([, row]) => row?.multiplier != null && Number(row.multiplier) !== 1)

      const policy = official?.policy
      const windowsSource = policy ? policy.peakRangesSource.map(([s, e]) => `${String(s).padStart(2, '0')}:00–${String(e).padStart(2, '0')}:00`).join('、') : ''
      const windowsLocal = policy ? policy.peakRangesLocal.map(([s, e]) => `${String(s).padStart(2, '0')}:00–${String(e).padStart(2, '0')}:00`).join('、') : ''

      return h(
        'div',
        { className: 'dub-body' },
        // ── the published price list ──────────────────────────────────────────
        h(
          'div',
          { className: 'dub-block' },
          h(
            'div',
            { className: 'dub-block-head' },
            h('div', { className: 'dub-block-title' }, '官方定价'),
            h(
              'select',
              { value: source, onChange: (event) => setSource(event.target.value), title: '官方页面语言（决定币种）' },
              OFFICIAL_SOURCES.map((item) => h('option', { key: item.id, value: item.id }, item.label)),
            ),
            h('button', { className: 'dub-btn', onClick: () => void loadOfficial(source), disabled: officialState === 'loading' }, '重新获取'),
            h(
              'button',
              {
                className: 'dub-btn dub-btn-primary',
                onClick: applyOfficial,
                disabled: officialState !== 'ready' || applyState === 'saving',
                title: '把官方单价写入本插件的 pricing.json（会覆盖同名模型的单价行）',
              },
              '应用官方价格',
            ),
          ),
          officialState === 'loading' ? h('div', { className: 'dub-note' }, '正在获取官方定价…') : null,
          officialState.startsWith('failed') ? h('div', { className: 'dub-warn' }, `获取失败：${officialState.slice(8)}`) : null,
          applyState === 'applied' ? h('div', { className: 'dub-note' }, '已应用并写入 pricing.json') : null,
          applyState.startsWith('failed') ? h('div', { className: 'dub-warn' }, `应用失败：${applyState.slice(8)}`) : null,
          h(
            'div',
            { className: 'dub-row' },
            h('span', { className: 'dub-note' }, '这是唯一的单价来源：汇率、币种、倍率都不需要配置（官方中文页即人民币，徽标也始终是人民币）。'),
          ),
          official
            ? [
                h(
                  'table',
                  { className: 'dub-table', key: 'table' },
                  h(
                    'thead',
                    null,
                    h(
                      'tr',
                      null,
                      h('th', null, '模型'),
                      h('th', null, '空闲 · 输入 / 缓存 / 输出'),
                      h('th', null, '高峰 · 输入 / 缓存 / 输出'),
                    ),
                  ),
                  h(
                    'tbody',
                    null,
                    official.models.map((model) =>
                      h(
                        'tr',
                        { key: model.model },
                        h('td', { className: 'dub-model' }, model.model),
                        h(
                          'td',
                          null,
                          `${price(model.offPeak.input, official.currency)} / ${price(model.offPeak.cacheRead, official.currency)} / ${price(model.offPeak.output, official.currency)}`,
                        ),
                        h(
                          'td',
                          null,
                          `${price(model.peak.input, official.currency)} / ${price(model.peak.cacheRead, official.currency)} / ${price(model.peak.output, official.currency)}`,
                        ),
                      ),
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'dub-row', key: 'meta' },
                  h('span', { className: 'dub-note' }, `单位：百万 tokens · 币种 ${official.currency.toUpperCase()} · 获取于 ${new Date(official.fetchedAt).toLocaleTimeString()}`),
                ),
                official.aliases?.names?.length
                  ? h(
                      'div',
                      { className: 'dub-row', key: 'alias' },
                      h('span', { className: 'dub-note' }, `旧模型名（仍按 ${official.aliases.target} 计价）：${official.aliases.names.join('、')}`),
                    )
                  : null,
                h(
                  'div',
                  { className: 'dub-policy', key: 'policy' },
                  h('div', null, `高峰时段：${policy.sourceZone ? `${policy.sourceZone.name} ` : ''}${windowsSource}`),
                  policy.peakRangesLocal.join() !== policy.peakRangesSource.join()
                    ? h('div', null, `本机时区换算后：${windowsLocal}`)
                    : null,
                  h('div', null, policy.offPeakIsHalfOfPeak ? '空闲时段价格为高峰时段价格的一半。' : ''),
                  h('div', null, policy.holidaysOffPeak ? '周末与中国法定节假日全天均为空闲时段。' : ''),
                ),
              ]
            : null,
        ),

        // ── the holiday calendar ──────────────────────────────────────────────
        h(
          'div',
          { className: 'dub-block' },
          h(
            'div',
            { className: 'dub-block-head' },
            h('div', { className: 'dub-block-title' }, '法定节假日日历'),
            h('span', { className: `dub-chip${calendar?.enabled ? ' dub-chip-holiday' : ''}` }, calendar?.enabled ? '已启用' : '未启用'),
          ),
          // What the bundled table covers is shown whether or not the calendar is
          // on, so switching it on is an informed choice.
          bundled
            ? h(
                'div',
                { className: 'dub-row' },
                h(
                  'span',
                  { className: 'dub-note' },
                  `内置日历覆盖 ${bundled.years.join('、')}：${bundled.holidayCount} 个法定节假日（另收录 ${bundled.workdayCount} 个调休上班日，按官方口径不影响计价）。`,
                ),
              )
            : null,
          calendar?.enabled
            ? h(
                'div',
                { className: 'dub-row' },
                h(
                  'span',
                  { className: 'dub-note' },
                  `今天：${
                    calendar.today.class === 'holiday'
                      ? `${calendar.today.name ?? '法定节假日'}（全天按空闲时段计价）`
                      : '按「周一至周五」判峰谷'
                  }`,
                ),
              )
            : h(
                'div',
                { className: 'dub-row' },
                h('span', { className: 'dub-note' }, '未启用时只按「周一至周五」判断，中国法定节假日会被当成普通工作日计费；点「应用官方价格」会自动启用。'),
              ),
          bundled?.source && Object.keys(bundled.source).length
            ? h(
                'div',
                { className: 'dub-row' },
                h(
                  'span',
                  { className: 'dub-note' },
                  `数据来源：${Object.entries(bundled.source).map(([year, meta]) => `${year} ${meta.document}`).join('；')}`,
                ),
              )
            : null,
          calendar?.missingYears?.length
            ? h('div', { className: 'dub-warn' }, `日历缺少 ${calendar.missingYears.join('、')} 年的数据（尚未公布或未收录），这些日期按普通工作日处理。`)
            : null,
          h(
            'div',
            { className: 'dub-row' },
            h('span', { className: 'dub-note' }, '自定义日期可在 pricing.json 的 holidays.extra 中追加。'),
          ),
        ),

        // ── what is in effect ────────────────────────────────────────────────
        // Read-only on purpose: prices come from the published list above, so
        // there is nothing to maintain by hand here.
        h(
          'div',
          { className: 'dub-block' },
          h(
            'div',
            { className: 'dub-block-head' },
            h('div', { className: 'dub-block-title' }, '当前生效单价'),
            h('span', { className: 'dub-chip' }, '只读'),
            effective
              ? h('span', { className: 'dub-note' }, `default: 输入 ${price(effective.default?.inputPerMillion, effective.default?.currency)} · 缓存 ${price(effective.default?.cacheReadPerMillion, effective.default?.currency)} · 输出 ${price(effective.default?.outputPerMillion, effective.default?.currency)}`)
              : null,
          ),
          !effective
            ? h('div', { className: 'dub-note' }, '正在读取当前配置…')
            : overrides.length === 0
              ? h('div', { className: 'dub-note' }, '没有覆盖行，全部模型按 default 计价。')
              : h(
                'table',
                { className: 'dub-table' },
                h('thead', null, h('tr', null, h('th', null, '键'), h('th', null, '输入'), h('th', null, '缓存命中'), h('th', null, '输出'), rowsWithMultiplier ? h('th', null, '倍率') : null)),
                h(
                  'tbody',
                  null,
                  overrides.map(([key, row]) =>
                    h(
                      'tr',
                      { key },
                      h('td', { className: 'dub-model' }, key),
                      h('td', null, row.inputPerMillion ?? '—'),
                      h('td', null, row.cacheReadPerMillion ?? '—'),
                      h('td', null, row.outputPerMillion ?? '—'),
                      // The multiplier column only appears when a row actually
                      // carries one, so a pure official-price setup stays clean but
                      // a factor that changes the number is never invisible.
                      rowsWithMultiplier ? h('td', null, row.multiplier ?? '—') : null,
                    ),
                  ),
                ),
              ),
          h(
            'div',
            { className: 'dub-row' },
            h('span', { className: 'dub-note' }, '单价由上面的官方定价决定，这里只做展示；「应用官方价格」会按官方页面覆盖同名模型的行。'),
          ),
          config?.paths?.dataDir
            ? h(
                'div',
                { className: 'dub-row' },
                h(
                  'span',
                  { className: 'dub-note' },
                  `本插件的全部文件都在：${String(config.paths.dataDir)
                    .replace(/^.*[\\/]\.dsh[\\/]/, '~/.dsh/')
                    .replace(/\\/g, '/')}/`,
                ),
              )
            : null,
        ),
      )
    }

    function UsageDialog({ snapshot, onClose, reload, initialTab = 'usage', initialConfig = null, initialOfficial = null, initialRange = '24h' }) {
      const [tab, setTab] = React.useState(initialTab)
      const chip = bandChip(snapshot)

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      return h(
        'div',
        { className: 'dub-mask', onClick: (event) => event.target === event.currentTarget && onClose() },
        h(
          'div',
          { className: 'dub-box' },
          h(
            'div',
            { className: 'dub-head' },
            h('div', { className: 'dub-title' }, '用量统计'),
            h('span', { className: 'dub-chip' }, snapshot.badge.date),
            chip
              ? h(
                  'span',
                  { className: `dub-chip${chip.peak ? ' dub-chip-peak' : ''}${chip.holiday ? ' dub-chip-holiday' : ''}` },
                  chip.text,
                )
              : null,
            h('button', { className: 'dub-x', onClick: onClose, title: '关闭' }, '×'),
          ),
          h(
            'div',
            { className: 'dub-tabs dub-panetabs' },
            TABS.map((item) =>
              h(
                'button',
                { key: item.id, className: `dub-tab${tab === item.id ? ' dub-tab-on' : ''}`, onClick: () => setTab(item.id) },
                item.label,
              ),
            ),
          ),
          // Only the active panel is mounted, so returning to 单价配置 re-fetches the
          // published list — from the cache it renders at once, then refreshes.
          tab === 'usage'
            ? h(UsagePanel, { snapshot, initialRange })
            : h(ConfigPanel, { snapshot, reload, initialConfig, initialOfficial }),
        ),
      )
    }

    /**
     * The pill and its dialog.
     *
     * The two optional props exist so a headless test can render the real
     * component against a real snapshot without a browser: the slot renderer
     * passes neither, and both default to the live behavior.
     *
     * `wide` is the sidebar's own column state, supplied by the `sidebar.footer.action`
     * seat: the full row while expanded, a 36px square on the collapsed rail.
     *
     * @param {{wide?: boolean, initialSnapshot?: object|null, initialOpen?: boolean,
     *   initialTab?: string, initialConfig?: object|null, initialOfficial?: object|null,
     *   initialRange?: string}} props
     */
    function UsageBadge({
      wide = true,
      initialSnapshot = null,
      initialOpen = false,
      initialTab = 'usage',
      initialConfig = null,
      initialOfficial = null,
      initialRange = '24h',
    } = {}) {
      const [snapshot, setSnapshot] = React.useState(initialSnapshot)
      const [failed, setFailed] = React.useState(false)
      const [open, setOpen] = React.useState(initialOpen)

      const load = React.useCallback(async () => {
        try {
          const response = await fetch('/usage-badge/summary', { cache: 'no-store' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          setSnapshot(await response.json())
          setFailed(false)
        } catch {
          setFailed(true)
        }
      }, [])

      React.useEffect(() => {
        ensureStyles()
        void load()
        const timer = setInterval(() => void load(), POLL_MS)
        return () => clearInterval(timer)
      }, [load])

      const amount = snapshot ? snapshot.badge.amount : null
      const chip = snapshot ? bandChip(snapshot) : null
      const text = failed && !snapshot ? '¥—' : amount === null ? '…' : money(amount)
      const tokenTotal = snapshot ? totalTokens(snapshot.today) : 0
      const title = snapshot
        ? `今日 ${money(amount)} · ${tokens(tokenTotal)} tokens · ${snapshot.today.requests} 次请求${chip ? ` · ${chip.text}` : ''}\n点击查看用量明细`
        : '正在读取用量…'

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            className: `dub-pill${wide ? '' : ' dub-pill-rail'}${snapshot ? '' : ' dub-pill-off'}`,
            title,
            onClick: () => setOpen((value) => !value),
          },
          h('span', { className: 'dub-pill-label' }, '今日用量'),
          // The marker is compact, so it carries the band text as its own tooltip:
          // hovering the dot alone explains 峰时 ×2 / 谷时 ×1 / 节假日.
          chip ? h('span', { className: `dub-dot${chip.peak ? ' dub-dot-peak' : ''}`, title: chip.text }) : null,
          tokenTotal > 0 ? h('span', { className: 'dub-pill-tokens' }, `${tokens(tokenTotal)} tokens`) : null,
          h('span', { className: 'dub-pill-amount' }, text),
        ),
        open && snapshot
          ? h(UsageDialog, { snapshot, onClose: () => setOpen(false), reload: load, initialTab, initialConfig, initialOfficial, initialRange })
          : null,
      )
    }

    /** Required client services: the slot registry the row registers into. */
    const inject = ['slots']

    /**
     * Client plugin body.
     *
     * Registers one `sidebar.footer.action` entry — the seat the sidebar declares
     * for actions beside Settings at the foot of the column. Using it rather than a
     * floating overlay is what makes the row align with the shipped rows and share
     * their layout: the seat supplies the column's `wide` state, so the entry is a
     * full-width row while the sidebar is expanded and a square on the rail, and it
     * never overlaps another control.
     *
     * @param {import('@deepseek-ai/cordis').Context} ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.footer.action', () =>
            ctx.slots.register({ name: 'sidebar.footer.action', id: 'usage-badge', order: 100 }, UsageBadge),
          ),
        'usage-badge: sidebar cost row',
      )
    }

    return { apply, inject }
  },
})
