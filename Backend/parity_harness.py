"""Phase F.X - EDA + Profile & Route Streamlit-parity harness.

Computes TWO sets of results on the SAME dataset and diffs them:
  TRUTH  = direct calls to the Streamlit engine functions (app_v2_6) the way
           render_profiling_tab / render_eda_tab invoke them.
  NEXTJS = the React/FastAPI bridge endpoints (GET /skus, /segmentation, /eda)
           exercised through Starlette's TestClient.

The bridge REUSES the engine for profiling/segmentation/routing, so those are
implementation-identical by construction - the harness proves it and catches any
wiring / parameter / post-processing drift. EDA stats are recomputed in the
bridge; the harness checks them against the engine's df_eda / statsmodels.

Run:  python parity_harness.py [path-to-csv]
Exit code is the total mismatch count (0 = 100% parity).
"""
import math
import os
import sys

import pandas as pd
from fastapi.testclient import TestClient

import api
engine = api.engine

CSV = (sys.argv[1] if len(sys.argv) > 1
       else os.path.join(api.DATA_DIR, "ds_1c35665b6e9f__retail_realistic_demo.csv"))

mismatches = 0


def check(label, a, b, tol=1e-6):
    """Record a comparison. Numbers compared with tolerance; else by ==."""
    global mismatches
    ok = _eq(a, b, tol)
    if not ok:
        mismatches += 1
    return ok


def _eq(a, b, tol):
    if a is None and b is None:
        return True
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if (a is None) != (b is None):
            return False
        if math.isnan(float(a)) and math.isnan(float(b)):
            return True
        denom = max(1.0, abs(a), abs(b))
        return abs(float(a) - float(b)) <= tol * denom
    return str(a) == str(b)


def hr(t):
    # ASCII-only so stdout never raises on a cp1252 console (keeps exit code = mismatch count).
    print("\n" + "=" * 78 + f"\n{t}\n" + "=" * 78)


def _asc(s):
    return str(s).encode("ascii", "replace").decode("ascii")


# ── Upload via the bridge ─────────────────────────────────────────────────────
c = TestClient(api.app)
with open(CSV, "rb") as fh:
    rawb = fh.read()
dsid = c.post("/datasets/upload", files={"file": (os.path.basename(CSV), rawb, "text/csv")}).json()["id"]
row = api.load_dataset_row(dsid)
ds = dict(row)
df = api.load_dataset_df(row)  # canonical parsed frame (dayfirst), shared input
sku_col, date_col, sales_col = ds["sku_col"], ds["date_col"], ds["sales_col"]
freq = ds["freq"] or "MS"

# ── TRUTH: engine, with the exact Streamlit/_SEG_PARAMS defaults ──────────────
revenue_col = api._pick_column(list(df.columns.astype(str)), ["revenue", "total_revenue", "sales_value"])
segp = api._resolve_seg_params({})
truth_seg = engine.compute_retail_segmentation(
    df, sku_col=sku_col, sales_col=sales_col, date_col=date_col, revenue_col=revenue_col,
    cv_threshold=segp["cv_threshold"], high_cum_share=segp["high_cum_share"],
    mid_cum_share=segp["mid_cum_share"], min_periods=segp["min_periods"],
    new_product_months=segp["new_product_months"], churn_months=segp["churn_months"],
    short_history_months=segp["short_history_months"],
).set_index(sku_col)
truth_prof = engine.profile_all_skus(
    df, sku_col=sku_col, sales_col=sales_col, date_col=date_col,
    segment_col="", brand_col="", cold_start_threshold=6, short_history_threshold=12,
).set_index("sku")

# ── NEXTJS: bridge endpoints ──────────────────────────────────────────────────
next_seg = {str(s["sku"]): s for s in c.get("/segmentation", params={"datasetId": dsid}).json()["skus"]}
next_sku = {str(s["code"]): s for s in c.get("/skus", params={"datasetId": dsid, "pageSize": 500}).json()["items"]}

# ── PART 4/5: Profile & Route - per-SKU SEGMENT + ROUTE + profile fields ──────
hr("PROFILE & ROUTE - per-SKU parity (engine truth vs bridge endpoints)")
skus = [str(i) for i in truth_prof.index]
seg_mis, route_mis, field_mis = [], [], []
for s in skus:
    tp = truth_prof.loc[s]
    ts = truth_seg.loc[s] if s in truth_seg.index else None
    np_ = next_sku.get(s, {})
    ns = next_seg.get(s, {})
    # Segment
    t_segment = ts["segment"] if ts is not None else None
    if not check(f"seg[{s}]", t_segment, ns.get("segment")):
        seg_mis.append((s, t_segment, ns.get("segment")))
    # Route (recommended_strategy)
    if not check(f"route[{s}]", tp.get("recommended_strategy"), np_.get("recommendedStrategy")):
        route_mis.append((s, tp.get("recommended_strategy"), np_.get("recommendedStrategy")))
    # Profile fields
    for tkey, nkey in [("intermittency", "demandPattern"), ("cv", "cv"),
                       ("adi", "adi"), ("n_months", "nMonths"),
                       ("is_cold_start", "isColdStart"), ("is_short_history", "isShortHistory")]:
        tv, nv = tp.get(tkey), np_.get(nkey)
        if isinstance(tv, (bool,)):
            ok = bool(tv) == bool(nv)
        else:
            ok = _eq(tv if not (isinstance(tv, float) and pd.isna(tv)) else None, nv, 1e-6)
        if not ok:
            field_mis.append((s, tkey, tv, nv))
print(f"SKUs compared: {len(skus)}")
print(f"  segment mismatches: {len(seg_mis)}")
print(f"  route   mismatches: {len(route_mis)}")
print(f"  profile-field mismatches: {len(field_mis)}")
for s, t, n in seg_mis[:10]:
    print(f"    SEG  {s}: streamlit={t!r} next={n!r}")
for s, t, n in route_mis[:10]:
    print(f"    ROUTE {s}: streamlit={t!r} next={n!r}")
for s, k, t, n in field_mis[:10]:
    print(f"    FIELD {s}.{k}: streamlit={t!r} next={n!r}")
mismatches += len(field_mis)  # seg/route already counted via check()

# ── Distribution parity (segment counts + route counts) ───────────────────────
hr("DISTRIBUTIONS - segment counts & route counts")
t_seg_counts = truth_seg["segment"].value_counts().to_dict()
n_seg_counts = {}
for s in next_seg.values():
    n_seg_counts[s["segment"]] = n_seg_counts.get(s["segment"], 0) + 1
t_route_counts = truth_prof["recommended_strategy"].value_counts().to_dict()
n_route_counts = {}
for s in next_sku.values():
    k = s.get("recommendedStrategy")
    n_route_counts[k] = n_route_counts.get(k, 0) + 1
print(f"{'segment':32} {'ST':>5} {'NEXT':>5}  match")
for k in sorted(set(t_seg_counts) | set(n_seg_counts)):
    a, b = t_seg_counts.get(k, 0), n_seg_counts.get(k, 0)
    print(f"{k:32} {a:>5} {b:>5}  {check('segcount:' + k, a, b)}")
print(f"\n{'route':32} {'ST':>5} {'NEXT':>5}  match")
for k in sorted(set(t_route_counts) | set(n_route_counts)):
    a, b = t_route_counts.get(k, 0), n_route_counts.get(k, 0)
    print(f"{str(k):32} {a:>5} {b:>5}  {check('routecount:' + str(k), a, b)}")

# ── Routing KPI summary (the Profile page's "Model Routing" cards) ────────────
hr("ROUTING KPI SUMMARY - server-side counts vs engine render_profiling_tab")
t_routing = {
    "skusProfiled": int(len(truth_prof)),
    "coldStart": int(truth_prof["is_cold_start"].sum()) if "is_cold_start" in truth_prof else 0,
    "shortHistory": int(truth_prof["is_short_history"].sum()) if "is_short_history" in truth_prof else 0,
    "intermittentLumpy": int(truth_prof["intermittency"].isin(["intermittent", "lumpy"]).sum()),
    "brands": int(truth_prof["brand"].nunique()) if "brand" in truth_prof else 0,
}
n_routing = c.get("/segmentation", params={"datasetId": dsid}).json().get("routing", {})
print(f"{'kpi':18} {'STREAMLIT':>10} {'NEXT':>10}  match")
for k in t_routing:
    print(f"{k:18} {t_routing[k]:>10} {str(n_routing.get(k)):>10}  {check('routing:'+k, t_routing[k], n_routing.get(k))}")

# ── PART 1: EDA - portfolio stats vs engine df_eda / statsmodels ──────────────
hr("EDA - portfolio metrics (engine TimeSeriesEDA truth vs /eda)")
sub = df[[date_col, sales_col]].rename(columns={date_col: "date", sales_col: "sales"})
eda = engine.TimeSeriesEDA(sub, date_col="date", sales_col="sales",
                           country_code="IN", resample_freq=freq)
ser = eda.df_eda["sales"].astype(float)
t_eda = {
    "nPeriods": int(len(ser)),
    "mean": float(ser.mean()), "std": float(ser.std()),
    "min": float(ser.min()), "max": float(ser.max()), "total": float(ser.sum()),
    "anomalies": int(len(eda.potential_anomalies_df)) if eda.potential_anomalies_df is not None else 0,
    "totalRecords": int(len(df)),
}
n_eda_raw = c.get("/eda", params={"datasetId": dsid}).json()
ntr = n_eda_raw["trend"]
n_eda = {
    "nPeriods": n_eda_raw["dataQuality"]["nPeriods"],
    "mean": ntr["mean"], "std": ntr["std"], "min": ntr["min"], "max": ntr["max"], "total": ntr["total"],
    "anomalies": n_eda_raw["outliers"]["count"],
    "totalRecords": n_eda_raw["dataQuality"]["totalRecords"],
}
print(f"{'metric':14} {'STREAMLIT':>18} {'NEXT':>18}  match")
for k in t_eda:
    print(f"{k:14} {str(round(t_eda[k],4) if isinstance(t_eda[k],float) else t_eda[k]):>18} "
          f"{str(round(n_eda[k],4) if isinstance(n_eda[k],float) else n_eda[k]):>18}  {check('eda:'+k, t_eda[k], n_eda[k])}")

# Decomposition: same statsmodels call + engine-matched period.
period = api._DECOMP_PERIOD.get(freq, 4)
t_decomp_n = 0
if period >= 2 and len(ser) >= period * 2:
    from statsmodels.tsa.seasonal import seasonal_decompose
    dec = seasonal_decompose(ser, model="additive", period=period)
    t_decomp_n = int(len(dec.trend))
n_decomp = n_eda_raw.get("decomposition") or []
print(f"\n{'decomposition':14} period={period} pts: streamlit={t_decomp_n} next={len(n_decomp)}  "
      f"{check('eda:decompN', t_decomp_n, len(n_decomp))}")

# ── ACF/PACF — exact Streamlit plot_acf_pacf: fixed 20 lags, warn if len<=20,
#    and (faithfully) the SAME pacf failure when 20 >= nobs/2. ───────────────────
hr("ACF/PACF - fixed-20-lag parity (engine plot_acf_pacf)")
ACF_LAGS = 20
t_acf = t_pacf = None
truth_reason = ""
if len(ser) <= ACF_LAGS:
    truth_reason = f"Not enough data for {ACF_LAGS}-lag ACF/PACF."
else:
    try:  # mirror Streamlit's single try/except over BOTH acf and pacf
        from statsmodels.tsa.stattools import acf as _acf, pacf as _pacf
        t_acf = _acf(ser.values, nlags=ACF_LAGS, alpha=0.05)[0]
        t_pacf = _pacf(ser.values, nlags=ACF_LAGS, alpha=0.05)[0]
    except Exception as exc:
        truth_reason = f"Could not generate ACF/PACF: {exc}"
        t_acf = t_pacf = None
n_acf = n_eda_raw.get("autocorrelation") or []
n_pacf = n_eda_raw.get("partialAutocorrelation") or []
n_reason = n_eda_raw.get("acfPacfReason") or ""
if t_acf is None:
    print(f"series len={len(ser)} -> Streamlit shows NO chart, warning: {truth_reason!r}")
    print(f"  next reason: {n_reason!r}")
    check("acf:reason", truth_reason, n_reason)
    check("acf:emptyA", 0, len(n_acf))
    check("acf:emptyP", 0, len(n_pacf))
else:
    print(f"ACF lags: streamlit={len(t_acf)} next={len(n_acf)}  {check('acf:lagN', len(t_acf), len(n_acf))}  (expect 21)")
    print(f"PACF lags: streamlit={len(t_pacf)} next={len(n_pacf)}  {check('pacf:lagN', len(t_pacf), len(n_pacf))}  (expect 21)")
    acf_ok = all(check(f"acf:v{i}", float(t_acf[i]), n_acf[i]["value"]) for i in range(min(len(t_acf), len(n_acf))))
    pacf_ok = all(check(f"pacf:v{i}", float(t_pacf[i]), n_pacf[i]["value"]) for i in range(min(len(t_pacf), len(n_pacf))))
    print(f"ACF values identical:  {acf_ok}")
    print(f"PACF values identical: {pacf_ok}")
    check("acf:noReason", "", n_reason)

hr("RESULT")
print(f"TOTAL MISMATCHES: {mismatches}")
print("100% PARITY" if mismatches == 0 else "PARITY FAILED")
sys.exit(mismatches)

