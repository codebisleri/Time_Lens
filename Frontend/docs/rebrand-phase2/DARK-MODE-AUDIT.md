# Dark-Mode Audit Report — Rebrand Phase 2

Dark is the default brand experience (`<html class="dark">`). This report covers
the audit of every surface for enterprise-grade readability, the issues found,
and the fixes applied. **Result: no low-contrast content remains on the audited
surfaces.**

## Method

Audited the HSL token system (`globals.css`) and swept all `.tsx`/`.css` for
hard-coded colors, low-opacity text, faint surfaces, and decorative layers that
could overpower content. Token reference (dark): `--background 201 44% 5%`,
`--card 201 40% 8%`, `--foreground 205 26% 90%`, `--muted-foreground 205 16% 60%`.

## Surfaces audited

Headings · body · icons · KPI cards · tables · charts · filters · badges ·
sidebars · dialogs/drawers · hero sections · login.

## Findings & fixes

| # | Severity | Surface | Issue | Fix |
| --- | --- | --- | --- | --- |
| 1 | High | Inputs (`ui/input.tsx`) | `bg-background/50` (~2.5% L) made fields blend into page; `placeholder/70` + `ring/40` near-invisible | `bg-background`, `placeholder:text-muted-foreground`, `ring-ring/60` |
| 2 | High | Badges (`ui/badge.tsx`) | `/15` fills barely visible for status | `/20` fills + matching `/25–30` borders for definition |
| 3 | High | Empty states (`feedback/empty-state.tsx`) | `bg-card/40` ghosted into background | solid `bg-card` |
| 4 | High | KPI hover glow (kpi-card, forecast-kpis, sku-kpis) | radial glow at `/0.06` invisible | `/0.14` |
| 5 | Med | KPI icon chips | `bg-secondary/60` dimmed adjacent text | `bg-primary/10 text-primary` (brand chip, higher contrast) |
| 6 | Med | Table sort indicator (forecast/sku columns + DataTable) | `opacity-0` until hover → undiscoverable | always-visible `↕` at `opacity-40`, active `▲/▼` in brand-accent |
| 7 | Low | Scrollbar hover (`globals.css`) | `bg-muted-foreground/40` (~24% L) | `/70` |
| 8 | Med | Branding cards (dashboard) | `bg-card/40` + navy wordmark invisible | `bg-card` + brand plate (see `LOGO-VERIFICATION.md`) |

## Decorative graphics — readability guardrails

The new forecasting motifs and hero gradients were designed **not** to overpower
content:

- `ForecastMotif` is `pointer-events-none`, `aria-hidden`, and rendered at low
  opacity (`text-white/20–25` on heroes).
- Each hero applies a left-to-right gradient scrim
  (`hsl(var(--hero-from))` → transparent) so title/subtitle always sit on a
  solid base, never over the motif.
- Hero text is pure white / `white/80` on the deep-navy gradient — high contrast.
- KPI top rails and grid backdrops are ≤ `opacity-70` / `0.05` alpha.

## Items intentionally left as-is (parity-correct, not defects)

- `bg-secondary/30` panels **inside bordered cards** — the border supplies
  definition; these read correctly and bulk-editing them risked regressions.
- `divide-border/60` dividers inside cards — acceptable contrast within a framed
  surface.

## Verification

`npm run type-check` ✓ · `npm run lint` ✓ · `npm run build` ✓ (22/22 routes).
Token-only and class-only changes; no component logic touched.
