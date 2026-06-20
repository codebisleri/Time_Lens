# Phase F.9 — UX Standardization, Navigation, Input Config & Event Calendar

UI/UX/naming/validation only. No forecasting, scenario, report, or authentication
LOGIC changed. Build: `type-check` ✓ · `lint` ✓ · `build` ✓ (frontend);
`py_compile` ✓ (backend).

## Terminology Standardization Report
| Before | After | Where |
| --- | --- | --- |
| Configuration & Preparation | **Input Configuration** | config card title |
| Data Management | **Input Data & Configuration** | header module + sidebar item |
| SKU Column | **Forecasting Level** | config column mapping |
| Aggregation Grain | *(label removed)* | forecast-level radio |
| Overall Total | **Enterprise Level** | forecast-level option |
| Custom Group Level | **Custom Group** | forecast-level option |
| Cold-Start Threshold | **Cold-Start** | routing thresholds |
| History Starts From / Use Full History | **Start Date** | history window (Part 7) |
| Date format / Forecast frequency / Missing values… | **Title Case** everywhere | all config labels |
| Frequency codes MS/W/QS/D/YS | **Monthly/Weekly/Quarterly/Daily/Yearly** (display; values unchanged) | frequency select |

## UX Standardization Report
- **Login (1.2):** full-screen animated forecasting backdrop (flowing trend lines, confidence band, drifting supply-chain nodes — CSS/SVG, reduced-motion aware, **no forecast numbers**) + a single centered glass card with DhishaAI + Time Lens branding, product title/description, and the form. (`login/page.tsx`, `auth/login-backdrop.tsx`; removed `auth-hero.tsx` which previewed numbers.)
- **Seed users (1.1):** all demo accounts moved `@timelens.com` → `@dhishaai.com`; legacy `@timelens.com` accounts purged on reseed. (`api.py`)
- **Dark-mode dropdowns (3):** `Select` now uses explicit `bg-background`/`text-foreground` + `[&>option]` popover colors → legible in both themes.
- **Data Quality cleanup (10):** removed Missing Values & Outliers KPI cards.

## Navigation Report
- **Overview landing (4):** new `/overview` is the post-login route. Contains "What is Time Lens", the 6-step workflow (linked), a **User Manual** launcher that opens a **separate application window** (`window.open(..., 'popup,…')` → standalone `/user-manual`, not a tab), and a **searchable Terminology glossary** (Forecast Horizon, ADI, CV², WMAPE, MAPE, Intermittent, Lumpy, Enterprise Level, Top-Down, …).
- **Sidebar sub-navigation (9):** each module shows in-page section links under the active item; clicking smooth-scrolls to the section (`scroll-behavior:smooth` + `scroll-mt-24` offset for the 72px header). Sections wired:
  - Data → Upload · Input Configuration · Event Calendar · Data Quality Check
  - EDA → Summary · Distribution · Time Series · Seasonal Decomposition · Correlation
  - Profile & Route → Overview · Segmentation · Routing · Algorithm Portfolio · SKU Profiles
  - Forecast → Configuration · Execution · Results
  - Scenarios → Build Scenario · Impact & Results
  - Report → Summary · Generate Reports

## Input Validation Report
- **Numeric clamping (6):** new `NumberInput` strictly enforces min/max on change AND blur — out-of-range values cannot be entered or submitted. Applied to Forecast Horizon, Cold-Start, Short-History (config), N per Strategy (forecast run), and Scenario Horizon. Helper texts like “(1–36)” removed (validation is implicit).
- **Input Configuration (5/7/8):** Forecasting Level replaces SKU Column and the level option shows the chosen column name dynamically; Segment is optional; Brand/Category/Price mapping inputs removed from the UI; the “What each forecast series represents / one series per SKU” descriptions removed; **Start Date** replaces the Use-Full-History checkbox (empty = full history, a date narrows it); the **Missing & Outlier Handling** section removed (Holiday Country kept).

## Event Calendar Validation Report (Part 11)
On upload, the file is parsed and validated; **invalid files are blocked** (rows are not loaded) and a row-level report is shown. Checks: missing Event Name / Start Date / Event Category / Applies-To, invalid date format, End-before-Start, non-numeric Impact %, invalid Event Category, and duplicate events (same name + start date). Example output: `Row 12: Invalid Date Format`, `Row 28: Event Category missing`, `Row 45: Duplicate Event (also on line 9)`. (`future-events.tsx` — `validateEventRows`.)

## Files Modified
**Backend:** `api.py` (seed emails → dhishaai.com + legacy purge).
**Frontend:**
- Controls/format: `features/data/controls.tsx` (dark-mode Select + `NumberInput`), `lib/utils/format.ts` (carried).
- Input Config: `features/data/data-config-form.tsx` (Parts 2/3/5/6/7/8), `features/data/future-events.tsx` (Part 11), `features/data/data-view.tsx` (anchors + labels), `features/eda/eda-view.tsx` (Part 10 + anchors).
- Forecast/Scenario: `features/forecast-run/{forecast-run-config,forecast-view}.tsx`, `features/scenarios/scenario-view.tsx` (NumberInput + anchors).
- Profile: `features/profile/profile-view.tsx` (anchors).
- Report: `features/report/report-view.tsx` (anchors).
- Login: `app/(auth)/login/page.tsx`, `features/auth/{login-form,login-backdrop}.tsx`; removed `features/auth/auth-hero.tsx`.
- Overview/Manual: `app/(app)/overview/page.tsx`, `features/overview/overview-view.tsx`, `app/user-manual/page.tsx`.
- Nav/header: `lib/constants/{routes,navigation}.ts` (overview route + landing + sub-sections), `components/layout/sidebar/{sidebar-item}.tsx` (submenu), `components/layout/enterprise-header.tsx` (module label).
- Styles: `styles/globals.css` (login animations + smooth scroll).

## Acceptance
✓ Login redesigned · ✓ dhishaai.com users only · ✓ Overview page · ✓ User Manual window · ✓ Terminology glossary · ✓ Input Configuration renamed · ✓ Forecasting Level terminology · ✓ Human-readable frequency · ✓ Dark-mode dropdowns fixed · ✓ Sidebar sub-navigation · ✓ Start Date behavior · ✓ Invalid numeric inputs blocked · ✓ Event Calendar validation · ✓ Data Quality cards cleaned · ✓ No forecasting/scenario/report/auth LOGIC changed.

## Notes
- “Invalid country values” in the Part 11 brief isn’t in the event-calendar schema (the template has no country column); the equivalent **Applies-To** and **Event Category** checks are enforced instead.
- Frequency human labels are display-only; backend codes (MS/W/D/QS/YS) are unchanged everywhere.
