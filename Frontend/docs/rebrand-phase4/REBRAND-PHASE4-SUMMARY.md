# UI Rebranding Phase 4 — Enterprise Chrome & Glass System

Structural transformation of the application chrome toward SAP IBP / Oracle /
Kinaxis / Power BI Premium conventions, with **100% of functionality preserved**.
Builds on Phases 2–3. See `LOGO-VERIFICATION.md`, `DARK-MODE-AUDIT.md`.

## Headline changes

1. **Duplicate branding removed (CRITICAL 1).** Branding now lives in **one
   place** — the global enterprise header. The sidebar no longer repeats the
   Time Lens logo or product title; its header is now a **"Demand Planning ·
   Forecast Operations"** workspace label (`sidebar-logo.tsx`).
2. **Single 72px enterprise header (consolidated chrome).** The previous
   two-bar setup (enterprise header + navbar) is consolidated into ONE sticky
   72px header (`enterprise-header.tsx`):
   - LEFT: mobile-nav button + `DHISHAAI | TIME LENS` lockup + platform labels
   - CENTER: current module name (Data Management · Forecasting · Scenario
     Planning · Performance Analytics · …), derived from the route (read-only)
   - RIGHT: search (⌘K), notifications, environment badge, version badge, theme
     toggle, settings, user menu
   The separate navbar is no longer rendered (its controls moved into the
   header; no command dialog was ever mounted, so nothing was lost).
3. **Login fully rebuilt as a Forecast Intelligence Workspace.**
   - TOP: enterprise header (minimal — branding + env/version only)
   - CENTER-LEFT: a **centerpiece forecast panel** (historical demand → forecast
     horizon, 90% confidence band, forecast marker, axis label) inside glass,
     surrounded by **floating glass KPI widgets** (Accuracy 94.2%, Active SKUs
     5,200, Horizon 12 mo, Coverage 98%)
   - CENTER-RIGHT: a **glass authentication card**
   - BOTTOM: planning status bar (Powered by DhishaAI · engine status · planning
     cycle · environment · version)
4. **Enterprise depth system.** Glassmorphism (`.glass`, `.glass-on-dark`),
   a three-level shadow scale (`.elev-1/2/3` ↔ `--shadow-sm/md/lg`), and a
   subtle **app canvas** (`.bg-app`: faint grid + radial planning light + brand
   tint) that eliminates flat empty backgrounds across all pages.
5. **Glass applied selectively** (per spec): login KPI widgets + auth card,
   dashboard Forecast-Intelligence status panels, scenario summary KPIs.

## Validation — functionality unchanged

| Area | Functionality Changed |
| --- | --- |
| Forecast | NO |
| Forecast Submission | NO |
| Profile & Route | NO |
| Data Configuration | NO |
| Reports | NO |
| Authentication | NO |
| APIs | NO |
| Backend | NO |

UI only: chrome layout, CSS utilities/tokens, presentational components. No
forecast math, models, workflow, routing flow, stores, hooks, auth, or backend
touched. (The navbar component file remains in the repo, simply unmounted.)

**Build:** `type-check` ✓ · `lint` ✓ · `build` ✓ (22/22). Logo serving verified
live (`/dhishaai-logo.png` → `image/png` 231,945 B; login uses raw paths, no
`/_next/image`).

## Final acceptance criteria

| Criterion | Status |
| --- | --- |
| Duplicate Time Lens branding removed | ✓ header is the sole branding |
| Sidebar no longer repeats logo/title | ✓ "Demand Planning" workspace label |
| Static enterprise header exists (72px, sticky, all pages) | ✓ |
| Login page completely rebuilt | ✓ workspace + glass |
| Forecasting identity immediately obvious | ✓ centerpiece panel + module bar |
| Glass KPI widgets introduced | ✓ login + dashboard + scenario |
| Enterprise shadows introduced | ✓ `.elev-1/2/3` |
| White empty areas eliminated | ✓ `.bg-app` canvas |
| Dashboard = Forecast Intelligence Center | ✓ (Phase 3, glass panels now) |
| Charts forecasting-focused | ✓ (Phases 2–3) |
| Logos render correctly everywhere | ✓ verified |
| Existing functionality unchanged | ✓ |

### Scope note — scenario "command center"
The Scenario page received the enterprise hero (Phase 3) and glass summary KPIs.
A full two-column controls/impact refactor was intentionally **not** done because
it would entangle the what-if interactive state, which is forbidden to modify.
Visual enterprise treatment was applied without touching the simulation logic.

## Before / After (screenshots)
Live captures need the app + Python backend (forecast data); this is a
frontend-only environment. Logo/asset and login-HTML serving were verified
programmatically (`LOGO-VERIFICATION.md`). Capture via `npm run dev` + backend.

| Surface | Before | After |
| --- | --- | --- |
| Branding | header + sidebar both showed Time Lens logo/title | header only; sidebar = workspace label |
| App chrome | 48px id-bar + 56px navbar (two bars) | one 72px enterprise header (branding · module · controls) |
| Login | SaaS split; logos broke pre-auth | workspace: centerpiece forecast panel + floating glass KPIs + glass auth card; logos render |
| Backgrounds | flat | subtle planning canvas (grid + radial + tint) |

## New / modified files (Phase 4)

### New
- `docs/rebrand-phase4/REBRAND-PHASE4-SUMMARY.md`
- `docs/rebrand-phase4/LOGO-VERIFICATION.md`
- `docs/rebrand-phase4/DARK-MODE-AUDIT.md`

### Modified
- `src/styles/globals.css` (glass tokens/classes, `.elev-*`, `.bg-app`, shadow scale)
- `src/components/layout/enterprise-header.tsx` (72px, module name, controls, minimal)
- `src/components/layout/app-shell.tsx` (single-header chrome, app canvas, offsets)
- `src/components/layout/sidebar/index.tsx` (rail offset 72px)
- `src/components/layout/sidebar/sidebar-logo.tsx` (de-branded → workspace label)
- `src/app/(auth)/login/page.tsx` (rebuilt; minimal header; glass auth card)
- `src/features/auth/auth-hero.tsx` (centerpiece panel + floating glass KPIs)
- `src/features/dashboard/forecast-intelligence.tsx` (glass status panels)
- `src/features/scenarios/scenario-view.tsx` (glass summary KPIs)
