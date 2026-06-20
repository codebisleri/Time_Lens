# DhishaAI / Time Lens — Forecasting Graphic Asset Library

Lightweight, enterprise-grade SVG motifs that give the platform a
demand-forecasting visual identity. All assets are vector, low-opacity, and
**decorative only** — no stock illustration, no marketing artwork.

Palette (logo-derived): Dhisha Blue `#073e5c`, Dhisha Orange `#ef7602`, with
light analytic tints (`#7fc4e8`, `#9fd2ec`, `#cfe7f4`).

| File | Motif | Intended use |
| --- | --- | --- |
| `forecast-horizon.svg` | Actual history → forecast horizon with a "now" divider and confidence band | Hero backdrops, login |
| `confidence-band.svg` | Median forecast with widening P10–P90 interval | Forecast / performance heroes |
| `demand-curve.svg` | Layered seasonal demand curves + area fill | Dashboard / EDA backdrops |
| `analytics-grid.svg` | Analytical grid with plotted markers + trend line | Planning workbench backdrops |
| `planning-timeline.svg` | History → "now" → forecast milestones | Submission / report heroes |
| `supply-network.svg` | Distribution nodes linked by demand-flow edges | Profile & route, scenarios |
| `demand-signal.svg` | Demand-signal bars + overlaid forecast trend | KPI ribbons, data-flow accents |

## Two ways to use them

1. **Static (theme-fixed)** — reference the `.svg` directly (`<img>`, `next/image`,
   or CSS `background-image`). These are tuned for the navy/blue hero gradient
   (light strokes + orange forecast accent).
2. **Theme-aware (recommended in-app)** — use the React component
   `src/components/common/forecast-graphics.tsx` → `<ForecastMotif variant="…" />`.
   It inlines the same motifs but inherits `currentColor` for the primary strokes
   and `hsl(var(--brand-accent))` for the forecast accent, so it adapts to light
   and dark surfaces. Always `aria-hidden` + `pointer-events-none`.

```tsx
<div className="relative overflow-hidden">
  <ForecastMotif variant="horizon" className="absolute inset-0 text-white/25" />
  <div className="relative">…content…</div>
</div>
```
