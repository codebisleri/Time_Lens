# Dark-Mode Audit Report — Rebrand Phase 3

Re-audit covering the **new Phase 3 surfaces** (enterprise header, restructured
login workspace, Forecast Intelligence Center). Phase 2 fixes (inputs, badges,
empty states, KPI glow/icon chips, table sort affordance, scrollbar) remain in
place — see `../rebrand-phase2/DARK-MODE-AUDIT.md`. **No low-contrast content
remains.**

## New surfaces audited

| Surface | Treatment | Contrast verdict |
| --- | --- | --- |
| Enterprise header | White text / `white/65–90` on deep-navy `.hero-gradient`; badges on `white/10` + colored chips | High contrast ✓ |
| Header env badge | `emerald-100` text on `emerald-400/15` + dot | Readable status ✓ |
| DhishaAI wordmark | Always on a light **brand plate** when on dark chrome | Legible ✓ |
| Login left workspace | White / `white/70–85` on navy gradient; forecast preview panel on `white/[0.06]` glass with `white/15` borders | High contrast ✓ |
| Login forecast preview | Motif at `text-white/70` inside a bordered panel; legend swatches white / brand-accent | Clearly visible ✓ |
| Login right auth card | `bg-card` solid (not translucent); heading `text-foreground`, hint `text-muted-foreground` | High contrast ✓ |
| Login footer status | `text-muted-foreground` with success/icon accents on `bg-background` | Readable ✓ |
| Intelligence status panels | `bg-card` + brand rail; value uses tone color (success/warning/destructive/info), label `text-muted-foreground` uppercase, status chips at `/15` fill + `/25` border | High contrast ✓ |
| Status progress bars | tone bar on `bg-secondary` track | Visible ✓ |

## Guardrails (graphics never overpower content)

- Header motif at `text-white/15`; hero motifs `text-white/20–25`; all
  `pointer-events-none` + `aria-hidden`.
- Every dark hero/header has a left→right gradient scrim so text sits on a solid
  base, never over the motif.
- Login forecast-preview motif is the one intentionally-prominent graphic
  (`/70`) but it sits inside its own bordered panel, not behind text.

## Surfaces re-confirmed (unchanged, still readable)

Headings · body · icons · KPI cards · tables · charts · filters · badges ·
dialogs · drawers · sidebar.

## Verification

`type-check` ✓ · `lint` ✓ · `build` ✓ (22/22). Token/class-only on these
surfaces; no component logic changed.
