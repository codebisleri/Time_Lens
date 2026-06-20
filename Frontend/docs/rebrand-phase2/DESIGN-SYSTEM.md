# DhishaAI · Time Lens — Enterprise Forecasting Design System

**Phase 2 visual identity** — design-only. No forecast calculations, models,
workflow logic, APIs, backend, routing, state, or table/filter behavior were
changed. This document covers deliverables 1–5: the design system, brand color
tokens, typography, the Tailwind theme, and the forecasting graphic asset
library.

---

## 1. Design principles

The platform must read, on first glance, as a **demand-forecasting / supply-chain
planning workbench** — not a generic admin dashboard. Four principles drive that:

1. **Forecasting visual language everywhere.** History → forecast horizon,
   confidence bands, demand signals, planning timelines, and supply networks are
   used as decorative motifs across heroes, the login, KPI surfaces, and chart
   backdrops — not just color.
2. **One token source of truth.** Every color is an HSL CSS variable in
   `src/styles/globals.css`, mapped in `tailwind.config.ts` and read by the
   ECharts theme. Changing a token re-themes the sidebar, headers, KPI cards,
   tables, charts, and badges in lockstep.
3. **Dark-first, fully readable.** The dark theme is the default brand
   experience and every surface must meet enterprise readability (see
   `DARK-MODE-AUDIT.md`).
4. **Executive density.** Tabular numerics, uppercase metric labels, a
   blue→orange "signature" rail, and a consistent elevation scale give an
   exec-grade feel.

---

## 2. Brand color tokens

Source of truth = the DhishaAI logo (`/public/dhishaai-logo.png`) and the Time
Lens logomark (`/public/time-lens-logo.png`).

| Brand color | Hex | HSL (light token) | HSL (dark token) |
| --- | --- | --- | --- |
| **Dhisha Blue** (primary / "Actual") | `#073e5c` | `201 86% 24%` | `201 80% 55%` |
| **Dhisha Orange** (accent / "Forecast") | `#ef7602` | `29 96% 47%` | `29 92% 55%` |
| White | `#ffffff` | `0 0% 100%` | — |
| Analytic tints (charts/motifs) | `#7fc4e8` · `#9fd2ec` · `#cfe7f4` | — | — |

Only these colors (plus neutral blue-grey shades derived from the navy) are
used. No unrelated brand colors are introduced.

### Semantic token map (`globals.css`)

| Token | Role |
| --- | --- |
| `--brand` / `--brand-accent` | Dhisha Blue / Orange anchors |
| `--primary` | Dhisha Blue |
| `--warning` | Dhisha Orange (also the "Review" quality band) |
| `--success` | harmonized teal-green |
| `--info` | mid Dhisha Blue |
| `--sidebar*` | deep-navy planning rail (both themes) |
| `--chart-1 … --chart-8` | series palette (1 = Actual blue, 5 = Forecast orange) |
| `--chart-band` / `--chart-band-forecast` | confidence-band fills (new) |
| `--surface` / `--surface-muted` | elevated planning surfaces (new) |
| `--hero-from / via / to` | forecasting hero gradient stops (new) |
| `--shadow-sm / md / lg` | enterprise elevation scale (new) |

> Quality-band semantics are preserved: green / orange / red still map to
> Good / Review / Poor.

---

## 3. Typography system

| Role | Family | Token | Usage |
| --- | --- | --- | --- |
| UI / body | **Inter** | `--font-sans` | All text; loaded via `next/font` |
| Numerics | Inter + `tabular-nums` | `.nums`, `tabular-nums` | KPI values, tables, metric ribbons |
| Mono | **JetBrains Mono** | `--font-mono` | Code / strftime / IDs |

Type scale & treatments:

| Element | Classes |
| --- | --- |
| Hero title | `text-2xl font-bold tracking-tight` |
| Hero eyebrow | `text-xs font-semibold uppercase tracking-[0.14em]` |
| Page title | `text-xl font-semibold tracking-tight` |
| Section heading | `text-base font-semibold tracking-tight` |
| KPI value | `text-3xl font-semibold tracking-tight tabular-nums` |
| KPI / metric label | `text-[11px] font-medium uppercase tracking-wider` |
| Table header | `text-[11px] font-semibold uppercase tracking-wider` |

---

## 4. Tailwind theme additions

`tailwind.config.ts` remains fully token-driven. Added:

- `surface` color (`DEFAULT`, `muted`) mapping to `--surface*`.
- (Existing) `brand`, `info`, `sidebar`, `chart.1–8` mappings retained.

New reusable classes (`globals.css`):

| Class | Purpose |
| --- | --- |
| `.hero-gradient` | deep-navy → blue forecasting hero gradient |
| `.brand-rail` | blue→orange signature stripe (KPI top rails, headers) |
| `.surface-elevated` | premium card elevation (`--shadow-md`) |
| `.bg-analytics-grid` | subtle analytical grid backdrop |
| `.text-gradient-brand` | blue→orange text clip for hero accents |
| `.nums` | tabular figures |

---

## 5. Forecasting graphic asset library

Vector, low-opacity, decorative-only motifs (no stock art, no marketing
imagery). See `/public/branding/README.md` for the full catalog.

**Static assets** — `/public/branding/`:
`forecast-horizon.svg`, `confidence-band.svg`, `demand-curve.svg`,
`analytics-grid.svg`, `planning-timeline.svg`, `supply-network.svg`,
`demand-signal.svg`.

**Theme-aware component** — `src/components/common/forecast-graphics.tsx`:
`<ForecastMotif variant="horizon|band|signal|grid|timeline|network|curve" />`.
Inlines the same motifs, inheriting `currentColor` (primary strokes) and
`hsl(var(--brand-accent))` (forecast accent), so they adapt to any surface.
Always `aria-hidden` + `pointer-events-none`.

### Where motifs are used

| Surface | Motif |
| --- | --- |
| Data hero | `signal` |
| EDA hero | `curve` |
| Profile & Route hero | `network` |
| Forecast hero | `horizon` |
| Submission hero | `timeline` |
| Performance hero | `grid` |
| Report hero | `band` |
| Scenarios hero | `network` |
| Login left panel | `horizon` |

---

## 6. Component patterns

- **`WorkflowHero`** (`features/workflow/workflow-hero.tsx`) — the forecasting
  hero: navy→blue gradient, motif backdrop, stage icon chip, eyebrow/title/
  subtitle, optional KPI ribbon (`metrics`) and status pills (`HeroStatusPill`).
  Backward-compatible with the original `{step,title,subtitle}` API.
- **KPI cards** — `StatTile`, `KpiCard`, `ForecastKpiCard`, `SkuKpiCard`,
  Performance `Tile`, and the Data/EDA tiles all share: blue→orange top rail,
  `bg-primary/10` icon chip, uppercase label, `text-3xl tabular-nums` value,
  lift-on-hover elevation.
- **DataTable** — solid sticky header with depth, always-visible sort affordance
  (`↕` → `▲/▼` in brand-accent), crisp row hover. Behavior unchanged.
- **Sidebar** — Time Lens mark on a white brand plate + "Forecasting Workspace"
  label, blue→orange hairline, grouped nav with orange active indicator,
  "Powered by DhishaAI" footer.
- **Brand plate** — `<DhishaaiWordmark plate />` renders the navy wordmark on a
  light plate so it stays legible on dark surfaces (see `LOGO-VERIFICATION.md`).
