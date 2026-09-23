/**
 * dsh-usage-badge — browser half.
 *
 * A single hand-written client bundle: it registers one entry into the sidebar's
 * `sidebar.footer.action` seat — the row beside Settings at the foot of the column — and
 * renders the ¥ row plus its dialog. (That seat, rather than a floating overlay, is what
 * makes the row share the shipped rows' layout and collapse with the column.)
 *
 * No build step: the module is written directly in the loader's factory form, so
 * `lib/client.js` is both the source and the artifact. Only `react` is required
 * from the platform module table; no chart library is bundled, because every chart
 * here — four smoothed lines, the contributions grid — is hand-written SVG.
 *
 * Two panels hang off the dialog:
 *   - 用量      — the ranges, the provider filter, the totals, the chart and the year grid.
 *   - 单价配置  — the published price list fetched live on every open, the price rows you
 *                 maintain (overrides and the catch-all), the peak/valley switches, and the
 *                 holiday calendar state.
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
      { id: 'year', label: '按年' },
    ]

    const TABS = [
      { id: 'usage', label: '用量' },
      { id: 'config', label: '单价配置' },
    ]

    /**
     * The published list this panel reads. Only the Chinese page: it is quoted in CNY, which is
     * what the badge and every total are in, so the English page's USD column would need an
     * exchange rate to mean anything. (The route still accepts `?source=en` for anyone calling it
     * directly — the panel just has no reason to offer the choice.)
     */
    const OFFICIAL_SOURCE = 'zh-cn'

    /**
     * The host-half API this bundle needs; must equal `HOST_API_VERSION` in `lib/index.js`.
     *
     * The host half loads once, when the DSH process starts, while this file is re-read on
     * every page load — so "I changed the host half and only refreshed" is a normal state,
     * and in it a write the host does not understand comes back 200 and does nothing. The
     * panel compares this number and says so rather than letting a button look broken.
     */
    const REQUIRED_HOST_API = 6

    const CSS = `
.dub-pill{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;height:36px;padding:0 8px;border:0;border-radius:12px;background:0 0;color:var(--dsw-alias-label-secondary,#666);font:inherit;font-size:14px;line-height:22px;cursor:pointer;text-align:left}
.dub-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));color:var(--dsw-alias-label-primary,#111)}
.dub-pill-rail{width:36px;height:36px;padding:0;justify-content:center;gap:0}
.dub-pill-rail .dub-pill-label,.dub-pill-rail .dub-pill-tokens,.dub-pill-rail .dub-dot{display:none}
.dub-pill-rail .dub-pill-amount{margin-left:0;font-size:11px;font-weight:600}
.dub-pill-off{opacity:.55}
.dub-pill-label{flex:none}
/* Peak/valley marker: grey off-peak, amber while the peak multiplier is in force. A
   plain flow item — an absolutely positioned one escapes the row.
   The amber is an explicit static swatch, never the brand token: --dsw-alias-brand-primary
   is the *ink* colour (near-black #0f1115 in the light theme, near-white in the dark
   one), so borrowing it left the peak dot looking like ordinary text — and turned the
   peak chip into white on white. */
.dub-dot{flex:none;width:6px;height:6px;border-radius:3px;background:var(--dsw-alias-label-tertiary,#999)}
.dub-dot-peak{background:var(--dsw-static-amber-500,#f59e0b)}
.dub-pill-tokens{margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-variant-numeric:tabular-nums}
.dub-pill-amount{flex:none;margin-left:6px;color:var(--dsw-alias-label-primary,#111);font-variant-numeric:tabular-nums;font-weight:500}
.dub-mask{position:fixed;inset:0;z-index:2147483600;pointer-events:auto;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.34)}
.dub-box{width:min(720px,100vw - 48px);max-height:min(680px,100vh - 80px);display:flex;flex-direction:column;overflow:hidden;border-radius:14px;border:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary,#111);box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgba(0,0,0,.28))}
.dub-head{display:flex;align-items:center;gap:10px;padding:14px 18px 10px}
.dub-title{font-size:14px;font-weight:600;flex:1}
.dub-chip{font-size:11px;padding:1px 7px;border-radius:9px;background:var(--dsw-alias-fill-l2,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}
.dub-chip-peak{background:var(--dsw-static-amber-500,#f59e0b);color:#111}
.dub-chip-holiday{background:#16a34a;color:#fff}
.dub-x{border:0;background:0 0;color:inherit;font-size:18px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px;opacity:.7}
.dub-x:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}
.dub-tabs{display:flex;gap:6px;padding:0 18px 10px;flex-wrap:wrap;align-items:center}
.dub-tab{font-size:12px;padding:3px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));background:0 0;color:inherit;cursor:pointer}
.dub-tab-on{background:var(--dsw-alias-fill-l2,rgba(128,128,128,.16));border-color:transparent;font-weight:600}
/* The year picker sits in the range row, so it is styled as one more tab. */
.dub-year{font:inherit;font-size:12px;padding:3px 6px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));background:var(--dsw-alias-bg-l1,transparent);color:inherit;cursor:pointer}
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
/* Legend entries are toggles, so a series can be read on its own — a lone line at
   its own scale says more than four lines sharing one plot. The swatch of a hidden
   series loses its colour rather than being restyled, so the inline background stays
   the only place a series colour is written. */
.dub-legend-item{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:11px;color:inherit;background:0 0;border:0;padding:0;cursor:pointer}
.dub-legend-item:hover{color:var(--dsw-alias-label-primary,#111)}
.dub-legend-off{opacity:.5}
.dub-legend-off .dub-legend-swatch{background:var(--dsw-alias-fill-l2,rgba(128,128,128,.35))}
.dub-legend-reset{font:inherit;font-size:11px;background:0 0;border:0;padding:0;cursor:pointer;color:var(--dsw-alias-link,#5686fe);text-decoration:underline}
.dub-legend-swatch{flex:none;width:11px;height:11px;border-radius:3px}
.dub-svg{display:block;width:100%;height:auto;overflow:visible}
.dub-grid{stroke:var(--dsw-alias-border-l1,rgba(128,128,128,.18));stroke-width:1}
.dub-guide{stroke:var(--dsw-alias-border-l3,rgba(128,128,128,.5));stroke-width:1;stroke-dasharray:3 3}
.dub-band-holiday{fill:rgba(22,163,74,.10)}
.dub-axis{fill:var(--dsw-alias-label-tertiary,#8b949e);font-size:10px;text-anchor:middle}
.dub-tip{position:absolute;top:18px;transform:translateX(-50%);pointer-events:none;box-sizing:border-box;width:172px;padding:8px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));background:var(--dsw-alias-bg-layer-3,#fff);box-shadow:0 6px 20px rgba(0,0,0,.18);font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#666);z-index:2}
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
/* The version handshake lives at the top of the dialog, above the tabs, so a mismatch is stated
   on whichever tab the reader opened. */
.dub-version{padding:8px 18px;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));background:var(--dsw-alias-bg-l2,rgba(128,128,128,.06))}
/* Explanatory prose lives in these tooltips instead of under every block: the panel is a table of
   numbers, and a wall of notes under each one is what made it hard to scan. */
.dub-info{flex:none;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;border:1px solid currentColor;font-size:9px;font-style:normal;line-height:1;opacity:.5;cursor:help;user-select:none}
.dub-info:hover{opacity:.9}
.dub-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 18px;border-top:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));font-size:12px;color:var(--dsw-alias-label-secondary,#666)}
.dub-foot input,.dub-foot select,.dub-block input,.dub-block select{font:inherit;font-size:12px;padding:2px 6px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));background:var(--dsw-alias-bg-l1,transparent);color:inherit;width:88px}
.dub-btn{font:inherit;font-size:12px;padding:3px 10px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));background:0 0;color:inherit;cursor:pointer;white-space:nowrap}
.dub-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}
.dub-btn:disabled{opacity:.5;cursor:default}
/* The one filled action in the plugin. --dsw-alias-brand-primary is a *foreground*
   token in this design system (DSH uses it for text, outlines and the switch track),
   so filling with it left white text on near-white in the dark theme. The DeepSeek
   blue is the same family the plugin's own blue fallback came from. */
.dub-btn-primary{border-color:transparent;background:var(--dsw-static-deepseek-500,#4176e6);color:#fff}
.dub-btn-primary:hover{opacity:.9;background:var(--dsw-static-deepseek-500,#4176e6)}
/* Contributions heatmap: one square per calendar day of the last year. The five
   steps are the same rgba green at rising opacity, so the ramp reads correctly on
   both a light and a dark panel without a theme query. Each step sets fill for the
   svg squares and background for the HTML swatches. */
.dub-hm{position:relative}
.dub-hm-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.dub-hm-title{flex:1;font-size:12px;font-weight:600}
.dub-hm-metrics{display:flex;gap:4px}
.dub-hm-metric{font:inherit;font-size:11px;padding:2px 8px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));background:0 0;color:inherit;cursor:pointer}
.dub-hm-metric:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}
.dub-hm-metric-on{background:var(--dsw-alias-fill-l2,rgba(128,128,128,.16));border-color:transparent;font-weight:600}
/* The tooltip's percentages are squares of the grid, so it hangs off a wrapper that
   is exactly as tall as the svg rather than off the block (title and legend included). */
.dub-hm-plot{position:relative}
.dub-hm-cell{stroke:none}
.dub-hm-l0{fill:var(--dsw-alias-fill-l2,rgba(128,128,128,.14));background:var(--dsw-alias-fill-l2,rgba(128,128,128,.14))}
.dub-hm-l1{fill:rgba(45,164,78,.25);background:rgba(45,164,78,.25)}
.dub-hm-l2{fill:rgba(45,164,78,.45);background:rgba(45,164,78,.45)}
.dub-hm-l3{fill:rgba(45,164,78,.7);background:rgba(45,164,78,.7)}
.dub-hm-l4{fill:rgba(45,164,78,.95);background:rgba(45,164,78,.95)}
.dub-hm-month,.dub-hm-wd{fill:var(--dsw-alias-label-tertiary,#8b949e);font-size:9px}
/* The hover card is the chart's .dub-tip, so this only re-anchors it: the style is
   shared, the position is a fraction of the grid. */
.dub-hm-tip{margin-top:5px}
.dub-hm-tip-up{margin-top:-5px;transform:translate(-50%,-100%)}
.dub-hm-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}
.dub-hm-legend{margin-left:auto;display:inline-flex;align-items:center;gap:4px}
.dub-hm-swatch{display:inline-block;width:10px;height:10px;border-radius:2px}
/* The price-row editor. The block already styles its inputs at 88px wide, so the fields
   that need another width are written as a two-class selector to outrank that rule. */
.dub-form{border-top:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));margin-top:10px;padding-top:10px}
.dub-form-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary,#666);padding:3px 0}
.dub-form-row label{white-space:nowrap}
.dub-block .dub-form-key{width:250px}
.dub-block .dub-form-num{width:74px}
.dub-block input[type=checkbox]{width:auto;height:auto;margin:0}
.dub-form-check{display:inline-flex;align-items:center;gap:4px}
.dub-form-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;padding-top:8px}
.dub-table-ops{display:flex;gap:6px}
.dub-op{font:inherit;font-size:11px;padding:1px 7px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));background:0 0;color:inherit;cursor:pointer;white-space:nowrap}
.dub-op:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}
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

    /**
     * How old a timestamp is, coarsely, or '' while it is still fresh.
     *
     * The published list is fetched once per page load rather than on every visit to the tab, so
     * the panel owes the reader its age — a rate with no date on it is the kind of thing that
     * quietly goes stale.
     */
    function agoSince(at) {
      const minutes = Math.round((Date.now() - Number(at || 0)) / 60000)
      if (!Number.isFinite(minutes) || minutes < 10) return ''
      if (minutes < 60) return `${minutes} 分钟前`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `${hours} 小时前`
      return `${Math.round(hours / 24)} 天前`
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

    /** The inverse of `dayKeyOf`: the local midnight of a `YYYY-MM-DD` key. */
    function dateOfKey(key) {
      const [year, month, day] = String(key).split('-').map(Number)
      return new Date(year, month - 1, day)
    }

    /**
     * The last `count` calendar days ending at `endKey`, oldest first.
     *
     * Enumerated from the calendar, not from the days that happen to have usage: the
     * host only reports days with requests, so taking "the last 7 of those" stretches
     * the window to whatever 7 days last had data and hides the gaps instead of
     * showing them. A quiet Saturday is still a day.
     */
    function lastDays(endKey, count) {
      const cursor = dateOfKey(endKey)
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
     * The four plotted metrics of one bucket, from any of the shapes the host sends
     * (an hourly slot, a provider row, a day row or a hand-summed month).
     *
     * Shared with the heatmap so a hovered square and a hovered chart point report
     * the same numbers under the same keys — the two tooltips are the same card.
     */
    function metricsOf(src) {
      return {
        amount: Number(src.amount) || 0,
        tokens: totalTokens(src),
        requests: Number(src.requests) || 0,
        hitRate: hitRate(src) * 100,
      }
    }

    /** One chart point from any of the shapes the host sends. */
    function seriesPoint(label, title, src, dayClass) {
      return {
        label,
        title,
        dayClass,
        ...metricsOf(src),
        // Raw input-side buckets, so a range total can compute one exact hit rate.
        input: (Number(src.input) || 0) + (Number(src.cacheRead) || 0) + (Number(src.cacheWrite) || 0),
        cacheRead: Number(src.cacheRead) || 0,
      }
    }

    /**
     * The twelve months of one calendar year, from the host's per-year payload.
     *
     * The host has already bucketed them (a year older than the loading window only exists in
     * the store), so this applies the provider filter and the same point shape the other ranges
     * build — the chart, the stat cards and the tooltips are then shared code.
     */
    function yearPoints(yearData, provider) {
      if (!yearData?.months?.length) return { points: [], marks: false }
      return {
        points: yearData.months.map((month) =>
          seriesPoint(month.label, `${yearData.year} 年 ${Number(month.month.slice(5, 7))} 月`, entryTotals(month, provider)),
        ),
        marks: false,
      }
    }

    /**
     * Build the chart points and totals for one range under one provider filter.
     *
     * Each point carries all four plotted metrics, mirroring the desktop shell's
     * chart (amount, token volume, request count and cache-hit rate). Every range
     * answers from the same snapshot, so switching a tab or a provider never issues
     * another request. The one exception is `year`, whose months may be older than the
     * snapshot's window and therefore come from `/usage-badge/year`.
     */
    function buildSeries(snapshot, range, provider) {
      const point = seriesPoint

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
     * hover tooltip that reports every visible series at the hovered index — the
     * same `interaction: { mode: 'index' }` behavior the shell's chart has.
     *
     * Each legend entry toggles its own series. A series on its own keeps its own
     * scale, so isolating one is how a metric gets read at full height instead of
     * being compressed by a neighbour three orders of magnitude larger.
     *
     * @param {{points: Array<object>, initialHidden?: string[]}} props `initialHidden`
     *   is a test hook: the slot renderer passes no such prop and everything is shown.
     */
    function UsageChart({ points, initialHidden = [] }) {
      const [hover, setHover] = React.useState(null)
      const [hidden, setHidden] = React.useState(() => new Set(initialHidden))
      const count = points.length
      const shown = SERIES.filter((series) => !hidden.has(series.key))
      const hasData = count > 0 && points.some((p) => shown.some((s) => (p[s.key] || 0) > 0))
      const anyData = count > 0 && points.some((p) => SERIES.some((s) => (p[s.key] || 0) > 0))

      // The legend is built before the empty branch rather than inside the plot, because it is
      // the only way back: an empty state that hid the legend would strand whoever hid the
      // series that had the data.
      const legend = h(
        'div',
        { className: 'dub-legend' },
        SERIES.map((series) => {
          const on = !hidden.has(series.key)
          return h(
            'button',
            {
              key: series.key,
              type: 'button',
              className: `dub-legend-item${on ? '' : ' dub-legend-off'}`,
              title: `${on ? '隐藏' : '显示'}「${series.label}」`,
              onClick: () => toggle(series.key),
            },
            h('span', { className: 'dub-legend-swatch', style: on ? { background: series.color } : undefined }),
            series.label,
          )
        }),
        // Only offered once something is hidden, so the plain legend stays plain.
        hidden.size > 0
          ? h(
              'button',
              {
                type: 'button',
                className: 'dub-legend-reset',
                onClick: () => {
                  setHidden(new Set())
                  setHover(null)
                },
              },
              '全部显示',
            )
          : null,
      )

      if (!hasData) {
        return h(
          'div',
          { className: 'dub-chartwrap' },
          legend,
          h(
            'div',
            { className: 'dub-empty' },
            anyData ? '所选序列在该区间没有用量 —— 点上面的图例把其它序列显示出来' : '该区间暂无用量',
          ),
        )
      }

      const plotted = shown.map((series) => {
        const max = series.max ?? Math.max(...points.map((p) => p[series.key] || 0), 0)
        const coords = points.map((p, index) => ({ x: chartX(index, count), y: chartY(p[series.key] || 0, max || 1) }))
        return { series, coords, max }
      })

      const gridY = [0, 0.25, 0.5, 0.75, 1].map((ratio) => CHART.top + ratio * (CHART.height - CHART.top - CHART.bottom))
      const baseline = CHART.height - CHART.bottom
      // Looked up rather than taken as plotted[0]: with series hidden, the first
      // entry is not the amount series, and filling the wrong line would be silent.
      const amountSeries = plotted.find((entry) => entry.series.key === 'amount') ?? null

      /** Show or hide one series; hiding the last visible one brings them all back. */
      const toggle = (key) => {
        setHidden((current) => {
          const next = new Set(current)
          if (next.has(key)) next.delete(key)
          // Never leave the plot empty: the last click that would do so resets instead.
          else if (next.size >= SERIES.length - 1) return new Set()
          else next.add(key)
          return next
        })
        setHover(null)
      }

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
        legend,
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
          // Hidden, it takes its fill with it instead of filling someone else's line.
          amountSeries
            ? h('path', {
                d: `${smoothPath(amountSeries.coords)}L${amountSeries.coords.at(-1)?.x ?? CHART.side},${baseline}L${amountSeries.coords[0]?.x ?? CHART.side},${baseline}Z`,
                fill: amountSeries.series.fill,
                stroke: 'none',
              })
            : null,
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
              // Only the visible series, so the card agrees with the plot it belongs to.
              shown.map((series) =>
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

    // ── the contributions heatmap ─────────────────────────────────────────────
    // One square per calendar day for the last year, in GitHub's layout: a column
    // is a week (Monday first), a row is a weekday, and the shade is how that day
    // ranks against the year's other days that had usage.
    const HEAT = { cell: 10, gap: 2, left: 26, top: 14 }
    const HEAT_PITCH = HEAT.cell + HEAT.gap
    // A year is usually 53 week columns, but a leap year starting on a Sunday needs 54 — so the
    // width comes from the grid that was actually built rather than from a fixed number.
    const heatWidth = (columns) => HEAT.left + columns * HEAT_PITCH - HEAT.gap
    const HEAT_HEIGHT = HEAT.top + 7 * HEAT_PITCH - HEAT.gap
    /** Weekday names in row order, for the axis and the hovered day's title. */
    const HEAT_WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
    /** Which single metric shades the grid. */
    const HEAT_METRICS = [
      { id: 'amount', label: '金额', format: money },
      { id: 'tokens', label: 'Token', format: tokens },
      { id: 'requests', label: '请求数', format: (value) => String(value) },
    ]

    /** Top-left x of a column inside the heatmap viewBox. */
    const heatX = (column) => HEAT.left + column * HEAT_PITCH
    /** Top-left y of a row inside the heatmap viewBox. */
    const heatY = (row) => HEAT.top + row * HEAT_PITCH
    /**
     * Height the hover card needs, in px, for its title and four rows at the chart
     * tooltip's metrics (5 × 17.6px of line box + 16px of padding). It is estimated
     * rather than measured because measuring would mean rendering the card twice;
     * only a card taller than this can still be clipped, and the estimate is generous.
     */
    const HEAT_CARD_HEIGHT = 112
    /** Gap held between the card and the square it belongs to. */
    const HEAT_CARD_GAP = 5
    /** Breathing room left between the card and the edge of the scrolling body. */
    const HEAT_CARD_CLEARANCE = 12

    /**
     * Where the hover card goes for a square: which way it opens, and the fraction of
     * the grid its anchor sits at.
     *
     * The grid is the last block of a scrolling body, so a card that opens downward
     * from a square near that body's edge is cut off by it — and the row number cannot
     * tell you where that edge is, because the panel scrolls. So the room is measured
     * against the scroller and the card is then clamped into it, which keeps it visible
     * wherever the panel has been scrolled to.
     *
     * @returns {{up: boolean, top: number}|null} null when there is no layout to
     *   measure — a static render, where the caller falls back to the row's anchor.
     */
    function cardPlacement(square, plot) {
      const scroller = square?.closest?.('.dub-body')
      const box = scroller?.getBoundingClientRect?.()
      const grid = plot?.getBoundingClientRect?.()
      if (!box || !grid?.height) return null
      const rect = square.getBoundingClientRect()
      const below = box.bottom - rect.bottom
      const above = rect.top - box.top
      // Open downward when the card fits below the square, upward otherwise — and of
      // the two, upward only when it is not the roomier side.
      const up = below < HEAT_CARD_HEIGHT + HEAT_CARD_CLEARANCE && below <= above
      // Clamp the card's own top edge into the scroller, then turn that back into the
      // anchor the stylesheet expects for the chosen direction.
      const wanted = up ? rect.top - HEAT_CARD_GAP - HEAT_CARD_HEIGHT : rect.bottom + HEAT_CARD_GAP
      const clamped = Math.min(Math.max(wanted, box.top + 4), box.bottom - HEAT_CARD_HEIGHT - 4)
      const anchor = up ? clamped + HEAT_CARD_HEIGHT + HEAT_CARD_GAP : clamped - HEAT_CARD_GAP
      return { up, top: (anchor - grid.top) / grid.height }
    }

    /** The one number a day contributes to the grid, out of its four metrics. */
    function heatValue(metrics, metric) {
      return metrics ? Number(metrics[metric]) || 0 : 0
    }

    /**
     * The grid behind the heatmap: Monday-first week columns covering `from` … `to`.
     *
     * Days are enumerated from the calendar rather than from the rows: the host only reports days
     * that had requests, and a grid built from those would have no squares for the quiet days —
     * which are exactly the ones the picture is meant to show.
     *
     * Both callers share this one grid, which is why the bounds are arguments rather than derived
     * here from "today": the range views draw a trailing year (`from` a year back, `to` today)
     * and the year view draws a calendar year (`from` Jan 1, `to` Dec 31 — or today while that
     * year is still running). Days past `to` are left undrawn either way.
     */
    function heatGrid({ days, provider, metric, from, to }) {
      const byDate = new Map((days || []).map((day) => [day.date, day]))
      // Bounds arrive as either a Date or an ISO day key; both callers pass what they have.
      const keyOf = (value) => (typeof value === 'string' ? value : dayKeyOf(value))
      const end = keyOf(to)
      const start = dateOfKey(keyOf(from))
      // Back to that week's Monday, so the first column is a whole week.
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
      const span = Math.round((dateOfKey(end) - start) / 86400000)
      const weeks = Math.max(1, Math.ceil((span + 1) / 7))

      const cursor = new Date(start)
      const columns = []
      const values = []
      for (let week = 0; week < weeks; week++) {
        const cells = []
        for (let row = 0; row < 7; row++) {
          const key = dayKeyOf(cursor)
          // ISO keys compare correctly as strings, so a day that is still to come can be
          // told apart from one that simply had no usage.
          const future = key > end
          const day = future ? null : byDate.get(key)
          const totals = future ? null : day ? entryTotals(day, provider) : EMPTY_TOTALS
          // The cell carries the day's four metrics, not just the one shading it, so
          // the hover card can report the same four rows the chart's tooltip does.
          const metrics = totals ? metricsOf(totals) : null
          const value = heatValue(metrics, metric)
          if (!future) values.push(value)
          cells.push({
            key,
            row,
            column: week,
            date: new Date(cursor),
            future,
            value,
            metrics,
            dayName: day?.dayName ?? null,
          })
          cursor.setDate(cursor.getDate() + 1)
        }
        columns.push(cells)
      }

      // The five steps are quartiles of the days that had usage, as GitHub's are.
      // A share-of-maximum ramp would flatten a whole year to one shade as soon as
      // a single record day dwarfs the rest.
      const ranked = values.filter((value) => value > 0).sort((a, b) => a - b)
      const cut = (p) => (ranked.length ? ranked[Math.min(ranked.length - 1, Math.floor(p * ranked.length))] : 0)
      const q1 = cut(0.25)
      const q2 = cut(0.5)
      const q3 = cut(0.75)
      const levelOf = (value) => {
        if (!(value > 0)) return 0
        if (value <= q1) return 1
        if (value <= q2) return 2
        if (value <= q3) return 3
        return 4
      }

      // Month labels sit above the column holding a 1st; the opening column is
      // labelled with its own month so the year does not start blank. A label that
      // would land within two columns of the previous one is dropped.
      const marks = []
      columns.forEach((cells, column) => {
        const firstOfMonth = cells.find((cell) => cell.date.getDate() === 1)
        const anchor = column === 0 || firstOfMonth ? firstOfMonth ?? cells[0] : null
        if (!anchor) return
        // A 1st that is still to come must not caption its column: the last week of a
        // calendar year holds the next January, and that column is mostly December.
        if (anchor.future) return
        if (marks.length > 0 && column - marks[marks.length - 1].column < 3) return
        marks.push({ column, month: anchor.date.getMonth() + 1 })
      })

      return {
        columns,
        marks,
        total: values.reduce((sum, value) => sum + value, 0),
        active: ranked.length,
        levelOf,
      }
    }

    /**
     * The hovered square's date line: the day, its holiday name when it has one, and
     * otherwise a note that the four zeroes below it are a quiet day, not a bug.
     */
    function heatTitle(cell) {
      const metrics = cell.metrics
      const quiet = !metrics || SERIES.every((series) => !(Number(metrics[series.key]) > 0))
      const note = cell.dayName ?? (quiet ? '无用量' : '')
      return `${cell.key} ${HEAT_WEEKDAYS[cell.row]}${note ? ` · ${note}` : ''}`
    }

    /**
     * The year heatmap in the 用量 panel.
     *
     * It draws whichever range it is handed — the trailing year under the range chart, or one
     * calendar year (`days`, `from`, `to`, `title` are the host's per-year payload) — and honours
     * the same provider filter as the chart, so the two views cannot disagree about a day. The
     * metric selector only picks which of that day's numbers decides the shade.
     */
    function UsageHeatmap({ snapshot, provider, days, from, to, title }) {
      const [metric, setMetric] = React.useState('amount')
      const [hover, setHover] = React.useState(null)
      // The measured placement needs the grid's own box to turn viewport pixels back
      // into a fraction of it.
      const plotRef = React.useRef(null)
      const today = anchorDate(snapshot)
      const meta = HEAT_METRICS.find((item) => item.id === metric) ?? HEAT_METRICS[0]
      if (!today) return null
      // The trailing year: 52 weeks back from today, then out to that week's Monday. The year
      // view passes its own bounds instead, and `title` says which year it is looking at.
      const trailing = dateOfKey(today)
      trailing.setDate(trailing.getDate() - 364)
      const grid = heatGrid({ days: days ?? snapshot.days, provider, metric, from: from ?? trailing, to: to ?? today })
      const width = heatWidth(grid.columns.length)

      return h(
        'div',
        { className: 'dub-block dub-hm' },
        h(
          'div',
          { className: 'dub-hm-head' },
          h('div', { className: 'dub-hm-title' }, title ?? '近一年活跃度'),
          h('span', { className: 'dub-note' }, `共 ${meta.format(grid.total)} · ${grid.active} 天有用量`),
          h(
            'div',
            { className: 'dub-hm-metrics' },
            HEAT_METRICS.map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  className: `dub-hm-metric${metric === item.id ? ' dub-hm-metric-on' : ''}`,
                  onClick: () => {
                    setMetric(item.id)
                    setHover(null)
                  },
                },
                item.label,
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dub-hm-plot', ref: plotRef },
          h(
            'svg',
            {
              className: 'dub-svg',
              viewBox: `0 0 ${width} ${HEAT_HEIGHT}`,
              onMouseLeave: () => setHover(null),
            },
            grid.marks.map((mark) =>
              h('text', { key: `m${mark.column}`, className: 'dub-hm-month', x: heatX(mark.column), y: 9 }, `${mark.month}月`),
            ),
            // Only Monday, Wednesday and Friday are named: a label per row does not
            // fit the gutter, and the three are enough to read the grid's alignment.
            [0, 2, 4].map((row) =>
              h(
                'text',
                { key: `w${row}`, className: 'dub-hm-wd', x: 0, y: heatY(row) + HEAT.cell - 1 },
                HEAT_WEEKDAYS[row],
              ),
            ),
            grid.columns.map((cells, column) =>
              cells.map((cell) =>
                cell.future
                  ? null
                  : h('rect', {
                      key: cell.key,
                      className: `dub-hm-cell dub-hm-l${grid.levelOf(cell.value)}`,
                      x: heatX(column),
                      y: heatY(cell.row),
                      width: HEAT.cell,
                      height: HEAT.cell,
                      rx: 2,
                      // Which way the card opens, and where it lands, both depend on
                      // where the body's edge is — so they are decided here, off the
                      // square that was actually entered.
                      onMouseEnter: (event) => {
                        const placement = cardPlacement(event.currentTarget, plotRef.current)
                        setHover({
                          ...cell,
                          up: placement?.up ?? true,
                          // Without layout there is nothing to measure, so the anchor
                          // falls back to the square's own row.
                          top: placement?.top ?? (heatY(cell.row) + HEAT.cell) / HEAT_HEIGHT,
                        })
                      },
                    }),
              ),
            ),
          ),
          hover
            ? h(
                'div',
                {
                  // The chart's tooltip card, re-anchored to a square and carrying the
                  // same four rows, so the two hovers read identically. It opens away
                  // from the nearest edge of the scrolling body.
                  className: `dub-tip dub-hm-tip${hover.up ? ' dub-hm-tip-up' : ''}`,
                  // Clamped the way the chart's tooltip is: half of it would fall
                  // outside the dialog's clipped box at either end of the year. 86px
                  // is half of the card's fixed width.
                  style: {
                    left: `clamp(86px, ${((heatX(hover.column) + HEAT.cell / 2) / width) * 100}%, calc(100% - 86px))`,
                    top: `${(hover.top * 100).toFixed(3)}%`,
                  },
                },
                h('div', { className: 'dub-tip-title' }, heatTitle(hover)),
                SERIES.map((series) =>
                  h(
                    'div',
                    { className: 'dub-tip-row', key: series.key },
                    h('span', { className: 'dub-legend-swatch', style: { background: series.color } }),
                    h('span', { className: 'dub-tip-label' }, series.label),
                    h('span', { className: 'dub-tip-value' }, series.format(hover.metrics?.[series.key] ?? 0)),
                  ),
                ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'dub-hm-foot' },
          h('span', null, '每格一天，颜色越深用量越高；悬停看当天明细'),
          h(
            'span',
            { className: 'dub-hm-legend' },
            '少',
            [0, 1, 2, 3, 4].map((level) => h('span', { key: level, className: `dub-hm-swatch dub-hm-l${level}` })),
            '多',
          ),
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

    /**
     * A small ⓘ whose tooltip carries the explanation a block would otherwise print in full.
     *
     * Native `title` rather than a styled card: the text is prose, it never needs to be clipped
     * against the scrolling body, and this costs no state. `aria-label` carries the same text so
     * it is not only available to a mouse.
     */
    function Info({ text }) {
      return h('span', { className: 'dub-info', title: text, role: 'img', 'aria-label': text }, 'i')
    }

    /** The 用量 panel: ranges, provider filter, totals and the chart. */
    function UsagePanel({ snapshot, initialRange = '24h', initialHidden = [], initialYear = null, initialYearData = null }) {
      const [range, setRange] = React.useState(initialRange)
      const [provider, setProvider] = React.useState('')
      const [year, setYear] = React.useState(initialYear)
      const [yearData, setYearData] = React.useState(initialYearData)
      // Which years exist comes from the data, not from a list in this file: the host asks the
      // store, so the first day a new year has a request it appears here with nothing to edit.
      //
      // The host sends them as **strings** (`store.years()` builds them from date keys) while this
      // panel stores the selected year as a number, so they are normalised once, here, at the
      // boundary. Without that, `years.includes(2025)` against `['2026','2025']` is always false
      // and every selection silently snapped back to the newest year.
      //
      // A selected year that has since disappeared (the cache was deleted, or a different store is
      // in use) falls back to the newest one, so the picker and the chart cannot disagree.
      const yearsKnown = Array.isArray(snapshot.years)
      const years = (yearsKnown ? snapshot.years : [])
        .map(Number)
        .filter((value) => Number.isFinite(value))
      const selectedYear = year && years.includes(year) ? year : years[0] ?? null
      const providers = snapshot.today.providers || []

      React.useEffect(() => {
        if (range !== 'year' || !selectedYear) return undefined
        if (Number(yearData?.year) === Number(selectedYear)) return undefined
        let cancelled = false
        void (async () => {
          try {
            const response = await fetch(`/usage-badge/year?year=${selectedYear}`, { cache: 'no-store' })
            const body = await response.json()
            if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
            if (!cancelled) setYearData(body)
          } catch (error) {
            if (!cancelled) setYearData({ year: Number(selectedYear), months: [], error: String(error?.message ?? error) })
          }
        })()
        return () => {
          cancelled = true
        }
      }, [range, selectedYear, yearData?.year])

      const series = range === 'year' ? yearPoints(yearData, provider) : buildSeries(snapshot, range, provider)
      // The calendar bounds of the selected year: the whole year for one that is over, up to
      // today for the year still running (a future month is not a month with no usage).
      const todayKey = anchorDate(snapshot)
      const currentYear = Number(String(todayKey).slice(0, 4))
      const yearFrom = selectedYear ? `${selectedYear}-01-01` : todayKey
      const yearTo = selectedYear === currentYear ? todayKey : `${selectedYear}-12-31`
      // A host older than `daily` still serves the year's months. For the year still running the
      // snapshot's own days *are* that year's days, so the grid can still be drawn from them —
      // and for a past year there is no such substitute, which is said rather than drawn empty.
      // (That equivalence rests on `CACHE_WINDOW_DAYS` and `DAYS_KEPT` both exceeding 366.)
      const yearDays = yearData?.daily ?? (yearData?.months?.length && selectedYear === currentYear ? snapshot.days : null)
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
          // The year picker is built from the years the store actually holds, newest first.
          range === 'year'
            ? years.length
              ? h(
                  'select',
                  {
                    key: '__year',
                    className: 'dub-year',
                    value: String(selectedYear ?? ''),
                    title: '缓存里有数据的年份',
                    onChange: (event) => {
                      setYear(Number(event.target.value))
                      setYearData(null)
                    },
                  },
                  years.map((value) => h('option', { key: value, value: String(value) }, `${value} 年`)),
                )
              : h(
                  'span',
                  { key: '__year-none', className: 'dub-note' },
                  // An older host does not send `years` at all; saying "the cache has no dated data"
                  // about a cache that certainly does would be a false statement.
                  yearsKnown ? '缓存里还没有带日期的数据' : '宿主半是旧版本，重启客户端后这里会出现年份选择',
                )
            : null,
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
          // A route with usage and no price contributes tokens but no amount, so the
          // totals above are missing it. Naming those models here is what keeps the ¥0
          // from reading as "free" — the switch that causes it lives in 单价配置.
          snapshot.unpriced?.length
            ? h(
                'div',
                { className: 'dub-warn', style: { padding: '8px 0 0' } },
                `${snapshot.unpriced.length} 个模型没有价格，金额未计入它们的用量（token 与请求数照常统计）：` +
                  snapshot.unpriced.slice(0, 5).map((row) => `${row.provider}|${row.model}`).join('、') +
                  (snapshot.unpriced.length > 5 ? ` 等 ${snapshot.unpriced.length} 个` : '') +
                  '。给它们各加一行价格，或在「单价配置」里把「未匹配的模型」改回按 default 计价。',
              )
            : null,
          range === 'year' && selectedYear && !yearData
            ? h('div', { className: 'dub-note', style: { paddingTop: '8px' } }, `正在从缓存里读 ${selectedYear} 年的数据…`)
            : null,
          range === 'year' && yearData?.error
            ? h('div', { className: 'dub-warn', style: { paddingTop: '8px' } }, `读取 ${yearData.year} 年失败：${yearData.error}`)
            : null,
          h(UsageChart, { points: series.points, initialHidden }),
          series.marks
            ? h('div', { className: 'dub-note', style: { paddingTop: '8px' } }, '绿色背景色带标示法定节假日（全天按空闲时段计价）')
            : null,
          // The year at a glance, under the range chart: the same days, read as a
          // calendar rather than as a trend. In the 按年 view it is that calendar year's
          // own grid (Jan 1 to Dec 31), which is exactly what a 53-column picture is for.
          range === 'year'
            ? yearData && !yearData.error
              ? yearDays
                ? h(UsageHeatmap, {
                    snapshot,
                    provider,
                    days: yearDays,
                    from: dateOfKey(yearFrom),
                    to: yearTo,
                    title: `${selectedYear} 年活跃度`,
                  })
                : h(
                    'div',
                    { className: 'dub-note', style: { paddingTop: '8px' } },
                    `宿主半是旧版本，读不到 ${selectedYear} 年的日粒度数据 —— 重启客户端后这里会显示这一年的热力图。`,
                  )
              : null
            : h(UsageHeatmap, { snapshot, provider }),
        ),
      )
    }

    /**
     * The last successful 单价配置 payloads, kept for the life of the page.
     *
     * Switching tabs unmounts this panel, so without a cache every return to the tab
     * starts from the loading placeholder and swaps its contents in a moment later —
     * a visible flicker. Holding the last answer lets the panel render it straight
     * away.
     *
     * `cachedOfficial` also decides *whether* the published list is fetched at all: the page
     * asks for it once, on the first visit, and after that only when the button is pressed. The
     * list changes a few times a year, and a tab switch is not news.
     */
    let cachedConfig = null
    let cachedOfficial = null

    /** The numeric fields the row editor manages, and how to name them in an error. */
    const ROW_NUMBERS = [
      ['inputPerMillion', 'input', '输入'],
      ['cacheReadPerMillion', 'cacheRead', '缓存命中'],
      ['cacheWritePerMillion', 'cacheWrite', '缓存写入'],
      ['outputPerMillion', 'output', '输出'],
      ['multiplier', 'multiplier', '倍率'],
    ]
    /** Row fields the editor owns; everything else a row carries is preserved as it is. */
    const ROW_MANAGED = [...ROW_NUMBERS.map(([field]) => field), 'timeOfUse']

    /**
     * A row's content, independent of key order, for "has this row changed underneath me?".
     *
     * Parsing the file again produces a fresh object with the same content, so identity cannot
     * answer that question — and comparing `JSON.stringify` directly would flip on key order.
     */
    function rowDigest(value) {
      if (!value || typeof value !== 'object') return JSON.stringify(value ?? null)
      return JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]))
    }

    /** Whether two override keys are the same row as far as resolution is concerned. */
    const sameKey = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

    /** `[[9,12],[14,18]]` → `09:00–12:00、14:00–18:00`. */
    const rangesText = (ranges) => (ranges ?? []).map(([from, to]) => `${pad2(from)}:00–${pad2(to)}:00`).join('、')

    /**
     * The editor's draft for one row: numbers as strings, so an empty field stays empty.
     *
     * `tableRule` is the table's own `timeOfUse`, used only to seed a rule that does not exist
     * yet: a custom rule created here should start from the policy already in force (its days,
     * and whether it honours the holiday calendar) rather than from a hard-coded guess that
     * could contradict the table for this one row.
     */
    function draftOf(entryKey, row, tableRule) {
      const tou = row?.timeOfUse
      const text = (value) => (value == null ? '' : String(value))
      const named = (value) => (['weekday', 'weekend', 'all'].includes(value) ? value : null)
      return {
        key: entryKey ?? '',
        input: text(row?.inputPerMillion),
        cacheRead: text(row?.cacheReadPerMillion),
        cacheWrite: text(row?.cacheWritePerMillion),
        output: text(row?.outputPerMillion),
        multiplier: text(row?.multiplier),
        touMode: !tou ? 'inherit' : tou.enabled === false ? 'off' : 'custom',
        peakMultiplier: text(tou?.peakMultiplier),
        // A `days` form the picker cannot express (an array, or an unknown word) is kept as it is
        // rather than replaced by whichever option happens to come first — the blank option says
        // 保持原样 and `build()` then leaves the field alone.
        days: tou ? named(tou.days) ?? '' : named(tableRule?.days) ?? 'weekday',
        honorHolidays: tou ? tou.honorHolidays !== false : tableRule?.honorHolidays !== false,
      }
    }

    /** How one row takes part in peak/valley pricing, in as few words as a cell allows. */
    function touLabel(tou) {
      if (!tou) return '跟随表级'
      if (tou.enabled === false) return '平铺'
      const days = tou.days === 'all' ? '每天' : tou.days === 'weekend' ? '周末' : Array.isArray(tou.days) ? '自定义日子' : '工作日'
      return `×${Number(tou.peakMultiplier) || 1} ${days}${tou.honorHolidays === false ? ' · 无节假日' : ''}`
    }

    /**
     * The editor for one price row.
     *
     * One row at a time rather than a control in every cell: a row's *key* is what decides
     * which models it prices, so the key and its rule belong in one place you can read at
     * a glance. Fields the form does not show are carried over untouched when it saves —
     * a panel that quietly dropped a hand-written `currency` or `contextMultiplier` would
     * be worse than no editor at all.
     */
    function PriceRowForm({ entryKey, row, tableRule, isDefault = false, onSave, onCancel, onDelete }) {
      const [draft, setDraft] = React.useState(() => draftOf(entryKey, row, tableRule))
      const [error, setError] = React.useState('')
      const text = (field) => (event) => setDraft((current) => ({ ...current, [field]: event.target.value }))
      const check = (field) => (event) => setDraft((current) => ({ ...current, [field]: event.target.checked }))
      const preserved = Object.keys(row ?? {}).filter((field) => !ROW_MANAGED.includes(field))

      /**
       * The row this draft describes, built on top of whatever the row already held.
       *
       * The catch-all row manages its four rates and nothing else: `multiplier` and `timeOfUse` are
       * read from the table, not from `default`, so offering them here would be offering fields
       * that do nothing. `currency` is not managed either — everything is quoted in CNY, and a row
       * that still carries one (an advanced, hand-written field) keeps it untouched.
       */
      const build = () => {
        const next = { ...(row ?? {}) }
        for (const [field, source] of ROW_NUMBERS) {
          if (isDefault && field === 'multiplier') continue
          const value = String(draft[source] ?? '').trim()
          if (value === '') delete next[field]
          else next[field] = Number(value)
        }

        if (isDefault) return next
        if (draft.touMode === 'inherit') delete next.timeOfUse
        else if (draft.touMode === 'off') next.timeOfUse = { ...(row?.timeOfUse ?? {}), enabled: false }
        else {
          const tou = { ...(row?.timeOfUse ?? {}), enabled: true }
          const peak = String(draft.peakMultiplier ?? '').trim()
          if (peak === '') delete tou.peakMultiplier
          else tou.peakMultiplier = Number(peak)
          if (draft.days) tou.days = draft.days
          // Windows are not editable here, so a rule that has none takes the table's
          // rather than silently becoming a rule that never charges a peak hour.
          if (!Array.isArray(tou.peakRanges)) tou.peakRanges = tableRule?.peakRanges ?? []
          if (draft.honorHolidays) delete tou.honorHolidays
          else tou.honorHolidays = false
          next.timeOfUse = tou
        }
        return next
      }

      const submit = () => {
        const key = draft.key.trim()
        if (!isDefault && !key) return setError('键不能为空')
        // An all-empty catch-all row does nothing at all — it would just be a key in the file that
        // the panel reports as "your row" while every rate still comes from the template.
        if (isDefault && ROW_NUMBERS.every(([, source]) => String(draft[source] ?? '').trim() === '')) {
          return setError('兜底行至少要填一个值 —— 全是空等于没有这一行')
        }
        for (const [field, source, label] of ROW_NUMBERS) {
          if (isDefault && field === 'multiplier') continue
          const value = String(draft[source] ?? '').trim()
          if (value !== '' && !Number.isFinite(Number(value))) return setError(`${label} 不是数字`)
        }
        if (!isDefault && draft.touMode === 'custom') {
          const peak = String(draft.peakMultiplier ?? '').trim()
          if (peak !== '' && !Number.isFinite(Number(peak))) return setError('峰时倍率不是数字')
        }
        setError('')
        return onSave(key, build())
      }

      return h(
        'div',
        { className: 'dub-form' },
        h('div', { className: 'dub-block-title' }, isDefault ? '编辑 default 兜底行' : entryKey ? `编辑 ${entryKey}` : '新增一行'),
        isDefault
          ? h('div', { className: 'dub-form-row' }, h('label', null, '键'), h('span', { className: 'dub-model' }, 'default（兜底行，键固定）'))
          : h(
              'div',
              { className: 'dub-form-row' },
              h('label', null, '键'),
              h('input', { className: 'dub-form-key', value: draft.key, onChange: text('key'), placeholder: '模型名 / provider|模型名 / provider|* / *|模型名' }),
            ),
        h(
          'div',
          { className: 'dub-form-row' },
          h('label', null, '输入'),
          h('input', { className: 'dub-form-num', value: draft.input, onChange: text('input') }),
          h('label', null, '缓存命中'),
          h('input', { className: 'dub-form-num', value: draft.cacheRead, onChange: text('cacheRead') }),
          h('label', null, '缓存写入'),
          h('input', { className: 'dub-form-num', value: draft.cacheWrite, onChange: text('cacheWrite') }),
          h('label', null, '输出'),
          h('input', { className: 'dub-form-num', value: draft.output, onChange: text('output') }),
        ),
        h(
          'div',
          { className: 'dub-form-row' },
          isDefault ? null : h('label', null, '倍率'),
          isDefault ? null : h('input', { className: 'dub-form-num', value: draft.multiplier, onChange: text('multiplier'), placeholder: '跟随全局' }),
          isDefault ? null : h('label', null, '峰谷'),
          isDefault
            ? null
            : h(
                'select',
                { value: draft.touMode, onChange: text('touMode') },
                h('option', { value: 'inherit' }, '跟随表级'),
                h('option', { value: 'off' }, '不参与峰谷'),
                h('option', { value: 'custom' }, '自定义'),
              ),
        ),
        !isDefault && draft.touMode === 'custom'
          ? h(
              'div',
              { className: 'dub-form-row' },
              h('label', null, '峰时倍率'),
              h('input', { className: 'dub-form-num', value: draft.peakMultiplier, onChange: text('peakMultiplier') }),
              h('label', null, '适用日子'),
              h(
                'select',
                { value: draft.days, onChange: text('days') },
                draft.days === '' ? h('option', { value: '' }, '保持原样') : null,
                h('option', { value: 'weekday' }, '周一至周五'),
                h('option', { value: 'weekend' }, '周末'),
                h('option', { value: 'all' }, '每天'),
              ),
              h(
                'label',
                { className: 'dub-form-check' },
                h('input', { type: 'checkbox', checked: draft.honorHolidays, onChange: check('honorHolidays') }),
                '节假日按空闲',
              ),
            )
          : null,
        !isDefault && draft.touMode === 'custom'
          ? h(
              'div',
              { className: 'dub-note' },
              tableRule?.peakRanges?.length
                ? `峰时窗口沿用表级：${rangesText(tableRule.peakRanges)}；倍率留空即不加价，改窗口请直接编辑 pricing.json。`
                : '表级也没有峰时窗口 —— 这一行会一直不加价；写了倍率也一样（没有窗口就没有高峰时段）。',
            )
          : null,
        isDefault
          ? h(
              'div',
              { className: 'dub-note' },
              '兜底行只管四个单价 —— 没有任何行匹配的模型按它计价。倍率与峰谷是表级设置（pricing.json 的 multiplier / timeOfUse），写在这一行里不会生效，所以这里不提供；' +
                '删掉这一行，表就回到内置模板，下次点「应用官方价格」会按官方列表第一条重新生成。',
            )
          : null,
        preserved.length > 0
          ? h('div', { className: 'dub-note' }, `本行另有字段原样保留：${preserved.map((field) => `${field}=${JSON.stringify(row[field])}`).join('、')}`)
          : null,
        error ? h('div', { className: 'dub-warn' }, error) : null,
        h(
          'div',
          { className: 'dub-form-actions' },
          h('button', { className: 'dub-btn', onClick: onCancel }, '取消'),
          entryKey || isDefault
            ? h(
                'button',
                { className: 'dub-btn', onClick: () => onDelete(entryKey, isDefault), title: isDefault ? '删除后可用「应用官方价格」重新生成' : '点一下即删除并写入 pricing.json' },
                isDefault ? '删除兜底行' : '删除此行',
              )
            : null,
          h('button', { className: 'dub-btn dub-btn-primary', onClick: submit }, '保存'),
        ),
      )
    }

    /**
     * The 单价配置 panel.
     *
     * The published price list is fetched live every time this panel opens, which
     * is what makes the official numbers visible without a background poll. The
     * host coalesces requests that land within a few seconds of each other so
     * reopening the panel cannot hammer the docs site.
     */
    function ConfigPanel({ snapshot, reload, initialConfig = null, initialOfficial = null, initialEdit = null }) {
      const [official, setOfficial] = React.useState(initialOfficial ?? cachedOfficial)
      const [officialState, setOfficialState] = React.useState(
        (initialOfficial ?? cachedOfficial) ? 'ready' : 'loading',
      )
      const [applyState, setApplyState] = React.useState('idle')
      const [applyNote, setApplyNote] = React.useState('')
      const [fallbackState, setFallbackState] = React.useState('idle')
      const [unmatchedState, setUnmatchedState] = React.useState('idle')
      const [edit, setEdit] = React.useState(initialEdit)
      const [listState, setListState] = React.useState('idle')
      const [config, setConfig] = React.useState(initialConfig ?? cachedConfig)

      const loadOfficial = React.useCallback(async () => {
        // Only show the placeholder when there is nothing to show: flipping to
        // 'loading' with a table already on screen blanks it for a frame.
        if (!cachedOfficial) setOfficialState('loading')
        try {
          const response = await fetch(`/usage-badge/official-pricing?refresh=1&source=${OFFICIAL_SOURCE}`, { cache: 'no-store' })
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
        // Once per page load, on the first visit. The published list is fetched from the network
        // (the URL carries `refresh=1`, which bypasses the host's own short cache), and it changes
        // a few times a year — so leaving and re-entering the tab must not hit the network again.
        // What is on screen is the last answer, with its fetch time shown next to the table and a
        // button to ask again.
        if (!cachedOfficial) void loadOfficial()
      }, [loadOfficial])

      React.useEffect(() => {
        void loadConfig()
      }, [loadConfig])

      const applyOfficial = async () => {
        setApplyState('saving')
        try {
          const response = await fetch('/usage-badge/official-pricing/apply', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: OFFICIAL_SOURCE }),
          })
          const body = await response.json()
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
          setApplyState('applied')
          // Say when the default row was filled in: it decides what an unmatched model costs,
          // so it must not change without the panel mentioning it.
          setApplyNote(body.applied?.defaultFrom ? `；default 行原来没有，已按官方列表第一条（${body.applied.defaultFrom}）补上` : '')
          await loadConfig()
          reload()
        } catch (error) {
          setApplyState(`failed: ${error?.message ?? error}`)
        }
      }

      /**
       * Write one config field and refresh both views.
       *
       * Used by the two switches and by the row editor — everything that writes `pricing.json`
       * through the config route. The summary is reloaded as well, because all of it re-prices
       * history rather than only future requests.
       */
      const writeConfig = async (patch, setState, okValue) => {
        setState('saving')
        try {
          const response = await fetch('/usage-badge/config', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          const body = await response.json()
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
          setState(okValue)
          await loadConfig()
          reload()
        } catch (error) {
          setState(`failed: ${error?.message ?? error}`)
        }
      }

      const toggleFallback = (next) => writeConfig({ modelPrefixFallback: next }, setFallbackState, next ? 'on' : 'off')
      const toggleUnmatched = (next) => writeConfig({ priceUnmatchedModels: next }, setUnmatchedState, next ? 'on' : 'off')

      /**
       * Save the whole override map.
       *
       * The host replaces `overrides` wholesale, so the map sent here is the map that
       * lands in pricing.json — which makes a rename a delete plus an add, exactly what
       * rebuilding the object does. Rows it does not mention are in the map too, and so
       * are their fields: the editor only rewrites the row it was given.
       */
      const saveRow = async (nextKey, row) => {
        // The catch-all row is a document field, not a row in the map.
        if (edit?.isDefault) {
          // Saving a draft seeded before someone else rewrote this row would silently revert
          // them — 「应用官方价格」 rewrites same-named rows, so this is reachable by clicking
          // apply while the form is open.
          if (rowDigest(config?.defaultRow ?? null) !== rowDigest(edit.row ?? null)) {
            setListState('failed: 兜底行在你编辑期间被改过（例如刚应用了官方价格）—— 取消后重新打开再改')
            return
          }
          await writeConfig({ default: row }, setListState, 'saved')
          setEdit(null)
          return
        }
        const overrides = { ...(effective?.overrides ?? {}) }
        // Refuse to land on a key that is already taken, case-insensitively: resolution ignores
        // case, so writing `DeepSeek-Flash` beside `deepseek-flash` would add a second row that can
        // never win, and writing the same key would silently replace a row the form never showed.
        const taken = Object.keys(overrides).find((key) => sameKey(key, nextKey) && key !== edit?.entryKey)
        if (taken) {
          setListState(`failed: 已有「${taken}」这一行（键名不区分大小写），直接编辑它即可`)
          return
        }
        if (edit?.entryKey && rowDigest(overrides[edit.entryKey] ?? null) !== rowDigest(edit.row ?? null)) {
          setListState('failed: 这一行在你编辑期间被改过（例如刚应用了官方价格）—— 取消后重新打开再改')
          return
        }
        if (edit?.entryKey && edit.entryKey !== nextKey) delete overrides[edit.entryKey]
        overrides[nextKey] = row
        await writeConfig({ overrides }, setListState, 'saved')
        setEdit(null)
      }

      /**
       * Delete one row. The catch-all is removed with `default: null` and stays gone until an
       * official apply fills it in again — which is the whole point of being able to delete it.
       */
      const deleteRow = async (entryKey, isDefault = false) => {
        if (isDefault) {
          await writeConfig({ default: null }, setListState, 'deleted-default')
          setEdit(null)
          return
        }
        const overrides = { ...(effective?.overrides ?? {}) }
        delete overrides[entryKey]
        await writeConfig({ overrides }, setListState, 'deleted')
        setEdit(null)
      }

      const effective = config?.effective
      const calendar = config?.calendar ?? snapshot.calendar
      const bundled = config?.bundled
      // What the file has, not the template-merged view: the editor writes what it shows, so a
      // field the user cleared must read as cleared rather than as the template's value.
      const defaultRow = config?.defaultRow ?? null
      const fallbackOff = effective?.modelPrefixFallback === false
      const unmatchedOff = effective?.priceUnmatchedModels === false
      // Where the catch-all row came from. A host that is still being read (or whose read failed)
      // is not an old host, and saying so would send the reader off to restart for nothing.
      const defaultFrom =
        config?.defaultSource === 'template'
          ? '内置模板'
          : config?.defaultSource === 'file'
            ? '你的价格表'
            : config
              ? '未知（宿主是旧版本，重启后可见）'
              : '正在读取…'
      const overrides = Object.entries(effective?.overrides ?? {})

      const policy = official?.policy
      const windowsSource = policy ? rangesText(policy.peakRangesSource) : ''
      const windowsLocal = policy ? rangesText(policy.peakRangesLocal) : ''

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
            h(Info, {
              text: '官方单价就是从这里来的：打开页面后第一次进入这个页签时抓一次 DeepSeek 中文定价页（人民币），之后只有点「重新获取」才会再抓 —— 官方价格一年也就改几次，切页签不该联网。官方页面没点名的模型，在下面的覆盖行里自己维护 —— 汇率、币种、倍率都不需要配置。',
            }),
            h('button', { className: 'dub-btn', onClick: () => void loadOfficial(), disabled: officialState === 'loading' }, '重新获取'),
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
          applyState === 'applied' ? h('div', { className: 'dub-note' }, `已应用并写入 pricing.json${applyNote}`) : null,
          applyState.startsWith('failed') ? h('div', { className: 'dub-warn' }, `应用失败：${applyState.slice(8)}`) : null,
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
                  h('span', { className: 'dub-note' }, `单位：百万 tokens · 人民币 · 获取于 ${new Date(official.fetchedAt).toLocaleTimeString()}${agoSince(official.fetchedAt) ? `（${agoSince(official.fetchedAt)}）` : ''}`),
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
                  { className: 'dub-row', key: 'policy' },
                  h('span', { className: 'dub-note' }, `高峰时段 ${windowsLocal || windowsSource}`),
                  h(Info, {
                    text:
                      // The page's own sentence, not a paraphrase of it.
                      (policy.text
                        ? `页面原文：${policy.text}`
                        : `官方规则：${policy.offPeakIsHalfOfPeak ? '空闲时段价格为高峰时段价格的一半；' : ''}${policy.holidaysOffPeak ? '周末与中国法定节假日全天均为空闲时段。' : ''}`) +
                      (policy.sourceZone
                        ? `\n页面按${policy.sourceZone.name}书写窗口（${windowsSource}），这里已换算到本机时区。`
                        : ''),
                  }),
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
            h(Info, {
              text:
                (bundled?.source && Object.keys(bundled.source).length
                  ? `数据来源：${Object.entries(bundled.source).map(([year, meta]) => `${year} ${meta.document}`).join('；')}。`
                  : '数据来源：国务院办公厅的年度放假安排通知。') +
                '调休上班日也一并收录，但按官方口径不影响计价 —— 周末即使被调休成上班日，政策原文仍说它全天空闲。' +
                '\n自定义日期可在 pricing.json 的 holidays.extra 里追加。',
            }),
            h('span', { className: `dub-chip${calendar?.enabled ? ' dub-chip-holiday' : ''}` }, calendar?.enabled ? '已启用' : '未启用'),
          ),
          // What the bundled table covers is shown whether or not the calendar is on, so
          // switching it on is an informed choice.
          bundled
            ? h(
                'div',
                { className: 'dub-row' },
                h('span', { className: 'dub-note' }, `覆盖 ${bundled.years.join('、')}：${bundled.holidayCount} 个法定节假日`),
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
                h('span', { className: 'dub-note' }, '未启用：工作日节假日会按峰价计费 —— 点「应用官方价格」会自动启用。'),
              ),
          calendar?.missingYears?.length
            ? h('div', { className: 'dub-warn' }, `日历缺少 ${calendar.missingYears.join('、')} 年的数据（尚未公布或未收录），这些日期按普通工作日处理。`)
            : null,
        ),

        // ── what is in effect, and the rows you maintain ─────────────────────
        // The published list above is where prices come from; this is where the rows are
        // read, and where a row that the published list does not name gets written. The
        // editor only ever rewrites the row it was handed, and never invents a field.
        h(
          'div',
          { className: 'dub-block' },
          h(
            'div',
            { className: 'dub-block-head' },
            h('div', { className: 'dub-block-title' }, '当前生效单价'),
            h('span', { className: 'dub-chip' }, '可编辑'),
            h(Info, {
              text:
                '键支持 模型名 / provider|模型名 / provider|* / *|模型名 四种写法（不区分大小写），模型名末尾加 * 表示前缀匹配。' +
                '精确行永远优先于前缀行；行内可自带峰谷规则，未写则跟随表级。' +
                '\n「应用官方价格」会覆盖官方页面点名的同名行，其余行不动。' +
                (config?.paths?.cacheKind
                  ? `\n缓存：${
                      config.paths.cacheKind === 'sqlite'
                        ? 'SQLite（Node 内建的 node:sqlite）—— 一次保存只写变化的那几天，历史留在库里，内存只装最近一年多'
                        : 'JSON 文档 —— 这个运行时没有 node:sqlite，退回旧的单文件缓存（保存代价随历史增长）'
                    }`
                  : '') +
                (config?.paths?.dataDir
                  ? `\n本插件的全部文件都在：${String(config.paths.dataDir).replace(/^.*[\\/]\.dsh[\\/]/, '~/.dsh/').replace(/\\/g, '/')}/`
                  : ''),
            }),
            effective
              ? h('span', { className: 'dub-note' }, `default: ${price(effective.default?.inputPerMillion, effective.default?.currency)} / ${price(effective.default?.cacheReadPerMillion, effective.default?.currency)} / ${price(effective.default?.outputPerMillion, effective.default?.currency)}（${defaultFrom}）`)
              : null,
            h(
              'button',
              { className: 'dub-btn', onClick: () => setEdit({ entryKey: null, row: null }), disabled: !effective, title: '新增一行覆盖价格' },
              '新增一行',
            ),
          ),
          !effective
            ? h('div', { className: 'dub-note' }, '正在读取当前配置…')
            : h(
                React.Fragment,
                null,
                overrides.length === 0 && config.defaultSource !== 'file'
                  ? h('div', { className: 'dub-note' }, '没有覆盖行。')
                  : null,
                config.defaultSource === 'file' || overrides.length > 0
                  ? h(
                      'table',
                      { className: 'dub-table' },
                      h(
                        'thead',
                        null,
                        h(
                          'tr',
                          null,
                          h('th', null, '键'),
                          h('th', null, '输入'),
                          h('th', null, '缓存命中'),
                          h('th', null, '输出'),
                          h('th', null, '倍率'),
                          // Whether a row takes part in peak/valley pricing is the thing that
                          // silently changes a number, so it gets a column of its own rather
                          // than being something you have to go and read the JSON for.
                          h('th', null, '峰谷'),
                          h('th', null, '操作'),
                        ),
                      ),
                      h(
                        'tbody',
                        null,
                        // A catch-all row is listed only when the table really has one. With no
                        // row the built-in template stands in for it, and rendering *that* as a
                        // row made a delete that had worked look like one that did nothing.
                        config.defaultSource === 'file'
                          ? h(
                              'tr',
                              { key: '__default' },
                              h(
                                'td',
                                { className: 'dub-model', title: '兜底行：没有任何行匹配的模型按它计价；倍率与峰谷是表级设置，不在这一行里' },
                                'default',
                              ),
                              h('td', null, defaultRow?.inputPerMillion ?? '—'),
                              h('td', null, defaultRow?.cacheReadPerMillion ?? '—'),
                              h('td', null, defaultRow?.outputPerMillion ?? '—'),
                              h('td', null, '—'),
                              h('td', null, '—'),
                              h(
                                'td',
                                null,
                                h(
                                  'span',
                                  { className: 'dub-table-ops' },
                                  h(
                                    'button',
                                    { className: 'dub-op', onClick: () => setEdit({ entryKey: null, row: defaultRow, isDefault: true }) },
                                    '编辑',
                                  ),
                                  h(
                                    'button',
                                    { className: 'dub-op', onClick: () => void deleteRow(null, true), title: '删除后回到内置模板，可再用「应用官方价格」生成' },
                                    '删除',
                                  ),
                                ),
                              ),
                            )
                          : null,
                        overrides.map(([key, row]) =>
                          h(
                            'tr',
                            { key },
                            h('td', { className: 'dub-model', title: JSON.stringify(row) }, key),
                            h('td', null, row.inputPerMillion ?? '—'),
                            h('td', null, row.cacheReadPerMillion ?? '—'),
                            h('td', null, row.outputPerMillion ?? '—'),
                            h('td', null, row.multiplier ?? '—'),
                            h('td', null, touLabel(row.timeOfUse)),
                            h(
                              'td',
                              null,
                              h(
                                'span',
                                { className: 'dub-table-ops' },
                                h('button', { className: 'dub-op', onClick: () => setEdit({ entryKey: key, row }) }, '编辑'),
                                h(
                                  'button',
                                  { className: 'dub-op', onClick: () => void deleteRow(key), title: '点一下即删除并写入 pricing.json' },
                                  '删除',
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    )
                  : null,
                // What stands in for a missing catch-all, and the way to add one. Only when the
                // host actually said there is none: an old host sends no `defaultSource` at all,
                // and claiming the row is missing would be a guess (and a wrong one if the file
                // has it).
                config.defaultSource === 'template'
                  ? h(
                      'div',
                      { className: 'dub-row' },
                      h(
                        'span',
                        { className: 'dub-note', style: { flex: '1 1 320px' } },
                        `兜底行还没有：未匹配的模型现在按内置模板计价（输入 ${price(effective.default?.inputPerMillion, effective.default?.currency)} / ` +
                          `缓存 ${price(effective.default?.cacheReadPerMillion, effective.default?.currency)} / 输出 ${price(effective.default?.outputPerMillion, effective.default?.currency)}）。`,
                      ),
                      h(
                        'button',
                        {
                          className: 'dub-btn',
                          // Seeded with what is in effect right now, so adding the row changes no
                          // number until the user edits one — and what the form shows is exactly
                          // what gets written.
                          onClick: () => setEdit({ entryKey: null, row: effective.default ?? null, isDefault: true }),
                          title: '按当前生效的兜底价新建一行（可改）',
                        },
                        '添加兜底行',
                      ),
                    )
                  : null,
              ),
          listState === 'saved' ? h('div', { className: 'dub-note' }, '已写入 pricing.json') : null,
          listState === 'deleted' ? h('div', { className: 'dub-note' }, '已删除并写入 pricing.json') : null,
          listState === 'deleted-default'
            ? h('div', { className: 'dub-note' }, '兜底行已删除并写入 pricing.json —— 现在回到内置模板计价；点「应用官方价格」会按官方列表第一条重新生成')
            : null,
          listState.startsWith('failed') ? h('div', { className: 'dub-warn' }, `保存失败：${listState.slice(8)}`) : null,
          // The form mounts per row, so switching rows starts from that row's values.
          edit
            ? h(PriceRowForm, {
                key: edit.isDefault ? '__default-row' : edit.entryKey ?? '__new-row',
                entryKey: edit.entryKey,
                row: edit.row,
                isDefault: Boolean(edit.isDefault),
                tableRule: effective?.timeOfUse,
                onSave: saveRow,
                onCancel: () => setEdit(null),
                onDelete: deleteRow,
              })
            : null,
          // The two switches are a label, a state, a tooltip and a button. Their explanations
          // used to run for three lines each, which is what made this panel hard to scan.
          h(
            'div',
            { className: 'dub-row' },
            h('span', { className: 'dub-note' }, `前缀回退：${fallbackOff ? '已关闭' : '开启'}`),
            h(Info, {
              text: fallbackOff
                ? '已关闭：只有精确行和带 * 的家族行会命中，没有精确行的模型一律走 default 行。'
                : '开启：没有精确行的模型会退到名字最长的前缀行 —— 官方生成的 deepseek-flash 直接就能管 deepseek-flash-preview，不必再手写一行。前缀后面必须是分隔符（- _ . : / @），所以 deepseek-flash 吞不掉 deepseek-flashpreview，gpt-4 也吞不掉 gpt-4o。',
            }),
            h(
              'button',
              {
                className: 'dub-btn',
                onClick: () => void toggleFallback(fallbackOff),
                disabled: !effective || fallbackState === 'saving',
                title: '写进本插件的 pricing.json，并重算所有历史日期',
              },
              fallbackOff ? '开启前缀回退' : '关闭前缀回退',
            ),
          ),
          fallbackState === 'on' || fallbackState === 'off'
            ? h('div', { className: 'dub-note' }, fallbackState === 'on' ? '已开启并写入 pricing.json' : '已关闭并写入 pricing.json')
            : null,
          fallbackState.startsWith('failed')
            ? h('div', { className: 'dub-warn' }, `切换失败：${fallbackState.slice(8)}`)
            : null,
          // The other half of the same question: what a model that matches nothing costs.
          h(
            'div',
            { className: 'dub-row' },
            h(
              'span',
              { className: 'dub-note' },
              !effective
                ? '未匹配的模型：正在读取当前配置…'
                : unmatchedOff
                  ? '未匹配的模型：不计价'
                  : `未匹配的模型：按 default 行计价（${defaultFrom}）`,
            ),
            h(Info, {
              text: unmatchedOff
                ? '不计价：没有任何行匹配的模型只统计 token 与请求数，金额记 0；用量面板会列出是哪些模型，所以那个 ¥0 不是无声的。'
                : `按 default 行计价。当前 default 来自${defaultFrom}：` +
                  `输入 ${price(effective?.default?.inputPerMillion, effective?.default?.currency)} / ` +
                  `缓存 ${price(effective?.default?.cacheReadPerMillion, effective?.default?.currency)} / ` +
                  `输出 ${price(effective?.default?.outputPerMillion, effective?.default?.currency)}。` +
                  (config?.defaultSource === 'template'
                    ? '点「添加兜底行」能自己写，或点「应用官方价格」按官方列表第一条生成。'
                    : ''),
            }),
            h(
              'button',
              {
                className: 'dub-btn',
                onClick: () => void toggleUnmatched(unmatchedOff),
                disabled: !effective || unmatchedState === 'saving',
                title: '写进本插件的 pricing.json，并重算所有历史日期',
              },
              unmatchedOff ? '改为按 default 计价' : '改为不计价',
            ),
          ),
          unmatchedState === 'on' || unmatchedState === 'off'
            ? h(
                'div',
                { className: 'dub-note' },
                unmatchedState === 'off'
                  ? '未匹配的模型已改为不计价，并写入 pricing.json'
                  : '未匹配的模型已改为按 default 行计价，并写入 pricing.json',
              )
            : null,
          unmatchedState.startsWith('failed')
            ? h('div', { className: 'dub-warn' }, `切换失败：${unmatchedState.slice(8)}`)
            : null,
        ),
      )
    }

    function UsageDialog({
      snapshot,
      onClose,
      reload,
      initialTab = 'usage',
      initialConfig = null,
      initialOfficial = null,
      initialRange = '24h',
      initialHidden = [],
      initialYear = null,
      initialYearData = null,
      initialEdit = null,
    }) {
      const [tab, setTab] = React.useState(initialTab)
      const [config, setConfig] = React.useState(initialConfig ?? cachedConfig)
      const chip = bandChip(snapshot)

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      // The version handshake belongs to the dialog rather than to one tab: a refreshed page
      // against an unrestarted host is the normal way to get a UI whose buttons silently do
      // nothing, and that has to be said wherever the reader happens to be looking. One read per
      // page lifetime (the config tab keeps its own reads for the table itself); if it fails the
      // banner is simply absent, because both tabs work without it.
      React.useEffect(() => {
        if (config) return undefined
        let cancelled = false
        void (async () => {
          try {
            const response = await fetch('/usage-badge/config', { cache: 'no-store' })
            if (!response.ok) return
            const body = await response.json()
            cachedConfig = body
            if (!cancelled) setConfig(body)
          } catch {
            // best effort: the banner is an explanation, not a feature
          }
        })()
        return () => {
          cancelled = true
        }
      }, [config])

      // Shown only on a mismatch, in both directions: the host being older is the common one
      // (the browser half is re-read on every page load, the host half only when DSH restarts).
      const versionNote =
        config && config.apiVersion !== REQUIRED_HOST_API
          ? config.apiVersion === undefined || config.apiVersion < REQUIRED_HOST_API
            ? `宿主半还是旧版本（API ${config.apiVersion ?? '未知'}，界面需要 ${REQUIRED_HOST_API}）：本页的开关、编辑、删除与「按年」可能点了没反应或显示不全 —— 重启客户端后再试。`
            : `界面是旧版本（需要 API ${REQUIRED_HOST_API}，宿主已经是 ${config.apiVersion}）：刷新页面即可。`
          : null

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
          versionNote ? h('div', { className: 'dub-warn dub-version' }, versionNote) : null,
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
          // Only the active panel is mounted, so the config panel remounts on every return to its
          // tab — which is exactly why its two payloads are kept for the page's lifetime: they
          // render at once, and the published price list is not fetched again unless the button is
          // pressed (`cachedOfficial` doubles as the "has it been fetched" flag).
          tab === 'usage'
            ? h(UsagePanel, { snapshot, initialRange, initialHidden, initialYear, initialYearData })
            : h(ConfigPanel, { snapshot, reload, initialConfig, initialOfficial, initialEdit }),
        ),
      )
    }

    /**
     * The pill and its dialog.
     *
     * The optional props exist so a headless test can render the real component
     * against a real snapshot without a browser: the slot renderer passes none of
     * them, and each defaults to the live behavior.
     *
     * `wide` is the sidebar's own column state, supplied by the `sidebar.footer.action`
     * seat: the full row while expanded, a 36px square on the collapsed rail.
     *
     * @param {{wide?: boolean, initialSnapshot?: object|null, initialOpen?: boolean,
     *   initialTab?: string, initialConfig?: object|null, initialOfficial?: object|null,
     *   initialRange?: string, initialHidden?: string[], initialYear?: number|null,
     *   initialYearData?: object|null, initialEdit?: object|null}} props
     */
    function UsageBadge({
      wide = true,
      initialSnapshot = null,
      initialOpen = false,
      initialTab = 'usage',
      initialConfig = null,
      initialOfficial = null,
      initialRange = '24h',
      initialHidden = [],
      initialYear = null,
      initialYearData = null,
      initialEdit = null,
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
          ? h(UsageDialog, { snapshot, onClose: () => setOpen(false), reload: load, initialTab, initialConfig, initialOfficial, initialRange, initialHidden, initialYear, initialYearData, initialEdit })
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
