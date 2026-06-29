# Time Lens — Causal Analysis & What-If Module
## Architecture & Implementation Blueprint

**Author role:** Senior Retail Forecasting Architect / Full-Stack Technical Lead
**Scope:** Causal Effect Analysis + Planner-driven What-If, grounded in the *actual* current codebase
**Guiding constraint:** Do **not** modify forecasting logic. Reuse existing forecast outputs. Minimal disruption.

---

## 0. Executive Summary — Read This First

A working Causal + What-If + Explainability stack **already exists** in Time Lens (Phases Y.A/Y.B, X.U–X.ZZ.2). This document is therefore split into:

1. **Part 1 — System map** (what is actually there today)
2. **Gap analysis** (what your Part 2–6 vision asks for that is *not* yet built)
3. **Delta design** (the genuinely-new pieces, designed to bolt onto the existing architecture)
4. **Roadmap & effort** for the delta only

### What already exists (do not rebuild)

| Capability | Status | Where |
|---|---|---|
| Causal effect estimation (DoWhy backdoor + refutation) | ✅ Live | `Backend/scenario_engine.py`, `/scenarios/causal/run` |
| Driver ranking ("which levers matter most") | ✅ Live | `rank_drivers()`, `/scenarios/causal/drivers` |
| Elasticity (% per +1%) | ✅ Live | `causal_interpretation()` |
| Causal DAG visualization | ✅ Live | `/scenarios/causal/graph`, `causal-graph.tsx` |
| What-if re-adjustment (sensitivity / causal ATE) | ✅ Live | `/scenarios/run`, `_whatif_worker` |
| Baseline-vs-scenario chart + waterfall | ✅ Live | `scenario-view.tsx` |
| Save / list / delete scenarios | ✅ Live | `/scenarios/save`, `scenarios` table |
| Explainability decomposition (trend/seasonality/holiday/exog/residual) | ✅ Live | `/explainability/local`, `/horizon` |
| Driver contribution %, feature contribution waterfall, horizon stack | ✅ Live | `explainability-charts.tsx` |

### What is genuinely missing (the delta this doc designs)

| Gap | Priority | Effort |
|---|---|---|
| **G1 — SHAP feature importance** (you asked to evaluate it; not implemented) | High | M |
| **G2 — Revenue impact** (what-if returns *units* only; no price×demand → revenue) | High | S |
| **G3 — Scenario Comparison page** (route + store exist, view not built) | High | M |
| **G4 — Scenario versioning** (`scenarios` table has no version lineage) | Medium | S |
| **G5 — Multi-lever what-if as a saved "plan"** (currently single ad-hoc run) | Medium | M |
| **G6 — Promotion/Discount/Holiday as first-class typed levers** (today generic exog) | Medium | S |
| **G7 — Optional "true re-forecast" what-if path** (today closed-form only) | Low | L |

**Effort legend:** S ≈ 1–2 dev-days, M ≈ 3–5 dev-days, L ≈ 1.5–2.5 dev-weeks.

---

# PART 1 — Current System (Factual Map)

### 1.1 Forecast generation flow

```
POST /forecasts/run  (api.py:2690 start_forecast_run)
        │  spawns async thread, returns job handle immediately
        ▼
_forecast_worker (api.py:2320)
   ├─ load dataset, history window, outlier treatment, level aggregation
   ├─ (optional) train global LightGBM
   ├─ ThreadPoolExecutor → forecast_one_sku() per entity   (app_v2_6.py:4756)
   │     Stage 1  pick_champion_by_holdout()   (leakage-shielded WMAPE)
   │     Stage 1b fine_tune_winner()
   │     Stage 1c build_weighted_blend()
   │     Stage 2  conditional_xgb_residual_correction()  (gated ≥ threshold)
   │     Stage 3  apply_business_rules()  (MoM / YoY clip)
   ├─ top-down routing / brand reconciliation (optional)
   └─ persist → forecasts (one row/entity) + forecast_runs
```

**Models:** SARIMAX(+promo), Prophet, Holt-Winters, AutoARIMA, Theta, CatBoost, XGBoost-Q90, Global LightGBM, Croston/SBA, MoE, Chronos (cold-start). Champion = lowest holdout **WMAPE** with a 2% tie-band that favors the segment recipe.

### 1.2 Forecast output structure (`ForecastResult`, `app_v2_6.py:3847`)

Persisted into `forecasts.detail_json` via `build_forecast_detail()` (`api.py:1471`). Key fields the new module **reuses** (never recomputes):

- `series[]` — `{date, actual | forecast, lowerBound, upperBound}` (P10/P50/P90 band)
- `fit[]`, `testPred[]`, `testActual[]` — in-sample & holdout overlays
- `allModels[]` — per-candidate WMAPE competition (`isChampion` flag)
- `metrics` — `{mape, smape, bias, accuracy}`
- `strategyUsed`, `notes` (full pipeline trace)

### 1.3 Database (SQLite, `api_bridge.db`)

| Table | Role |
|---|---|
| `datasets` | dataset metadata + column mapping (sku/date/sales/price/category cols) |
| `forecast_runs` | one row/run, `config_json` |
| `forecasts` | one row/entity, **`detail_json`** ← single source for all explainability/what-if |
| `forecast_jobs` | async job registry (survives hot-reload) |
| `scenarios` | `id, dataset_id, owner, name, sku, adjustments_json, result_json, created_at` |
| `submission_rows`, `submission_batches`, `reports` | downstream planning |

### 1.4 Existing scenario / causal / explainability APIs

| Endpoint | Method | Purpose |
|---|---|---|
| `/scenarios/run` | POST | What-if (closed-form sensitivity **or** causal ATE), no re-fit |
| `/scenarios/save` `/scenarios` `/scenarios/{id}` | POST/GET/DELETE | persistence |
| `/scenarios/causal/features` | GET | candidate levers + DoWhy availability |
| `/scenarios/causal/run` | POST | DoWhy effect estimation + refutation + elasticity |
| `/scenarios/causal/drivers` | POST | rank all levers by \|effect\| |
| `/scenarios/causal/graph` | POST | DAG structure (works w/o DoWhy) |
| `/explainability/local/{level}` | GET | normalized driver contribution + waterfall |
| `/explainability/horizon/{level}` | GET | per-period driver stack |

All long-running ops are **async job + poll** (`/forecasts/jobs/{id}`).

**Critical design fact:** What-if **does not re-run the engine.** `_stored_baseline_series` reads the persisted forecast, then `_scenario_feature_sensitivity` (Pearson r + historical mean) or a supplied causal ATE adjusts it. This is the *correct* choice for the "reuse outputs / minimal disruption" mandate and we preserve it.

### 1.5 Frontend state, routes, charts

- **Stores:** `scenario-planning-store` (mode whatif/causal, treatments, confounders, methods, refuters), `scenario-store` (draft), `explainability-filter-store`, `forecast-level-store`, `comparison-store` (selectedScenarioIds, baseline, metric).
- **Routes:** `/scenarios`, `/scenarios/new`, `/scenarios/{id}`, **`/scenarios/compare`** (route reserved, view not built), `/explainability`.
- **Charts (ECharts via `EChartBase`):** forecast trend+band, contribution bars, **waterfall**, horizon-stacked, causal-effects bar, drivers bar, WMAPE bars, heatmap, boxplot. Strict **navy `#071B34` + orange `#EF7602`** palette; `animation:false`, emphasis disabled, theme read from CSS vars.
- **API client:** `LIVE_API_PREFIXES` routes `/scenarios`, `/explainability` to the real backend; everything wrapped in `whatifService` / `explainabilityService`.

---

# PART 2 — Causal Effect Analysis

### 2.1 What it must answer (your spec) vs. what exists

| Required driver | Covered today? |
|---|---|
| Price changes | ✅ (price-like elasticity, `_PRICE_LIKE_TREATMENTS`) |
| Promotions / Discounts | ✅ as generic exog → **G6**: promote to typed levers |
| Holidays / Seasonality | ✅ (explainability decomposition) |
| External variables / user regressors | ✅ (`exog_user_numeric`, auto-detected) |

### 2.2 Approach evaluation & recommendation

| Approach | Strengths | Weaknesses | Fit for Time Lens |
|---|---|---|---|
| **Linear Regression (DoWhy backdoor)** | Causal (confounder control), interpretable coefficient = ATE, refutable | Linear, misses interactions | ✅ **Already in place** — keep as the *causal truth* layer |
| **XGBoost feature importance** | Nonlinear, cheap, model-native | Gain/split importance is biased & non-directional, not causal | Partial — use only as a sanity cross-check |
| **SHAP values** | Nonlinear + **directional + per-feature additive contribution**, ranks *and* signs drivers, handles interactions | Compute cost; correlational not causal | ✅ **Recommended addition (G1)** — explains the actual champion model |
| **Prophet regressors** | Native to Prophet champions | Only valid when champion *is* Prophet | Niche — skip as a standalone path |

**Recommendation — a 3-lens model, complementary not competing:**

1. **Causal lens (exists):** DoWhy backdoor linear regression + refutation → *defensible ATE & elasticity* for the handful of decision levers (price, promo, discount). This is what a planner cites in a business case.
2. **Importance lens (add — G1):** **SHAP** on the *already-trained* LightGBM/XGBoost (global model or per-entity tree) → ranked, signed, nonlinear feature contributions across *all* regressors. This is the "what the model actually learned" view.
3. **Decomposition lens (exists):** correlation/STL decomposition in `/explainability/*` → cheap, always-available fallback (trend/seasonality/holiday/exog/residual %).

Why SHAP over plain XGBoost importance: SHAP gives **direction + magnitude + local (per-period) attribution** with a single additive framework that maps cleanly onto the existing **waterfall** chart — zero new chart types needed.

### 2.3 Outputs (all already shaped, SHAP adds one)

- Driver contribution % — ✅ `/explainability/local`
- Positive/negative impacts — ✅ (signed effects, green/red bars)
- Feature importance ranking — ✅ `/scenarios/causal/drivers` (linear) + **SHAP ranking (G1)**
- Explainable demand drivers — ✅ interpretation strings + reliability badges

### 2.4 Backend changes for SHAP (G1) — additive, no engine change

**Data model:** none required for compute-on-demand. Optional cache table (see Part 5, `causal_results`).

**New endpoint:**

```
POST /explainability/shap/{forecast_level}
```

Request:
```json
{ "datasetId": "ds_123", "topN": 12 }
```

Response:
```json
{
  "available": true,
  "entity": "BrandA::Region1",
  "model": "global_lgbm",
  "baseValue": 1840.0,
  "features": [
    { "feature": "price", "label": "Price", "shap": -212.4, "direction": "down", "meanAbs": 212.4 },
    { "feature": "evt_diwali", "label": "Diwali", "shap": 168.9, "direction": "up", "meanAbs": 168.9 }
  ],
  "waterfall": [
    { "label": "Base demand", "value": 1840.0, "type": "base" },
    { "label": "Price", "value": -212.4, "type": "delta" },
    { "label": "Diwali", "value": 168.9, "type": "delta" },
    { "label": "Predicted", "value": 1796.5, "type": "total" }
  ]
}
```

**Pipeline:** reuse `_scenario_causal_features` (already builds the engineered+exog panel, period-aligned). Fit a lightweight `LGBMRegressor` on that panel (or reuse the persisted global model if available), then `shap.TreeExplainer`. Cache by `(dataset_id, entity, dataset_mtime)`. Defensive → `{available:false}` if `shap`/model unavailable (mirrors the DoWhy graceful-degradation pattern).

**Dependency:** add `shap>=0.44` to `Backend/requirements.txt`.

### 2.5 Frontend for SHAP

Reuse `WaterfallChart` + `ContributionBars` (already lazy-loaded in `explainability-view.tsx`). Add a **"Model Drivers (SHAP)"** sub-section under the existing explainability "Model-Specific Explanation" block. New service method `explainabilityService.shap(level)`. No new chart components.

---

# PART 3 — What-If Analysis

### 3.1 Current capability (validated)

`/scenarios/run` already: recalculates (closed-form), compares to baseline, returns `series[]` (baseline vs scenario), `waterfall[]`, `deltaUnits`, `changePct`. Levers: any numeric exog (price/promo/discount/external) via three change types (`Percentage Change`, `Constant Change`, `Set to New Value`), optional date window, optional causal ATE.

### 3.2 Gaps to close

**G2 — Revenue & demand impact.** Today the result is unit-only. Retail planners need revenue. Add price-aware revenue math **in the existing `_whatif_worker`** (no new endpoint):

- Pull baseline unit price from dataset `price_col` (last known) or scenario "Set price" lever.
- `baselineRevenue = Σ baseline_units × price_t`
- `scenarioRevenue = Σ scenario_units × scenario_price_t` (price lever feeds both demand effect *and* revenue)
- Return `revenueDelta`, `revenueChangePct` alongside existing unit fields.

Extended `result` (additive fields, backward compatible):
```json
{
  "baselineTotal": 22030, "scenarioTotal": 24180,
  "deltaUnits": 2150, "changePct": 9.76,
  "baselineRevenue": 2643600, "scenarioRevenue": 2756520,
  "revenueDelta": 112920, "revenueChangePct": 4.27,
  "series": [ { "date": "2026-01", "baseline": 1820, "scenario": 1998,
               "baselineRevenue": 218400, "scenarioRevenue": 219780 } ]
}
```

**G6 — Typed levers.** Introduce a lever-type registry so Price/Promotion/Discount/Holiday/Growth/External render with the right control + units, instead of a generic numeric. Backend `_scenario_exog_features` already labels columns via `_EXOG_KEYWORDS` — expose that `kind` to the client:

```json
{ "availableFeatures": [
  { "feature": "price", "label": "Price", "kind": "price", "unit": "₹", "level": 142.0 },
  { "feature": "promo_flag", "label": "Promotion", "kind": "promo", "unit": "on/off", "level": 0 },
  { "feature": "discount_pct", "label": "Discount", "kind": "discount", "unit": "%", "level": 0 }
] }
```

**G5 — Multi-lever saved "Plan".** Today a scenario is one ad-hoc run. Promote it to a first-class **versioned plan** (see G4 + Part 5) so planners iterate and compare.

### 3.3 Recalculation strategy (recommendation)

Keep the **two-tier** model — it is the right answer for the mandate:

- **Tier 1 (default, exists): closed-form adjustment.** Sensitivity (Pearson) or causal ATE applied to the stored baseline. Sub-second, no engine touch, fully reuses outputs. Covers ~95% of planning what-ifs.
- **Tier 2 (optional, G7): true re-forecast.** Only when a planner needs a model-faithful re-projection (e.g., structural price step). Re-invoke `forecast_one_sku` for the single entity with overridden future exog (`build_future_exog` already supports planner events). Gated behind an explicit "High-fidelity recompute" toggle because it costs seconds and re-enters the engine. **Defer to Phase 5+** — not needed for v1 of the delta.

### 3.4 Performance considerations

- Tier-1 is O(horizon) arithmetic → keep synchronous-feeling via existing async job, but it returns in <1s.
- Cache `_scenario_feature_sensitivity` per `(dataset, entity)` — correlations don't change between what-ifs.
- Comparison page (G3) reads already-saved scenario `result_json` → zero recompute.
- SHAP: cache per entity; cap `topN`; fit on the per-entity panel (small) not the global panel unless the global model is already in memory.

---

# PART 4 — UI Design

### 4.1 Pages / tabs

| Screen | Status | Action |
|---|---|---|
| **Causal Analysis** | ✅ exists (`scenario-causal-view.tsx`) | add SHAP sub-tab (G1) |
| **Scenario Builder (What-If)** | ✅ exists (`scenario-view.tsx`) | add revenue KPIs + typed levers (G2/G6) |
| **Scenario Comparison** | ⛔ route reserved, view missing | **build (G3)** |
| **Explainability** | ✅ exists | add SHAP section |

### 4.2 Scenario Comparison page (G3) — new, the biggest UI piece

Route `/scenarios/compare` (already in `routes.ts`), backed by existing `comparison-store`.

**Components**
- **Scenario picker** — multi-select chips of saved scenarios (`whatifService.list()`), one flagged as baseline.
- **KPI delta strip** — per scenario: Δunits, Δ%, Δrevenue, change vs baseline (reuse `surface-elevated` cards).
- **Overlay chart** — `EChartBase` multi-line: baseline (navy dashed) + each scenario (orange shades from `--chart-4/5/8`). Reuse the `ScenarioChart` pattern, N series.
- **Comparison table** — TanStack `DataTable`: rows = scenarios, cols = Total Units, Δ Units, Δ %, Revenue, Δ Revenue, Champion, Created. Sortable; CSV export (reuse `*toCsv()` helpers).
- **Tornado/uplift bar** — horizontal bar of each scenario's revenue uplift vs baseline (reuse `CausalEffectsChart` green/red pattern).

**Filters:** dataset, forecast-level, metric toggle (units ↔ revenue) from `comparison-store`.
**Interactions:** select baseline → all deltas recompute client-side (no network); remove scenario; click row → open `/scenarios/{id}`.

### 4.3 Recommended ECharts per screen (all reuse existing components)

| Need | Chart | Existing component |
|---|---|---|
| Driver contribution % | horizontal bar | `ContributionBars` |
| Contribution waterfall | stacked-placeholder waterfall | `WaterfallChart` |
| Feature importance (SHAP) | horizontal bar + waterfall | `ContributionBars` + `WaterfallChart` |
| Demand driver table | data table | `DataTable` + `DriverTable` |
| Baseline vs scenario | multi-line | `ScenarioChart` pattern |
| Scenario uplift comparison | horizontal bar (tornado) | `CausalEffectsChart` pattern |
| Causal DAG | graph | `CausalGraph` |

**Zero new chart primitives required.** Palette, theming, null-safety, and `animation:false` conventions are inherited from `EChartBase`.

### 4.4 Component hierarchy (delta only)

```
features/scenarios/
  scenario-comparison-view.tsx            ← NEW (G3)
    ├─ ScenarioPickerBar                   ← NEW
    ├─ ComparisonKpiStrip                  ← NEW
    ├─ ScenarioOverlayChart (ScenarioChart pattern, N series)
    ├─ ScenarioComparisonTable (DataTable)
    └─ UpliftTornadoChart (CausalEffectsChart pattern)
  scenario-view.tsx                        ← EDIT: revenue KPIs, typed levers (G2/G6)
  scenario-causal-view.tsx                 ← EDIT: SHAP sub-tab (G1)
features/explainability/
  explainability-view.tsx                  ← EDIT: SHAP model-drivers section (G1)
```

---

# PART 5 — Database Design

### 5.1 Current `scenarios` table (keep)

```sql
CREATE TABLE scenarios (
  id TEXT PRIMARY KEY, dataset_id TEXT, owner TEXT, name TEXT,
  sku TEXT, adjustments_json TEXT, result_json TEXT, created_at TEXT
);
```

### 5.2 Versioning (G4) — add lineage without breaking existing rows

Additive columns + a lightweight version chain (SQLite-friendly, no migration framework needed — guard with `ALTER TABLE ... ADD COLUMN` in the existing idempotent schema bootstrap):

```sql
ALTER TABLE scenarios ADD COLUMN parent_id   TEXT;     -- prior version (null = root)
ALTER TABLE scenarios ADD COLUMN version     INTEGER DEFAULT 1;
ALTER TABLE scenarios ADD COLUMN status      TEXT DEFAULT 'draft';  -- draft|saved|archived
ALTER TABLE scenarios ADD COLUMN revenue_delta REAL;   -- denormalized for fast compare list
ALTER TABLE scenarios ADD COLUMN change_pct  REAL;
CREATE INDEX IF NOT EXISTS idx_scenarios_parent ON scenarios(parent_id);
```

"Save as new version" = insert row with `parent_id = current.id`, `version = current.version + 1`. List view groups by root, shows latest by default.

### 5.3 Causal/SHAP result cache (optional, perf) — new table

```sql
CREATE TABLE causal_results (
  id          TEXT PRIMARY KEY,
  dataset_id  TEXT,
  entity      TEXT,            -- forecast level / sku
  method      TEXT,            -- 'dowhy' | 'shap' | 'drivers'
  outcome     TEXT,
  result_json TEXT,            -- estimate_causal_effects / SHAP payload
  dataset_sig TEXT,            -- invalidation key (row_count + mtime)
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_causal_ds_entity ON causal_results(dataset_id, entity, method);
```

Purge on dataset reset (add to the existing workspace-reset purge list — see memory `phase-y0-release-readiness`).

### 5.4 Saved comparisons (optional) — only if planners want to persist a comparison set

```sql
CREATE TABLE scenario_comparisons (
  id TEXT PRIMARY KEY, dataset_id TEXT, owner TEXT, name TEXT,
  baseline_scenario_id TEXT, scenario_ids_json TEXT, metric TEXT, created_at TEXT
);
```

(v1 can keep this client-side in `comparison-store`; add the table only if cross-session sharing is requested.)

---

# PART 6 — Implementation Roadmap

### Phase 1 — Backend data & math (≈ 3–4 dev-days)
- **G2** revenue math in `_whatif_worker` (price-aware) — **S**
- **G6** expose lever `kind`/`unit`/`level` from `_scenario_exog_features` — **S**
- **G4** `scenarios` versioning columns + save-as-version logic — **S**
- **G1** SHAP compute helper (reuse `_scenario_causal_features`) + `causal_results` cache — **M**
- Add `shap>=0.44` to `requirements.txt`; defensive availability flag.

### Phase 2 — API (≈ 2 dev-days)
- `POST /explainability/shap/{level}` (G1)
- Extend `/scenarios/run` response (revenue) + `/scenarios/causal/features` (typed levers) — additive, backward compatible
- `GET /scenarios?root=…&latest=true` for versioned list (G4)
- Register new prefixes already covered by `LIVE_API_PREFIXES` (`/scenarios`, `/explainability` present).

### Phase 3 — Frontend (≈ 4–5 dev-days)
- **G3** `scenario-comparison-view.tsx` (picker, KPI strip, table) wired to `comparison-store` + `/scenarios/compare`
- **G2/G6** revenue KPIs + typed-lever controls in `scenario-view.tsx`
- **G1** SHAP sub-tab in causal + explainability views
- New service methods: `explainabilityService.shap`, comparison helpers; types in `types/whatif.ts`, `types/explainability.ts`.

### Phase 4 — Charts & viz (≈ 2 dev-days)
- Overlay chart (N-series), uplift tornado, SHAP waterfall/bars — all via reused `EChartBase` patterns + navy/orange palette
- CSV/PNG export via existing `onReady` + `*toCsv()` helpers.

### Phase 5 — Testing & hardening (≈ 3 dev-days)
- Backend: revenue math correctness, SHAP determinism (`random_state=42`), cache invalidation, DoWhy/SHAP-missing graceful paths
- Frontend: comparison baseline switching, empty/loading/error states, mock-vs-live routing, persistence across reload
- Parity check vs. existing scenario behavior (no regression to forecasting outputs)
- **(Optional, deferred) G7** true re-forecast tier — **L**, schedule only if planners demand model-faithful recompute.

### Total delta effort
**≈ 14–16 dev-days (3 weeks for one full-stack dev; ~2 weeks split BE/FE)** for G1–G6. G7 adds ~1.5–2.5 weeks if pursued later.

---

## Appendix A — Architecture (target state)

```
┌────────────────────────── FRONTEND (Next 15 / Zustand / ECharts) ──────────────────────────┐
│ /explainability ── ExplainabilityView ──┐                                                    │
│ /scenarios ─────── ScenarioPlanningView │  scenario-planning-store · comparison-store        │
│   ├ What-If (revenue+typed levers) ★    │  explainability-filter-store · forecast-level-store │
│   ├ Causal (DoWhy + SHAP ★) ────────────┤  whatifService · explainabilityService             │
│ /scenarios/compare ── ComparisonView ★ ─┘                                                     │
└──────────────────────────────────────────┬───────────────────────────────────────────────────┘
                                            │ LIVE_API_PREFIXES → axios + Bearer
┌──────────────────────────────────────────▼─────────────── BACKEND (FastAPI) ─────────────────┐
│ /scenarios/run (+revenue ★)   /scenarios/causal/{features,run,drivers,graph}                  │
│ /explainability/{local,horizon,shap ★}     async job + poll (/forecasts/jobs/{id})            │
│        │                    │                          │                                       │
│  _whatif_worker      scenario_engine.py (DoWhy)   shap helper ★ + _scenario_causal_features    │
│        │  reads baseline (NO engine re-run)                                                     │
└────────┼───────────────────────────────────────────────┬──────────────────────────────────────┘
         ▼ reuse                                          ▼ cache
  forecasts.detail_json  ◀── forecast engine (UNCHANGED)   causal_results ★ · scenarios(+version ★)
```
★ = new in this delta.

## Appendix B — Non-negotiables honored
- Forecasting engine (`app_v2_6.py`) untouched. ✔
- What-if reuses persisted `detail_json`; closed-form by default. ✔
- New endpoints additive; existing response shapes only *extended*. ✔
- Charts reuse `EChartBase` + strict navy/orange palette. ✔
- Graceful degradation when DoWhy/SHAP unavailable. ✔
- New tables/columns purged by workspace-reset. ✔
