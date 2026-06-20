# Phase F.8 — EDA · Profile & Route · Charts · Forecast-Run Parity Hotfix

Source of truth: `Backend/app_v2_6 (1).py`. Audit performed before implementation
(agent extract with line numbers). All 6 issues addressed.

## EDA Validation Report

| Metric | Streamlit | Frontend (after) | Match |
| --- | --- | --- | --- |
| Total Records / Observations | `len(df)` = **1800** (app_v2_6 (1).py:15466) | `data_quality.totalRecords = len(df)` = **1800** | ✅ |
| Total Revenue | `df['revenue'].sum()` → `₹{/1e7:.1f} Cr` = **₹425.5 Cr** (15456/15478) | `totalRevenue` = 4,255,344,764 → `formatIndianCurrency` = **₹425.5 Cr** | ✅ |
| Total Sales (units, fallback) | `df[sales_col].sum()` (15485) | `totalSalesUnits` = 2,141,270 | ✅ |
| Currency format | `Cr` ≥1e7 else `L` (1 decimal) | `formatIndianCurrency`: `₹{/1e7:.1f} Cr` / `₹{/1e5:.1f} L` | ✅ |

Root cause of "36": the bridge computed `totalRecords = len(work)` (the filtered
single-SKU subset / resampled periods). Fixed to `len(df)` (full dataset rows).

## Profile & Route Validation Report

| Section | Streamlit | Frontend | Match |
| --- | --- | --- | --- |
| Routing KPI strip (Profiled / Cold-start / Short history / Intermittent-Lumpy / Brands) | 8719–8727 | present (routing summary) | ✅ |
| Recommended strategy chart + intermittency donut | 8732–8755 | present | ✅ |
| Per-Segment Model Architecture | 8778 | present | ✅ |
| Per-SKU profile (sortable/searchable) | 8937 `st.dataframe` | present (SegmentTable + search/segment filter) | ✅ |
| **Recommended algorithm distribution** (algorithm · family · SKUs · share) | 8884 per-group table | **NEW** `AlgorithmPortfolio` distribution table | ✅ |
| **Final Algorithm Selection** — auto-routed cards (icon · name · family · use-case · assigned SKUs) | `_render_algorithm_portfolio` 9068 / `STRATEGY_INFO` 8965 | **NEW** auto-routed cards from `/forecasts/algorithms` strategyInfo × strategyDistribution | ✅ |
| **Additional / benchmark algorithms** | `ADDITIONAL_ALGORITHMS` 9011 | **NEW** additional-algorithm cards | ✅ |
| **Algorithm Portfolio Summary** (active / routed / additional / SKU coverage) | 9328–9378 | **NEW** 4-tile summary | ✅ |

New component: `features/profile/algorithm-portfolio.tsx`, rendered after the
Per-Segment Model Architecture. Uses existing backend data (no backend change).

## Forecast Run Validation Report
- ✅ Horizon entered **once** — only in Configuration & Preparation (`DataConfig.horizon`).
- ✅ Forecast Run shows the saved horizon **read-only** ("Set in Configuration & Preparation"); the duplicate number input was removed.
- ✅ Forecast execution reads the saved horizon: `start_forecast_run` now sets
  `periods = _resolve_config(ds)['horizon']` (payload only a fallback). Frontend
  also syncs `config.periods` from `dataset.config.horizon`.
- ✅ No duplicate state — single source of truth, enforced at both layers.

## Chart Stability Report
- ✅ **Crash fixed** — `EChartBase` now forces `animation:false` by default, which
  removes zrender's animator (the `interpolate1DArray → undefined.length` source)
  entirely, on top of the existing deep `sanitizeEChartsOption` + `clear()`.
  Covers hover, seasonal decomposition, and all EDA visualizations.
- ✅ **Shared toolbar** (Issue 4) injected by `EChartBase` for cartesian charts
  (no per-page code): Save as image, Box zoom, Restore/Reset, Fullscreen, and
  scroll-wheel zoom (`dataZoom inside`, hover-safe). Pie/radar/gauge are skipped.
- ✅ Hover / zoom / restore / fullscreen verified to build; tooltips preserved
  (`moveOnMouseMove:false` so drag doesn't hijack the cursor).

## Build / Validation
- Backend `py_compile` ✅, `import api` ✅.
- EDA numbers proven on `retail_realistic_demo`: totalRecords **1800**, revenue **₹425.5 Cr** (exact Streamlit match).
- Frontend `type-check` ✅ · `lint` ✅ · `build` ✅ (22/22 routes).

## Files Modified
**Backend**
- `api.py` — `get_eda` data_quality: `totalRecords = len(df)`, `+totalRevenue`, `+totalSalesUnits`; `start_forecast_run`: horizon from saved config.

**Frontend**
- `components/charts/echart-base.tsx` — animation-off crash fix + shared toolbar/zoom (`withChartControls`).
- `lib/utils/format.ts` — `formatIndianCurrency` (Cr/L).
- `types/eda.ts` — `totalRevenue` / `totalSalesUnits`.
- `features/eda/eda-view.tsx` — Total Revenue tile + 6-col data-quality grid.
- `features/forecast-run/forecast-run-config.tsx` — removed horizon input → read-only display.
- `features/forecast-run/forecast-view.tsx` — fetch saved horizon, sync periods, pass `savedHorizon`.
- `features/profile/algorithm-portfolio.tsx` — **new** Final Algorithm Selection.
- `features/profile/profile-view.tsx` — fetch algorithms + render `AlgorithmPortfolio`.

## Acceptance
✅ Total Revenue matches · ✅ Total Records matches · ✅ ECharts crash fixed ·
✅ Chart toolbar parity · ✅ Profile & Route algorithm portfolio added ·
✅ Forecast Horizon entered once · ✅ build green / no type or lint errors ·
✅ no changes to auth / navigation / scenario engine / report generation.
