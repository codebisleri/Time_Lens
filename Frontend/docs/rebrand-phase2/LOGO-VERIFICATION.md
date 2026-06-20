# Logo Verification Report — Rebrand Phase 2

Audit of every logo reference, the rendering issues found, and the fixes that
ensure both logos render correctly everywhere, including dark mode.

## Assets (single source of truth)

| Asset | File | Intrinsic | Character |
| --- | --- | --- | --- |
| Time Lens logomark | `/public/time-lens-logo.png` (+ `Time Lens Logo.png`) | 865×772 | Multi-color (blue/orange/silver clock + chart) — visible on most backgrounds |
| DhishaAI wordmark | `/public/dhishaai-logo.png` (+ `Dhishaai Logo.png`) | 9400×3000 | **Deep-navy glyphs** + orange — *loses contrast on dark surfaces* |

Rendered through `src/components/common/brand.tsx`
(`TimeLensLogo`, `DhishaaiWordmark`) via `next/image` with intrinsic
`width`/`height` and `h-* w-auto` (aspect ratio preserved — correct).

## Root issue found

The DhishaAI wordmark's navy glyphs disappear on dark surfaces (dark-theme
background `201 44% 5%`, dark card `201 40% 8%`, deep-navy sidebar). Previously
it was placed raw on `bg-card/40` (dashboard), `bg-sidebar` (auth hero footer),
and `bg-background` (login, dark default) — all low-contrast.

## Fix: brand plate

`DhishaaiWordmark` gained a `plate` prop that renders the wordmark on a light
rounded plate (`bg-white` + ring + shadow) so it stays crisp on **any**
background. The Time Lens mark is likewise seated on a white chip where it sits
on deep navy (sidebar, login, dashboard, auth hero).

## Location-by-location verification

| Location | File | Logo | Status after fix |
| --- | --- | --- | --- |
| Login — brand lockup | `app/(auth)/login/page.tsx` | DhishaAI wordmark + Time Lens mark | ✓ wordmark `plate`; mark on white chip |
| Login — left hero | `features/auth/auth-hero.tsx` | Time Lens mark (header), DhishaAI (footer) | ✓ mark on white chip; wordmark `plate` |
| Sidebar header | `components/layout/sidebar/sidebar-logo.tsx` | Time Lens mark | ✓ on white brand plate + "Forecasting Workspace" |
| Sidebar footer | `components/layout/sidebar/sidebar-footer.tsx` | "Powered by DhishaAI" | ✓ light text (no dark glyph on navy) |
| Dashboard/Overview header | `features/dashboard/dashboard-view.tsx` | Time Lens mark + DhishaAI wordmark | ✓ mark on white chip; wordmark `plate`; card now solid `bg-card` |
| Forecasting page heroes (data/eda/profile/forecast/submission/performance/report/scenarios) | respective `*-view.tsx` | stage icon + forecasting motif (no raw logo on dark) | ✓ brand expressed via icon chip + motif, no contrast risk |
| Exports / reports | (HTML export generation is backend-owned, out of scope) | — | unchanged (not modified per scope) |

## Dark-mode visibility check

- Time Lens mark: multi-color; additionally seated on a white chip on all
  deep-navy placements → always visible.
- DhishaAI wordmark: only ever rendered with `plate` on dark/unknown surfaces →
  always visible.
- No logo is rendered as raw navy-on-navy anywhere.

## Notes

- Space-named duplicates (`Time Lens Logo.png`, `Dhishaai Logo.png`) exist in
  `/public` alongside the hyphenated files that the app references; harmless.
- No CSS `background-image`/`url()` logo references exist — all go through
  `next/image`, so optimization and crispness are consistent.
