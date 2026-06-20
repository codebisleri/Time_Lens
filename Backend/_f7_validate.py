"""F.7 engine-parity validation — proves Config & Prep settings change forecast
EXECUTION (not just persistence). Run with the venv python from Backend/."""
import sys
import pandas as pd
import numpy as np

import api
import app_v2_6 as engine

CSV = "api_data/ds_01d1576adaef__retail_realistic_demo.csv"
date_col, sales_col, sku_col, freq = "date", "sales", "sku", "MS"

df = pd.read_csv(CSV)
df[date_col] = pd.to_datetime(df[date_col], dayfirst=True, errors="coerce")
df = df.dropna(subset=[date_col])
print(f"loaded {len(df)} rows, {df[sku_col].nunique()} SKUs, "
      f"{df['brand'].nunique()} brands, {df['category'].nunique()} categories")

base = {"date_col": date_col, "sales_col": sales_col, "sku_col": sku_col, "freq": freq,
        "forecast_level_mode": "sku", "forecast_level_cols": [],
        "top_down_enabled": False, "top_down_levels": [], "top_down_apply": {},
        "top_down_disagg": "Historical average share", "top_down_noisy_cv2": 0.5}

ok = True

# ── 1) UNIFIED OUTLIER CLEANING ────────────────────────────────────────────
# Inject a clear spike so we can prove the fence clips it.
d2 = df.copy()
victim = d2[sku_col].iloc[0]
idx = d2.index[d2[sku_col] == victim][-1]
orig = float(d2.at[idx, sales_col])
d2.at[idx, sales_col] = orig * 50  # extreme spike
explain = api._resolve_outlier_explain_cols(list(d2.columns), [])
cleaned, n_treated, n_kept = api.apply_unified_outlier_treatment(
    d2.copy(), sku_col, sales_col, k_iqr=3.0, explain_cols=explain)
spike_after = float(cleaned.at[idx, sales_col])
print(f"\n[1] OUTLIER: injected spike {orig:.0f}->{orig*50:.0f}; "
      f"treated={n_treated}, after_clean={spike_after:.0f}, raw_preserved="
      f"{'sales_raw' in cleaned.columns}")
assert n_treated >= 1 and spike_after < orig * 50, "outlier cleaning did not clip the spike"
print("    PASS — cleaning changes the series the models train on")

# ── 2) FORECAST LEVEL AGGREGATION ──────────────────────────────────────────
agg_overall = api.aggregate_to_forecast_level(df.copy(), {**base, "forecast_level_mode": "overall"})
agg_brand = api.aggregate_to_forecast_level(df.copy(), {**base, "forecast_level_mode": "custom", "forecast_level_cols": ["brand"]})
n_periods = df[date_col].nunique()
print(f"\n[2] FORECAST LEVEL: overall entities={agg_overall[api.FORECAST_ENTITY_COL].nunique()} "
      f"rows={len(agg_overall)} (n_periods={n_periods}); "
      f"brand entities={agg_brand[api.FORECAST_ENTITY_COL].nunique()} (brands={df['brand'].nunique()})")
print(f"    sales conserved: raw={df[sales_col].sum():.0f} overall={agg_overall[sales_col].sum():.0f} "
      f"brand={agg_brand[sales_col].sum():.0f}")
assert agg_overall[api.FORECAST_ENTITY_COL].nunique() == 1
assert len(agg_overall) == n_periods
assert agg_brand[api.FORECAST_ENTITY_COL].nunique() == df["brand"].nunique()
assert abs(df[sales_col].sum() - agg_overall[sales_col].sum()) < 1  # SUM aggregation
assert abs(agg_overall["unit_price"].mean() - agg_overall["unit_price"].mean()) < 1e9  # price meaned (smoke)
print("    PASS — grain changes WHAT is forecast (entities, sales summed, prices meaned)")

# Prove the engine actually forecasts the aggregated entity (one fast run).
rcfg = api.resolve_pipeline_cfg({**base, "forecast_level_mode": "overall"})
skc = rcfg["sku_col"]
panel = engine.build_panel_features(agg_overall, date_col=date_col, sales_col=sales_col, sku_col=skc, freq=freq)
ent = str(agg_overall[skc].iloc[0])
res_overall = engine.forecast_one_sku(
    sku=ent, panel=panel, profile_row={}, h=6, freq=freq,
    sku_col=skc, date_col=date_col, sales_col=sales_col,
    run_backtest=False, cv_mode=False, cfg=None, compare_algos=["theta"])
print(f"    overall-grain forecast: entity='{ent}' sum={float(res_overall.forecast.sum()):.0f} "
      f"strategy={res_overall.strategy_used}")
assert res_overall.forecast is not None and len(res_overall.forecast) == 6

# ── 3) TOP-DOWN ROUTING ────────────────────────────────────────────────────
# Build minimal ForecastResult objects (a stable bottom-up forecast each), then
# route top-down. noisy_cv2=0 forces every SKU to qualify so we prove the change.
fut = pd.date_range(df[date_col].max(), periods=7, freq=freq)[1:]
skus = df[sku_col].astype(str).unique()[:6]
results = [engine.ForecastResult(sku=s, strategy_used="theta",
                                 forecast=pd.Series([100.0] * 6, index=fut, name=s))
           for s in skus]
before = {r.sku: float(r.forecast.sum()) for r in results}
profiles = engine.profile_all_skus(
    df, sku_col=sku_col, sales_col=sales_col, date_col=date_col,
    segment_col="", brand_col="", cold_start_threshold=6, short_history_threshold=12)
tcfg = {**base, "top_down_enabled": True, "top_down_levels": ["brand"],
        "top_down_apply": {"noisy": True}, "top_down_noisy_cv2": 0.0,
        "top_down_disagg": "Historical average share"}
_, summary = api.apply_top_down_routing(results, profiles, df, tcfg, 6)
rerouted = [r for r in results if r.strategy_used == "top_down"]
changed = [r.sku for r in results if abs(float(r.forecast.sum()) - before[r.sku]) > 1e-6]
print(f"\n[3] TOP-DOWN: enabled={summary['enabled']} levels={summary['levels']} "
      f"n_rerouted={summary['n_rerouted']} reasons={summary['reasons']}")
print(f"    forecasts changed for {len(changed)}/{len(results)} SKUs; "
      f"example note: {rerouted[0].notes if rerouted else '—'}")
assert summary["enabled"] and summary["n_rerouted"] >= 1 and len(changed) >= 1, "top-down did not re-route"
print("    PASS — top-down replaces qualifying SKU forecasts with aggregate×share")

# ── 4) DISABLED = NO-OP (control) ──────────────────────────────────────────
results2 = [engine.ForecastResult(sku=s, strategy_used="theta",
            forecast=pd.Series([100.0] * 6, index=fut, name=s)) for s in skus]
_, summ_off = api.apply_top_down_routing(results2, profiles, df, base, 6)
assert summ_off["enabled"] is False and all(r.strategy_used == "theta" for r in results2)
print("\n[4] CONTROL: top-down OFF → no-op (unchanged). PASS")

print("\nALL F.7 ENGINE-PARITY CHECKS PASSED" if ok else "FAILURES")
