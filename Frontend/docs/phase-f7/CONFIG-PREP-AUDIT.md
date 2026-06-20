# Phase F.7 — Configuration & Preparation Parity: Audit & Plan

Audit BEFORE implementation, per the phase gate. Source of truth:
- OLD: `Backend/app_v2_6.py` (2026-06-17)
- UPDATED: `Backend/app_v2_6 (1).py` (2026-06-19, +70 KB)

(The brief named them `app_v2_6 2.py` / `app_v2_6 2 (1).py`; the actual files on
disk are the two above — confirmed the old/updated pair.)

## Phase 1 — Configuration & Preparation Diff Report

Everything in the config/prep surface (date column, **date format + custom
strftime**, **frequency** detection, **history window**, exogenous 2b, future
events 2c, **routing thresholds**, **missing-value handling**, horizon) is
**byte-for-byte identical** between the two files. Three genuinely new things
were added:

| Change | Old behavior | New behavior | Frontend impact |
| --- | --- | --- | --- |
| **Forecast level (aggregation grain)** | Engine always forecasts per-SKU | New radio "Aggregation grain": `Per-SKU` / `Custom group level` / `Overall total`; "Custom" reveals a "Group by column(s)" multiselect + live entity-count caption (UPD 7920–7972). New cfg keys `forecast_level_mode` (`sku`/`custom`/`overall`), `forecast_level_cols` (UPD 8482–83). Backed by new engine fns `aggregate_to_forecast_level()` + `resolve_pipeline_cfg()` (UPD 646–724) | New radio + conditional multiselect in config; **runtime effect needs engine aggregation** |
| **Top-Down Forecasting (3b)** | Not present | New expander: enable checkbox (default off); "Aggregate to level(s)" multiselect; "Apply to which SKUs?" multiselect (`New/cold-start`, `Short-history`, `Lumpy/intermittent`, `Noisy`); "How to split back" selectbox (`Historical avg share` / `Recent share (last 6)` / `Equal share`). Widgets gated by the checkbox (UPD 8376–8442). New cfg keys `top_down_enabled`, `top_down_levels`, `top_down_apply{cold,short,lumpy,noisy}`, `top_down_disagg`, `top_down_noisy_cv2` (UPD 8488–94) | New sub-form; **runtime effect needs engine disaggregation** |
| **Unified outlier cleaning** | None (`treat_outliers` absent) | Checkbox "🧹 Clean outliers before training" (default **on**) + IQR-sensitivity slider (2.0–5.0, 3.0) — **lives in the Forecast tab**, not the config form. New engine fn `apply_unified_outlier_treatment()` run in `build_panel_features()` before training (UPD 1841–1902, 9483–9502) | A Forecast-tab control; **runtime effect needs engine prep step** |
| Config form location | Rendered in `st.sidebar` (`render_sidebar`) | Rendered as a main-area page (`render_config`) | Cosmetic for Streamlit; the Next.js app already has a main-area Data page — no impact |

## Phase 2 — Frontend Mapping Report

| Backend change | Frontend component | Required update | Engine? |
| --- | --- | --- | --- |
| `forecast_level_mode` / `forecast_level_cols` | `features/data/data-config-form.tsx`, `types/dataset.ts`, `Backend/api.py _resolve_config` | New "Forecast level" section: radio + conditional multiselect; new `DataConfig.forecastLevelMode/forecastLevelCols`; add keys to api defaults so they persist | Aggregation effect = **engine** |
| `top_down_*` | same | New "Top-Down Forecasting" card: checkbox + 2 multiselects + selectbox; new `DataConfig.topDown*`; persist | Disaggregation effect = **engine** |
| `treat_outliers` / `outlier_k_iqr` | Forecast run config (`features/forecast-run/*`) | Checkbox + slider on the **Forecast** page | Cleaning effect = **engine** |
| Config form → main page | already done (Data page) | none | — |

### Persistence note (verified)
`Backend/api.py::_resolve_config` (line 1233) keeps only saved keys that exist
in its `defaults` dict, so persisting any new config key requires adding it to
that dict — an allowed Configuration-&-Preparation API change.

## ⚠️ Constraint conflict (needs a decision)

The three new behaviors are **configuration controls whose actual effect lives
in the forecast engine** (`aggregate_to_forecast_level`, top-down
disaggregation, `apply_unified_outlier_treatment`). The phase's protection rules
say **"DO NOT MODIFY: Forecast engine / calculations / routing"**, while Phase 3
says **"No approximations. No simplifications. No skipped functionality."** These
are mutually exclusive for these features:

- **Config-surface parity (no engine):** add the new controls + persist the
  config. The Configuration & Preparation UI reaches parity, but forecasts do
  not yet *act* on the new settings (honest gap). ✅ respects protection rules.
- **Full behavioral parity:** also wire `Backend/api.py` to the new engine
  functions (the new fns live only in `app_v2_6 (1).py`, not the engine the
  bridge currently imports). ❌ this modifies the forecast engine/routing — only
  do it if that protection rule is explicitly lifted.

## Phase 4 — UI transformation (no conflict; pure UI)
Hero KPI strip (already on Data page), workflow stepper (Upload→Validate→
Configure→Prepare→Forecast), per-area config cards with icons/status/glass, a
live configuration summary panel, forecasting empty states. All
presentation-only.
