# 015 — Frontend: Inference Log Dashboard

Depends on: backend specs **007-logs-api** and **014-logs-stats-api**, frontend
spec **009** (foundation, design system, router, app shell, `api.ts`).
Related: **010** links here from a chat's header.

Numbered 015 because the design doc's feature breakdown reserves
**012-streaming** and **013-docs**.

> **This spec reverses a design-doc decision.** The design doc's Flow 6 and
> specs 007/009/010 all state that inference-log inspection is **API-only in
> v1**. That was the right call while the alternative was a table rendered with
> inline styles. With spec 009's design system and spec 014's aggregates it is
> no longer the right call: the product's entire thesis is that LLM calls are
> opaque and observability makes them operable, and a system that can only
> demonstrate that through `curl` demonstrates it weakly.

## Problem statement

Spec 007 returns log rows; spec 014 returns aggregates. Nothing renders them.
The highest-value question in the system — *"a user reported a bad answer; show
me exactly what the model was sent and what it returned"* — is currently
answered by reading JSON, and the monitoring questions (is latency degrading?
what are we spending? what is failing?) are not answered at all.

This spec builds two screens:

1. **`/logs`** — an observability dashboard: a filter bar, a KPI row, five
   charts, and a paginated log table. Grafana-shaped, but built as one designed
   system rather than a grid of default-styled widgets.
2. **`/logs/:requestId`** — the log detail page: the full rendered prompt, the
   full completion, request parameters, provider metadata, timings, tokens, and
   cost. The debugging artifact, readable.

**In scope:** both routes, the chart layer, the filter model and its URL
synchronisation, the log table, the detail page, the `recharts` dependency, and
the chart palette (validated here).

**Out of scope:** any backend change (014 owns the API), alerting, saved views,
CSV/eval export, content search, log deletion or annotation, quality scores
(`inference_scores` is designed, not built), auto-refresh (see NFRs), and
streaming metrics beyond the TTFT column that 014 already returns as null until
spec 012.

## Functional requirements

### Shell and layout

1. **FR1** — `/logs` and `/logs/:requestId` render **without the conversation
   rail** (spec 009's FR3): the dashboard is full-bleed, with a
   "← Back to chat" control in its own header.
2. **FR2** — Dashboard layout, top to bottom: page header → filter bar → KPI
   row → chart grid → log table. The filter bar is sticky below the header on
   scroll so filters are reachable from anywhere on the page.
3. **FR3** — Responsive: KPI row is 1 column `<640px`, 2 at `≥640px`, 3 at
   `≥1024px`, 5 at `≥1440px`. Charts are 1 column below `1024px`, 2 above.
   Every chart and the table scroll inside their own `overflow-x: auto`
   container — **the page body never scrolls horizontally at any width**.

### Filters

4. **FR4** — One filter state object governs the KPI row, every chart, **and**
   the log table. There is no per-panel filter. A filter bar that filters the
   charts but not the table below them is broken by construction — which is why
   spec 014 added `model`/`provider` to `GET /logs`.
5. **FR5** — Filter state is **the URL's search params**, read and written with
   `useSearchParams`. Consequences that are the point: a filtered dashboard is
   shareable, the browser Back button steps through filter changes, and a
   reload preserves them. There is no duplicate copy of the filter state in
   React state.
6. **FR6** — Filters: a time range, `status`, `call_type`, `model`, `provider`,
   and `conversation_id`. Time range presets are `15m · 1h · 6h · 24h · 7d ·
   30d · Custom`; the default is `24h`, matching spec 014's default window.
7. **FR7** — Arriving at `/logs?conversation_id=12` (spec 010's FR5 link)
   pre-applies that filter, shows it as an active, removable filter chip, and
   the page reads as a trace of that conversation.
8. **FR8** — Active filters render as removable chips with a "Clear all"
   action. The chip set is the visible truth of what is being shown, so a user
   is never looking at filtered data without knowing it.
9. **FR9** — `model` and `provider` are populated as select options from the
   `by_model` / `by_provider` breakdowns of an **unfiltered-on-that-dimension**
   stats call — the dashboard does not hard-code model names, and does not need
   a new endpoint to enumerate them.
10. **FR10** — The **bucket size is derived from the window**, never chosen by
    the user, so spec 014's `MAX_BUCKETS` 422 is unreachable by construction:

    | Window | Bucket | Buckets |
    |---|---|---|
    | ≤ 1h | `minute` | ≤ 60 |
    | ≤ 6h | `minute` | ≤ 360 |
    | ≤ 7d | `hour` | ≤ 168 |
    | > 7d | `day` | ≤ 366 |

    The derived bucket is displayed beside the time range ("last 24 hours ·
    hourly") so a reader always knows the granularity they are looking at.
11. **FR11** — Changing a filter issues **one** stats call, **one** timeseries
    call per chart that needs a distinct `group_by`, and **one** logs-list call
    — and resets the table to `offset=0`. Rapid filter changes are debounced by
    250ms, and a superseded response is discarded (spec 009's `useResource`
    request counter).

### KPI row

12. **FR12** — Five stat tiles from `GET /logs/stats`: **Calls**, **Error
    rate**, **p95 latency**, **Total cost**, **Total tokens**. Each shows a
    large value in the display face with the unit in mono, and a `micro`
    uppercase label. A tile is not a chart — no sparkline unless it earns its
    place (see FR13).
13. **FR13** — The **Calls** and **p95 latency** tiles each carry a
    hairline-height sparkline of that metric across the window's buckets,
    because for those two the shape over time is the story. The other three do
    not — a sparkline on every tile is decoration.
14. **FR14** — `cost_coverage < 1.0` renders a warning affordance on the cost
    tile: the value, then "partial — 60% of calls priced", with a tooltip
    explaining that calls whose model was not in the price map have no cost.
    **A partial sum is never displayed as if it were complete** — spec 014's
    `cost_coverage` exists for exactly this and this spec is required to
    surface it.
15. **FR15** — `total_calls === 0` renders every tile with an em-dash and the
    "no calls in this window" caption — **not** `0`, and not a zero-value
    percentile. `latency: null` from the API becomes an em-dash, never `0 ms`.

### Charts

16. **FR16** — Five charts, each chosen by the job its data does. This list is
    exhaustive; adding a sixth is a spec edit.

    | # | Panel | Job | Form | Colour role |
    |---|---|---|---|---|
    | 1 | Calls over time, by status | magnitude + composition over time | stacked columns | **status** palette |
    | 2 | Latency percentiles over time | change over time, 3 ordered series | 3 lines | **ordinal** ramp |
    | 3 | Error rate over time | change over time, one rate | 1 line + 10% area wash | **status: error** |
    | 4 | Tokens over time, input vs output | composition over time | stacked columns | **categorical** slots 1–2 |
    | 5 | Cost by model | magnitude across nominal categories | horizontal bars | **categorical slot 1 for every bar** |

17. **FR17** — **No dual-axis chart anywhere.** Latency (ms) and error rate
    (fraction) are different scales, which is precisely why they are panels 2
    and 3 rather than one chart with two y-scales. This is the single most
    common dashboard error and it is prohibited here by name.
18. **FR18** — Panel 5 uses **one colour for every bar** (categorical slot 1).
    Models are nominal categories with no natural order; colouring them
    darker-where-bigger would double-encode bar length as hue and burn the only
    free channel on information the bars already show.
19. **FR19** — Mark specifications, fixed across every chart: bars **≤24px**
    thick with a **4px rounded data-end and a square baseline end**; lines
    **2px** with round joins; markers **≥8px** with a 2px surface-colour ring;
    area fills at **~10% opacity**; gridlines and axes **1px solid** in
    `--color-hairline`, **never dashed**, recessive. A **2px gap in the surface
    colour** separates every touching mark — each segment of a stacked column
    and every adjacent column — implemented by **insetting the segment
    geometry, not by stroking the mark**.
20. **FR20** — A **legend is present on every chart with two or more series**
    and absent on single-series charts (the title already names what is
    plotted). Legend swatches are marks; legend *text* wears text tokens.
21. **FR21** — Direct labels are **selective, never one per point**: the
    percentile lines are labelled at their right-hand end (`p50 / p95 / p99`),
    the cost bars carry their value at the tip, and everything else is carried
    by the axis, the legend, and the tooltip. A label that does not fit moves
    outside its mark or is dropped to the tooltip — it is **never clipped** and
    `overflow: hidden` is never used to "solve" it.
22. **FR22** — **Text never wears a series colour.** Values, labels, legend
    text, and axis ticks use `--color-ink*`. Identity comes from the coloured
    mark beside the text.
23. **FR23** — Every chart has a crosshair-and-tooltip layer. Line and area
    charts share a single vertical crosshair tooltip listing every series at
    that bucket; column and bar charts use a per-mark tooltip. Tooltips are
    themed to `--color-surface-raised`, set numbers in mono with `tabular-nums`,
    and show the bucket's start time. Hit targets are larger than the marks.
24. **FR24** — **Empty buckets render as gaps, not as zeros, for rate and
    percentile lines** (`latency_p50_ms: null` from spec 014 → a break in the
    line), and as zero-height columns for counts. "No calls happened" and "the
    value was zero" are different facts and must look different.
25. **FR25** — Every chart panel has a **"Table" toggle** rendering the same
    series as an accessible HTML `<table>` with a caption. This is the
    non-visual channel for the chart's data and is required, not optional.
26. **FR26** — Each chart carries `role="img"` and an `aria-label` one-line
    summary of what it shows and its range, so the chart is not silent to a
    screen reader even before the table view is opened.
27. **FR27** — Clicking a status segment in panel 1 sets the `status` filter;
    clicking a bar in panel 5 sets the `model` filter. Drill-down is via the
    same URL-backed filter state as everything else, so it is undoable with the
    Back button.
28. **FR28** — **Colour follows the entity, never its rank.** A model's hue is
    assigned from a stable ordering of the model name, so filtering out a
    series does not repaint the survivors. A 6th distinct value folds into the
    `is_other` series that spec 014 already returns — a hue is never generated
    or cycled.
29. **FR29** — Every panel owns its own loading, empty, and error state (spec
    009's vocabulary). A chart's skeleton is an **axis frame with a shimmering
    plot area** — the panel's geometry never changes between skeleton and
    content, so the page does not reflow when data arrives. One failing panel
    does not blank the dashboard.

### Log table

30. **FR30** — Below the charts, a paginated table from
    `GET /logs`, honouring the same filters (FR4). Columns: time,
    status, call type, model, latency, tokens (in/out), cost, and
    `input_preview`. Every numeric column is mono, `tabular-nums`, and
    right-aligned.
31. **FR31** — `status` renders as a `Chip` with the reserved status colour
    **plus an icon plus the text label** — never colour alone.
32. **FR32** — A row's `input_preview` is single-line and truncated with an
    ellipsis. The full content is on the detail page; the table does not expand
    inline.
33. **FR33** — Clicking a row navigates to `/logs/{request_id}`. The
    `request_id` is also shown in mono, truncated to 8 characters, with a copy
    action.
34. **FR34** — Pagination: Prev/Next over `limit=25`, with
    `Showing {offset+1}–{offset+items.length} of {total}`. Boundary controls
    disabled per spec 009's FR18 rules.
35. **FR35** — An empty table under active filters shows the **filters-matched-
    nothing** empty state (spec 009's vocabulary) with a "Clear filters"
    action — distinct from the first-run "no logs yet" state.

### Log detail page

36. **FR36** — `/logs/:requestId` fetches `GET /logs/{request_id}` and renders,
    in this order: a header (status chip, model, provider, call type, and the
    full `request_id` with a copy action); a **timing strip**; a metrics row; the
    **rendered prompt**; the **completion**; request parameters; provider
    metadata; and the error block when present.
37. **FR37** — The timing strip is a single horizontal bar spanning
    `requested_at → completed_at`, annotated with `latency_ms` and, when
    non-null, a TTFT marker. When `completed_at` is null (an error or cancelled
    log) the bar is drawn open-ended with the reason labelled. This is the one
    place a bespoke visualisation is drawn rather than a recharts panel; it is
    the detail page's signature element.
38. **FR38** — `input_messages` renders as a **transcript**: one block per
    entry, role-labelled in `micro` type, system prompt visually distinguished
    and collapsed by default (it is identical on every log and would otherwise
    dominate the page). Content is `whitespace-pre-wrap` **plain text** — never
    HTML, never `dangerouslySetInnerHTML`. A "Copy full prompt" action copies
    the JSON.
39. **FR39** — `output_text` renders in a panel with a copy action, using spec
    010's FR12 fenced-code treatment so a completion containing code is
    readable. When null, the panel states which status caused it rather than
    rendering empty.
40. **FR40** — `request_params`, `provider_metadata`, and `config_hash` render
    as a key/value grid with mono values, `null` shown as an em-dash. A nested
    object falls back to a formatted, scrollable JSON block — the page never
    renders `[object Object]`.
41. **FR41** — `cost_usd: null` renders as "not priced" with a tooltip, **not**
    as `$0.00`.
42. **FR42** — A "View all logs for this conversation" link appears when
    `conversation_id` is non-null, pointing at
    `/logs?conversation_id={id}`, and a "Open conversation" link to
    `/c/{id}`. The second may 404 — logs deliberately outlive conversations
    (spec 007 rule 2) — so it is labelled as a link that may no longer resolve
    rather than presented as guaranteed.
43. **FR43** — An unknown `request_id` renders the not-found panel with "Back
    to logs", not a blank page.
44. **FR44** — All backend calls go through typed functions in `src/api.ts`.
    No `fetch` in any component.

## Non-functional requirements

- **One new dependency: `recharts` ^2.** It is the only chart library added.
  The alternative — hand-written SVG for five chart types plus tooltips,
  crosshairs, and responsive axes — is a large amount of subtle code for no
  gain, and this route is code-split (spec 009's FR7) so its cost is not paid
  by the chat.
- **No client-side aggregation.** Every number on the dashboard comes from
  spec 014. The frontend formats and lays out; it never sums, averages, or
  computes a percentile. If a number is wanted that 014 does not return, the
  fix is a change to 014.
- **No auto-refresh, no polling, no websockets** (CLAUDE.md out-of-scope
  default). A manual "Refresh" control is the only re-read, and it is honest
  about what it does: the timestamp of the last load is displayed beside it.
  This is a real deviation from Grafana-like expectations and is deliberate;
  adding a refresh interval is a spec change, not a config toggle.
- **Route-level code splitting.** `recharts` must not appear in the initial
  bundle. Verified by an acceptance criterion.
- **Design tokens only** — every value resolves to a token from spec 009's
  design system, plus the chart palette defined in this spec.
- **Accessibility, non-negotiable:** every chart has a table view (FR25) and an
  `aria-label` (FR26); no information is conveyed by colour alone (FR20/FR31);
  the palette is validated for CVD (below); charts and the table are keyboard
  navigable; reduced motion disables all chart animation.
- **TypeScript `strict`**; no `any` in exported signatures, including the
  recharts tooltip and shape render props (typed, not cast).

## Chart palette

Defined here rather than in spec 009 because this is the only spec that draws
charts. It **extends** spec 009's token layer with chart-only tokens; it does
not redefine any existing token, and it does not introduce a colour outside
these lists.

**Every palette below was validated with the `dataviz` skill's
`validate_palette.js` against this app's actual surfaces** — the dark chart
surface `#12171F` and the light chart surface `#FFFFFF`. The results are
recorded so nobody re-derives them, and the validator is to be re-run if any
value changes.

### Categorical — identity (model, provider, input-vs-output)

Assigned in **fixed order**, never cycled. A 6th value folds into spec 014's
`is_other` series.

| Slot | Dark | Light |
|---|---|---|
| 1 | `#1C9EE0` | `#1183C0` |
| 2 | `#DB2777` | `#C2185B` |
| 3 | `#6DA80E` | `#5A8C0C` |
| 4 | `#8B5CF6` | `#7C3AED` |
| 5 | `#12A594` | `#00998A` |

Validator result — **all six checks PASS in both modes**:

```
dark  (surface #12171F): band PASS · chroma PASS · CVD PASS (worst adjacent
      ΔE 12.5 deutan) · normal-vision PASS (worst 28.3) · contrast PASS
light (surface #FFFFFF): band PASS · chroma PASS · CVD PASS (worst adjacent
      ΔE 8.4 deutan) · normal-vision PASS (worst 30.1) · contrast PASS
```

Slot order is load-bearing — it is what makes the adjacent-pair CVD separation
pass. Do not reorder to "look nicer".

### Status — reserved state (success / cancelled / error)

Spec 009's status tokens, unchanged, reused as the palette for panel 1. **Never
used for a non-status series, and no categorical slot is ever used for a
status.**

| Role | Dark | Light |
|---|---|---|
| success | `#0FA968` | `#047857` |
| cancelled | `#94A3B8` | `#64748B` |
| error | `#EF4A5E` | `#DC2626` |

Recorded deviations, both accepted and both mitigated by the **icon + label**
pairing that FR31 and FR20 require:

- `cancelled` sits **below the chroma floor by design** — it is a deliberate
  neutral slate, because a cancellation is user intent rather than a fault, and
  spec 010 depends on it not reading as an error.
- In light mode the `success ↔ cancelled` pair measures ΔE 12.3 unsimulated,
  under the 15 series floor. This is the documented status-palette pattern:
  status colour never carries meaning alone.

### Ordinal — the latency percentile ramp (p50 → p95 → p99)

Percentiles are an ordered sequence, so this is one hue with monotone steps —
**not** three categorical slots.

| Step | Dark | Light |
|---|---|---|
| p50 | `#2E7FA8` | `#7FC4E8` |
| p95 | `#1C9EE0` | `#1183C0` |
| p99 | `#7DD3FC` | `#0B4F73` |

The ramp runs **from least to most salient against the surface** in both modes
(dimmer→brighter on dark, lighter→darker on light), so severity increases with
visual weight regardless of theme. A sequential ramp **fails the categorical
adjacency checks by design** — it spans the lightness band and its steps sit
close — so the relief that FR21's direct end-labels provide is not optional
here: each line is labelled `p50` / `p95` / `p99` at its right end.

### Chart chrome

| Role | Token |
|---|---|
| Chart surface | `--color-surface` |
| Gridlines, axis lines | `--color-hairline`, 1px, solid |
| Axis tick text, units | `--color-ink-muted`, `micro` |
| Value labels | `--color-ink-secondary`, mono |
| Tooltip surface | `--color-surface-raised` + `--shadow-raised` |
| Crosshair | `--color-hairline`, 1px solid |
| Area fill | series hue at 10% opacity |
| Surface gap / mark ring | `--color-surface`, 2px |

**Deliberately not defined:** a diverging palette. No panel in FR16 encodes
polarity, and the accessory that is not needed is the one to remove. Adding a
period-over-period delta chart later means adding a validated diverging pair
here first.

## Data model

**No database changes.** Frontend-only — no SQLAlchemy model, no Alembic
migration, no file under `backend/` is touched. Spec 014 owns all backend work.

### TypeScript types (`src/api.ts`, mirroring 007/014 Pydantic names)

```ts
export type LogStatus = 'success' | 'error' | 'cancelled'
export type CallType = 'chat' | 'title'
export type BucketSize = 'minute' | 'hour' | 'day'
export type LogGroupBy = 'none' | 'status' | 'model' | 'provider' | 'call_type'

export type InferenceLogSummary = {
  id: number
  request_id: string
  conversation_id: number | null
  call_type: CallType
  model: string
  provider: string
  status: LogStatus
  latency_ms: number
  input_tokens: number | null
  output_tokens: number | null
  time_to_first_token_ms: number | null
  cost_usd: string | null          // Decimal serialises as a string — never parse to float for display
  error_type: string | null
  config_hash: string | null
  requested_at: string
  completed_at: string | null
  created_at: string
  input_preview: string | null
  output_preview: string | null
}

export type InferenceLogRead = InferenceLogSummary & {
  schema_version: number
  input_messages: Array<{ role: string; content: unknown }>
  output_text: string | null
  request_params: Record<string, unknown> | null
  provider_metadata: Record<string, unknown> | null
  error_message: string | null
}

export type TimeWindow = { from: string; to: string }
export type LatencyStats = { p50_ms: number; p95_ms: number; p99_ms: number; avg_ms: number; max_ms: number }
export type TokenStats = { input: number; output: number; total: number }

export type LogGroupStat = {
  key: string
  is_other: boolean
  calls: number
  error_count: number
  error_rate: number
  latency_p95_ms: number | null
  input_tokens: number
  output_tokens: number
  cost_usd: string | null
}

export type LogStatsRead = {
  window: TimeWindow
  total_calls: number
  success_count: number
  error_count: number
  cancelled_count: number
  error_rate: number
  latency: LatencyStats | null
  ttft: LatencyStats | null
  tokens: TokenStats
  cost_usd: string | null
  cost_coverage: number
  by_model: LogGroupStat[]
  by_provider: LogGroupStat[]
  by_call_type: LogGroupStat[]
  by_status: LogGroupStat[]
}

export type TimeseriesPoint = {
  t: string
  calls: number
  error_count: number
  cancelled_count: number
  latency_p50_ms: number | null
  latency_p95_ms: number | null
  input_tokens: number
  output_tokens: number
  cost_usd: string | null
}

export type TimeseriesSeries = { key: string; is_other: boolean; points: TimeseriesPoint[] }

export type LogTimeseriesRead = {
  window: TimeWindow
  bucket: BucketSize
  group_by: LogGroupBy
  bucket_count: number
  series: TimeseriesSeries[]
}
```

`InferenceLogRead` is declared as an extension of `InferenceLogSummary` because
that is exactly the backend relationship (007's summary is the read schema
minus bulk content), so a field added to one cannot silently diverge.

**`cost_usd` is a `string`, not a `number`.** Pydantic serialises `Decimal` as
a string; parsing it to a JS float to format it would reintroduce the precision
loss the backend chose `Numeric(12, 6)` to avoid. `formatCost` in
`src/lib/format.ts` formats the string directly.

### Filter state

Derived from the URL (FR5), never mirrored in React state:

```ts
type LogFilters = {
  range: '15m' | '1h' | '6h' | '24h' | '7d' | '30d' | 'custom'
  from?: string        // only when range === 'custom'
  to?: string
  status?: LogStatus
  call_type?: CallType
  model?: string
  provider?: string
  conversation_id?: number
  offset: number       // table paging only; reset to 0 on any filter change
}
```

`useLogFilters()` reads and writes these through `useSearchParams`, resolves
`range` into concrete `from`/`to`, derives the bucket per FR10, and returns the
query object the api functions take. It is the single place a filter is
interpreted.

## API contracts

Four functions appended to `src/api.ts`, all on spec 009's `request<T>` helper
(and therefore all instrumented into the signal ribbon).

| Function | Endpoint | Signature |
|---|---|---|
| `listLogs` | `GET /logs` | `(q: LogListQuery) => Promise<Page<InferenceLogSummary>>` |
| `getLog` | `GET /logs/{request_id}` | `(requestId: string) => Promise<InferenceLogRead>` |
| `getLogStats` | `GET /logs/stats` | `(q: LogStatsQuery) => Promise<LogStatsRead>` |
| `getLogTimeseries` | `GET /logs/timeseries` | `(q: LogTimeseriesQuery) => Promise<LogTimeseriesRead>` |

All four build their query string with `URLSearchParams`, **omitting** any
undefined filter rather than sending an empty value — spec 014 treats an
unparseable or empty enum as a 422, not as "no filter".

```ts
function toParams(q: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v))
  return p.toString()
}
```

`getLog` is called with a `request_id` taken from a table row, so it needs no
encoding beyond `encodeURIComponent`.

## Constraints

- **One new dependency: `recharts`.** Nothing else — no `d3-*` beyond what
  recharts brings, no date library, no table library, no virtualiser, no JSON
  viewer package (FR40's fallback is `JSON.stringify(x, null, 2)` in a
  `<pre>`).
- **No client-side aggregation, ever.** See NFRs.
- **No dual-axis chart** (FR17), no donut or pie chart, no rainbow ramp, no
  value-ramp on nominal categories (FR18), no generated 9th hue (FR28), no
  dashed gridlines, no mark borders (FR19).
- **The breakdowns by model / provider / call type are a table with inline
  proportion bars, not a donut.** A donut asks the reader to compare angles;
  a sorted bar table answers "which is biggest, and by how much" directly and
  carries the exact numbers.
- **No `dangerouslySetInnerHTML`.** `input_messages` and `output_text` are
  model input and output — untrusted content rendered as plain text.
- **No auto-refresh** (NFRs). No `setInterval`, no refresh-interval control.
- **No inline `fetch`** in components (CLAUDE.md).
- **No write operations.** The dashboard cannot delete, annotate, tag, or
  re-run a log. Logs are immutable observability records.
- **Design tokens only**, plus this spec's chart palette. No hard-coded hex in
  a component.
- Spec 014's route-order requirement means `GET /logs/stats` must not 404. If
  it does during development, the bug is in 014's router, not here.

## Error handling and edge cases

| # | Case | Behaviour |
|---|---|---|
| 1 | No logs at all (fresh database) | KPI tiles show em-dashes with "no calls in this window" (FR15); each chart shows its own empty state inside the panel frame; the table shows the first-run "no logs yet" state. **Not** zeros, and not five error panels. |
| 2 | Filters match nothing | KPI em-dashes plus the filters-matched-nothing empty state with "Clear filters" (FR35), visibly distinct from #1. |
| 3 | Backend unreachable | Each panel independently shows "Cannot reach the backend. Is it running?" with a retry that repeats only that panel's request. One shared banner also appears at the page level so the cause is stated once. |
| 4 | `/logs/stats` fails but `/logs` succeeds | KPI row and charts show their error states; the table still renders. The dashboard degrades panel by panel and never blanks. |
| 5 | Spec 014 returns 422 (an out-of-range bucket) | Should be unreachable — FR10 derives the bucket to stay under `MAX_BUCKETS`. If it happens: the chart panel shows the API's `detail` verbatim and it is treated as a client bug in the bucket derivation. |
| 6 | `latency: null` (no calls in window) | Em-dash on the tile; the percentile chart shows its empty state. **Never `0 ms`** — a zero p95 is a lie. |
| 7 | `cost_usd: null` on the stats response | "Not priced" with a tooltip, `cost_coverage: 0.0` surfaced. **Never `$0.00`** (FR14/FR41). |
| 8 | `0 < cost_coverage < 1` | The value plus "partial — {n}% of calls priced" (FR14). A partial sum is never shown as complete. |
| 9 | `ttft: null` (the state until spec 012) | The TTFT metric is shown as "—" with a caption "available once streaming ships", not hidden. Hiding it would make a designed-for capability invisible. |
| 10 | A bucket with no calls | Count columns render at zero height; rate and percentile lines **break** (FR24). |
| 11 | A window whose every bucket is empty | Charts render their axes and the empty-panel message inside the same frame — the panel does not collapse and the page does not reflow. |
| 12 | More than 5 distinct models | Spec 014 returns the top 8 series plus `is_other`; the charts use the 5 categorical slots for the top 5 and render the rest folded, with `is_other` in `--color-ink-muted` and labelled "Other". **No hue is generated or cycled** (FR28). |
| 13 | Filtering out a series | Survivors keep their hues — colour is assigned from a stable ordering of the entity key, not from row index (FR28). |
| 14 | A model name 60 characters long | Truncated in the legend and axis with the full value in the tooltip and the table view. Never clipped mid-glyph by `overflow: hidden` (FR21). |
| 15 | `conversation_id` filter for a conversation that never existed | 200 with zeros from both APIs (spec 007 rule 2 / 014 edge case 3). Shows the filters-matched-nothing state — **not** a 404 and not an error. |
| 16 | Arriving from spec 010's chat link | `conversation_id` pre-applied, chip visible, dashboard reads as that conversation's trace (FR7). |
| 17 | Custom range with `from >= to` | Rejected client-side with an inline validation message on the range control; **no request is issued** (spec 014 would return 422). |
| 18 | Unknown `request_id` on the detail page | Not-found panel with "Back to logs" (FR43). |
| 19 | A detail log with `output_text: null` | The completion panel states the causing status ("no output — this call errored" / "…was cancelled"), not an empty box (FR39). |
| 20 | A detail log whose `input_messages` entry has non-string `content` (a future multi-part block) | Rendered as a formatted JSON block for that entry. The transcript never renders `[object Object]` and never throws (FR40). |
| 21 | A 40,000-character `output_text` | The panel scrolls internally with a max height and a "show all" toggle; the page does not grow unbounded. |
| 22 | `provider_metadata` with deeply nested objects | Key/value grid for scalars, formatted scrollable JSON for the rest (FR40). |
| 23 | `error_message` up to 2000 characters | Rendered in a bounded, scrollable block in the error status tone, with a copy action. |
| 24 | `completed_at: null` on the timing strip | Open-ended bar with the reason labelled (FR37) — not a zero-width bar and not a crash. |
| 25 | "Open conversation" on a log whose conversation was deleted | The link is labelled as possibly-stale; following it lands on spec 010's not-found panel. Logs deliberately outlive conversations (FR42). |
| 26 | Reduced motion enabled | All recharts animation is disabled (`isAnimationActive={false}`), chart skeletons use a static wash instead of a shimmer, and panel entrance is opacity-only. |
| 27 | Light theme | Every palette switches to its light column; the validator was run against `#FFFFFF` for exactly this. Dark mode is a **designed** counterpart, not an inverted filter. |
| 28 | 360px viewport | One column throughout; each chart scrolls inside its own container; the table scrolls horizontally inside its own wrapper. **No horizontal page scroll** (FR3). |
| 29 | Rapid filter changes | Debounced 250ms; superseded responses discarded. At most one request per endpoint is in flight (FR11). |
| 30 | Table paging while a filter changes | `offset` resets to 0 on any filter change (FR11), so a user is never on page 4 of a 1-page result. |

## Acceptance criteria

Verified **manually** against a running backend (`make backend`) and frontend
(`make frontend`), with logs present — generated by chatting, and by seeding
error/cancelled rows via `POST /ingest/logs`. The project has **no frontend
test setup** and this spec does not add one.

**Shell, filters, routing**

- [ ] `/logs` renders full-bleed with no conversation rail and a working
      "← Back to chat" control.
- [ ] The filter bar sticks below the header when the page is scrolled.
- [ ] Changing the time range to `7d` updates the URL, the KPI row, all five
      charts, and the table — and the granularity caption reads "hourly".
- [ ] Reloading the page preserves every active filter.
- [ ] The browser Back button steps back through filter changes.
- [ ] Copying the URL with filters applied and opening it in a new tab shows
      the identical view.
- [ ] Selecting `1h` shows "minutely"; `30d` shows "daily"; no combination
      produces a 422 from `/logs/timeseries`.
- [ ] Opening a chat, clicking "View inference logs", lands on `/logs` with a
      `conversation_id` chip applied and the dashboard scoped to it.
- [ ] Removing a chip updates the URL and re-queries; "Clear all" resets to the
      default 24h view.
- [ ] The `model` and `provider` selects list the models actually present, with
      no hard-coded names in the source.
- [ ] `/logs/{unknown-request-id}` shows the not-found panel with "Back to
      logs".
- [ ] The DevTools Network panel shows the `recharts` chunk is **not** loaded
      until `/logs` is visited.

**KPI row**

- [ ] With logs present, all five tiles show values, units in mono, and
      `micro` uppercase labels.
- [ ] The Calls and p95 tiles have sparklines; the other three do not.
- [ ] With an empty window, every tile shows an em-dash and "no calls in this
      window" — **no tile shows `0 ms`, `0%`, or `$0.00`**.
- [ ] With some logs unpriced, the cost tile reads "partial — N% of calls
      priced" with an explanatory tooltip.
- [ ] With every log unpriced, the cost tile reads "not priced", not `$0.00`.
- [ ] The TTFT metric shows "—" with the "available once streaming ships"
      caption rather than being hidden.

**Charts**

- [ ] Five panels render, matching FR16's table.
- [ ] **No chart has two y-axes.**
- [ ] Panel 1's segments use the status palette; panel 5's bars are all one
      colour.
- [ ] Bars are ≤24px thick with a rounded outer end and a square baseline end;
      stacked segments are separated by a 2px gap in the surface colour with no
      stroke drawn around any mark.
- [ ] Lines are 2px; gridlines are 1px solid and recessive; **no dashed grid**.
- [ ] Charts with 2+ series have a legend; single-series charts do not.
- [ ] The percentile lines are labelled `p50` / `p95` / `p99` at their right
      ends, and no chart puts a number on every point.
- [ ] No axis tick, label, or legend text is coloured with a series colour.
- [ ] Hovering a line chart shows one crosshair tooltip listing every series
      at that bucket, with mono numbers and the bucket start time.
- [ ] A window containing an hour with no calls shows a **break** in the
      percentile and error-rate lines and a **zero-height column** in the
      count charts.
- [ ] Every panel has a working "Table" toggle rendering the same data as a
      captioned HTML table.
- [ ] A screen reader reads each chart's `aria-label` summary.
- [ ] Clicking an `error` segment in panel 1 applies the `status=error` filter
      and the Back button undoes it.
- [ ] Clicking a bar in panel 5 applies that `model` filter.
- [ ] With 8+ distinct models, exactly 5 carry categorical hues and the
      remainder render as a single muted "Other"; filtering one out does not
      change the others' colours.
- [ ] Stopping the backend leaves each panel with its own error and retry; the
      page does not blank.
- [ ] A panel's skeleton has the same height as its loaded chart — the page
      does not reflow when data arrives.

**Table**

- [ ] Columns match FR30; numeric columns are mono, `tabular-nums`, and
      right-aligned.
- [ ] Status renders as colour **plus** icon **plus** text label.
- [ ] `request_id` shows truncated with a working copy action.
- [ ] Clicking a row opens `/logs/{request_id}`.
- [ ] Paging shows "Showing 1–25 of N" with boundary controls correctly
      disabled.
- [ ] Applying a filter while on page 3 resets to page 1.
- [ ] A filter matching nothing shows the filters-matched-nothing state with
      "Clear filters" — visibly different from the fresh-database state.

**Detail page**

- [ ] A success log shows status, model, provider, call type, and the full
      `request_id` with a copy action.
- [ ] The timing strip spans `requested_at → completed_at` with `latency_ms`
      annotated.
- [ ] An error log's timing strip is open-ended with the reason labelled.
- [ ] `input_messages` renders as a role-labelled transcript with the system
      prompt collapsed by default and expandable.
- [ ] "Copy full prompt" puts the complete JSON on the clipboard.
- [ ] `output_text` renders in full — not the 500-character preview — and a
      fenced code block in it renders as a scrollable mono block.
- [ ] A cancelled log's completion panel says the call was cancelled rather
      than showing an empty box.
- [ ] `request_params`, `provider_metadata`, and `config_hash` render as a
      key/value grid, with nested objects as formatted JSON and nulls as
      em-dashes. **Nowhere on the page does `[object Object]` appear.**
- [ ] An error log shows `error_type` and `error_message` in a bounded
      scrollable block with a copy action.
- [ ] `cost_usd: null` renders "not priced", not `$0.00`.
- [ ] A log with `conversation_id` shows both the "all logs for this
      conversation" link and the possibly-stale "Open conversation" link.

**Cross-cutting**

- [ ] Both routes render correctly in light and dark themes, with charts
      switching palettes.
- [ ] With OS "reduce motion" on, no chart animates on load and skeletons do
      not shimmer.
- [ ] At 360px, 768px, 1440px, and 2560px there is **no horizontal page
      scroll**; wide tables and charts scroll inside their own containers.
- [ ] `grep -rn "fetch(" frontend/src --include=*.tsx` returns nothing.
- [ ] `grep -rn "bg-\[#\|#[0-9a-fA-F]\{6\}" frontend/src --include=*.tsx`
      returns nothing — every colour comes from the token layer or
      `chartTheme.ts`.
- [ ] `grep -rn "dangerouslySetInnerHTML" frontend/src` returns nothing.
- [ ] `grep -rn "setInterval" frontend/src` returns nothing.
- [ ] `npm run build` succeeds with `tsc` clean under `strict`.
- [ ] Re-running the `dataviz` validator on the categorical palette against
      both surfaces still reports six PASSes.

## Files to be changed

| File | Change | Purpose |
|---|---|---|
| `frontend/package.json` | modify | Add `recharts`. |
| `frontend/src/api.ts` | modify | Add the 007/014 types and `listLogs`, `getLog`, `getLogStats`, `getLogTimeseries`, plus the shared `toParams` helper. Reuses spec 009's `request<T>`, `ApiError`, `Page<T>`. |
| `frontend/src/lib/chartTheme.ts` | **new** | The validated chart palette as theme-aware token references, the mark constants (bar cap, line width, radius, gap), and the recharts axis/grid/tooltip defaults. **The only place chart colours exist.** |
| `frontend/src/lib/format.ts` | modify | Add `formatMs`, `formatTokens`, `formatPercent`, `formatBucketLabel`; extend `formatCost` to take the `Decimal`-as-string form. |
| `frontend/src/hooks/useLogFilters.ts` | **new** | URL-backed filter state: read/write search params, resolve the range to `from`/`to`, derive the bucket (FR10), reset `offset`. |
| `frontend/src/pages/LogsDashboardPage.tsx` | **modify (replaces 009's placeholder)** | Composition: header, filter bar, KPI row, chart grid, table. Owns the four requests and passes data down. |
| `frontend/src/pages/LogDetailPage.tsx` | **modify (replaces 009's placeholder)** | The detail screen (FR36–FR43). |
| `frontend/src/components/logs/FilterBar.tsx` | **new** | Time-range control, four selects, active chips, Clear all, Refresh + last-loaded timestamp. |
| `frontend/src/components/logs/KpiTile.tsx` | **new** | One stat tile: value, unit, label, optional sparkline, optional partial-coverage affordance. |
| `frontend/src/components/logs/LogTable.tsx` | **new** | The paginated row table (FR30–FR35). |
| `frontend/src/components/logs/BreakdownTable.tsx` | **new** | Model / provider / call-type breakdowns with inline proportion bars — the deliberate not-a-donut. |
| `frontend/src/components/logs/TimingStrip.tsx` | **new** | The detail page's signature visualisation (FR37). |
| `frontend/src/components/logs/PromptTranscript.tsx` | **new** | `input_messages` as a transcript, system prompt collapsed (FR38). |
| `frontend/src/components/logs/KeyValueGrid.tsx` | **new** | `request_params` / `provider_metadata` rendering with the JSON fallback (FR40). |
| `frontend/src/components/charts/ChartPanel.tsx` | **new** | The shared panel frame: title, subtitle, legend slot, Table toggle, and the loading / empty / error states that keep the frame's geometry fixed (FR29). |
| `frontend/src/components/charts/CallsByStatusChart.tsx` | **new** | Panel 1. |
| `frontend/src/components/charts/LatencyPercentileChart.tsx` | **new** | Panel 2. |
| `frontend/src/components/charts/ErrorRateChart.tsx` | **new** | Panel 3. |
| `frontend/src/components/charts/TokensChart.tsx` | **new** | Panel 4. |
| `frontend/src/components/charts/CostByModelChart.tsx` | **new** | Panel 5. |
| `frontend/src/components/charts/ChartTooltip.tsx` | **new** | The one themed tooltip used by all five panels (FR23). |
| `frontend/src/components/charts/SeriesTable.tsx` | **new** | FR25's table view, shared by all five panels. |
| `frontend/src/components/shell/ConversationRail.tsx` | modify | Mark the "Inference logs" link active on `/logs*`. |

**Not changed:** anything under `backend/` — spec 014 owns the API. No frontend
test file.

**On the file count.** Five charts, five files: each panel is a distinct data
shape and a distinct set of encoding decisions, and a single `Chart.tsx` with a
`type` prop would be a switch statement over five unrelated configurations.
What *is* shared is factored once: the panel frame, the tooltip, the table
view, and `chartTheme.ts`. **Not created:** a chart factory, a config-driven
`renderChart(spec)` layer, a dashboard-layout JSON, a barrel file, or a
`useChartData` hook per panel.

## Feature-specific rules

### 1. Every number comes from the API

The dashboard computes nothing. No sums, no averages, no percentiles, no
error-rate division, no bucket alignment. Spec 014 exists so that a KPI tile
and the chart beneath it cannot disagree — reintroducing a client-side
calculation reintroduces exactly the drift that split. If a number is wanted
that 014 does not return, change 014.

The one thing the client derives is the **bucket size from the window**
(FR10), and that is a presentation decision about granularity, not an
aggregation.

### 2. The palette was validated, not chosen by eye

The categorical, status, and ordinal palettes above are the output of
`validate_palette.js` run against this app's two real chart surfaces, and the
results are recorded verbatim including the two accepted status deviations.
Slot **order** is part of the result — it is what makes the adjacent-pair CVD
separation pass.

Changing any chart colour means re-running the validator against both surfaces
and updating the recorded results. "It looks fine" is not a check, and the
acceptance criteria include the re-run.

### 3. Colour follows the entity, never its rank

A model's hue derives from a stable ordering of its key, so filtering a series
out does not repaint the survivors. A reader who learned "gpt-5 is blue" must
not find it pink after removing a filter. Past five distinct values the tail
folds into the muted "Other" that spec 014 already returns as `is_other` —
**a hue is never generated or cycled**.

### 4. Status colour and series colour never trade places

The three status colours mean `success` / `cancelled` / `error` and appear only
where status is the dimension. No categorical slot is ever used for a status,
and no status colour ever paints a model or a token type. Every status use
carries an icon and a text label, which is also what mitigates the two recorded
palette deviations.

### 5. Zero, null, and unpriced are three different things

- `0` — it happened and the value was zero.
- `null` / em-dash — there is nothing to compute (no calls; `latency: null`).
- "not priced" / "partial" — the value exists but the data is incomplete
  (`cost_usd: null`, `cost_coverage < 1`).

Rendering any of these as another is the most likely way this dashboard tells a
lie. A `0 ms` p95 for an empty window and a `$0.00` cost for unpriced models
are both prohibited by name (FR15, FR41), and `cost_coverage` must be surfaced
whenever it is below 1.0 (FR14). Spec 014 goes to trouble to keep these
distinguishable; discarding that at the presentation layer wastes it.

### 6. Empty buckets are gaps for rates, zeros for counts

Spec 014 emits every bucket in the window, with `null` percentiles for empty
ones. A rate or percentile line must **break** across an empty bucket; a count
column must render at **zero height**. Plotting `null` as `0` on the latency
line would draw a dive to zero milliseconds — the most misleading thing this
dashboard could show.

### 7. No dual axes, no donuts, no decorative ramps

Named individually because each is a thing an implementer reaches for:

- **Dual axis** — latency and error rate are panels 2 and 3, not one chart with
  two scales. Two scales' alignment is arbitrary and invents correlation.
- **Donut / pie** for the model or status split — a sorted bar table with the
  real numbers answers the question better (FR16 panel 5, `BreakdownTable`).
- **Darker-where-bigger** on nominal categories — double-encodes length as hue
  and burns the only free channel (FR18).
- **Dashed gridlines**, **mark borders**, **a number on every point** — all
  add ink that is not data (FR19, FR21).

### 8. No auto-refresh, and the UI says so

A Grafana-shaped dashboard implies a refresh interval; this one does not have
one, per CLAUDE.md's realtime default. The mitigation is honesty, not
concealment: the last-loaded timestamp sits beside the Refresh control so a
reader always knows how stale the view is. Adding an interval is a spec change.

### 9. Model output is untrusted on this screen too

`input_messages`, `output_text`, `error_message`, and every string in
`provider_metadata` are provider- or user-originated. All render as plain text.
No `dangerouslySetInnerHTML`, and no markdown rendering beyond spec 010's
FR12 fenced-code split.

## Open questions

- **Auto-refresh.** Assumed **not built** (CLAUDE.md's realtime default), with
  a manual Refresh plus a visible last-loaded timestamp. This is the biggest
  deviation from Grafana-like expectations. Confirm before build — if a live
  view is wanted, the acceptable form is an **opt-in, user-visible interval
  control defaulting to off**, not a background timer, and it is a spec change
  here plus a stated exception to CLAUDE.md.
- **Table page size.** Assumed `limit = 25` for the log table (spec 007
  permits up to 100). Confirm.
- **Series cap on charts.** Assumed the top **5** carry categorical hues and
  the rest fold into "Other", against spec 014's cap of 8 named series. The
  mismatch is deliberate — the validated palette has 5 slots and generating a
  6th hue is prohibited — but it means the dashboard discards 3 series the API
  returned. Alternatives: fold 6–8 into "Other" client-side (the assumption),
  or lower 014's cap to 5. Confirm which.
- **Which conversation-scoped view is primary.** Assumed spec 010's link lands
  on the full dashboard with a `conversation_id` filter (FR7). A dedicated
  per-conversation trace view — logs in call order with the turn structure
  visible — is arguably the more useful screen for the debugging flow the
  design doc calls the highest-value query. Confirm whether the filtered
  dashboard is enough for v1.
- **Custom range control.** Assumed two `datetime-local` inputs with
  client-side `from < to` validation, since no date library is being added.
  Confirm this is acceptable versus a built calendar picker.
- **TTFT panel.** Assumed TTFT appears only as a KPI metric showing "—" until
  spec 012 lands, with no chart of its own. Confirm — a sixth panel could be
  added when streaming ships.
