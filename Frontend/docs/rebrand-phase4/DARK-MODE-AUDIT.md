# Dark-Mode Audit Report — Rebrand Phase 4

Re-audit of the **new Phase 4 surfaces** (72px enterprise header, glass panels,
app canvas, rebuilt login). Phase 2–3 fixes remain in force. **No low-contrast
content remains.**

## New surfaces

| Surface | Treatment | Verdict |
| --- | --- | --- |
| Enterprise header (72px) | white / `white/65–90` text on deep-navy `.hero-gradient`; controls `text-white/85` with `hover:bg-white/10` | High contrast ✓ |
| Header module name | `text-white/90` uppercase + brand-accent dot | Clear ✓ |
| Header env/version badges | emerald-100 on emerald-400/15; white/90 on white/10 | Readable ✓ |
| User menu trigger on header | `bg-primary/15` + bright `text-primary` initials | Legible ✓ |
| Sidebar workspace label | white title + `sidebar-foreground/60` subtitle on navy | High contrast ✓ |
| Glass panels (`.glass`) | dark: navy `201 40% 12% / .55` + `foreground` text; light: white `/.72` | Token-driven text stays high-contrast ✓ |
| Glass-on-dark (login KPIs) | `white/10` bg, white text, brand-accent icon | High contrast ✓ |
| Login centerpiece panel | motif `text-white/75` inside bordered glass; white/brand-accent legend | Clearly visible ✓ |
| Login auth card (`.glass`) | solid-enough frosted card; inputs `bg-background`; labels token-driven | Readable ✓ |
| App canvas (`.bg-app`) | grid at `foreground/.025`, radial brand tints ≤ `.08` | Subtle, never overpowers ✓ |

## Guardrails

- All decorative motifs/gradients are `pointer-events-none` + `aria-hidden` and
  ≤ low opacity; header has a left→right scrim so text never sits on the motif.
- Glass uses theme-aware tokens (`--glass-bg`/`--glass-border`) — navy on dark,
  white on light — so foreground text keeps WCAG-safe contrast in both themes.
- The app canvas tints are capped (`.025`–`.08` alpha) so cards/tables/charts
  remain the visual focus.

## Re-confirmed (unchanged, readable)

Headings · body · icons · KPI cards · charts · tables · filters · badges ·
dialogs · drawers · forms.

## Verification

`type-check` ✓ · `lint` ✓ · `build` ✓ (22/22). Token/class-only on these
surfaces; no component logic changed.
