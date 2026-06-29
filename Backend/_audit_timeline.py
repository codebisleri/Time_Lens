"""EXTERNAL measurement-only harness for the per-SKU execution-timeline audit.

This file is NOT part of the application. It imports the engine/api UNCHANGED
and measures them. It does not modify forecasting behaviour. Two prongs:

  mode=profile : per-SKU cProfile of engine.forecast_one_sku (Stages 2-5, 8),
                 inner-parallelism DISABLED (== production worker), single
                 process so cProfile captures every fit.
  mode=pool    : drive api's REAL persistent ProcessPool with all SKUs to
                 measure worker PIDs / reuse / queue-wait / dispatch (Stage 1).

All timings are measured (time.perf_counter / cProfile / time.time). Nothing
is estimated.
"""
import os
os.environ.setdefault("STREAMLIT_SERVER_HEADLESS", "true")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import sys, json, time, pickle, tempfile, cProfile, pstats, datetime as _dt
import warnings; warnings.filterwarnings("ignore")
import pandas as pd

CSV   = "Data_for_forecast/retail_demo_data.csv"
SKC, DC, SC = "sku", "date", "sales"
FREQ  = "MS"
H     = 6
OUTDIR = "pp_data/_audit"
REPS = {
    "Stable High contributors":   "BAG1031",
    "Stable Mid contributors":    "ACC1080",
    "Stable Low contributors":    "APP1110",
    "Volatile High contributors": "ACC1117",
    "Volatile Mid contributors":  "FOO1062",
    "Volatile Low contributors":  "BAG1076",
}


def _iso(t=None):
    return _dt.datetime.now().strftime("%H:%M:%S.%f")[:-3]


def prep(use_global=True):
    """Replicate api job-prep EXACTLY (sku grain, default config)."""
    import app_v2_6 as engine
    df = pd.read_csv(CSV)
    seg = engine.compute_retail_segmentation(df, sku_col=SKC, sales_col=SC, date_col=DC)
    seg_by_sku = dict(zip(seg[SKC].astype(str), seg["segment"].astype(str)))
    profiles = engine.profile_all_skus(
        df, sku_col=SKC, sales_col=SC, date_col=DC,
        segment_col="", brand_col="",
        cold_start_threshold=6, short_history_threshold=12,
    )
    prof_by_sku = {str(rec["sku"]): rec for rec in profiles.to_dict("records")}
    panel = engine.build_panel_features(df, date_col=DC, sales_col=SC, sku_col=SKC, freq=FREQ)
    global_pkg = global_pkg_backtest = None
    gtime = 0.0
    if use_global:
        all_cols = list(df.columns.astype(str))
        brand_c = next((c for c in all_cols if c.lower() in ("brand","manufacturer","vendor","label")), None)
        cats = [c for c in [brand_c, "price_band"] if c and c in panel.columns]
        for c in cats:
            if str(panel[c].dtype) == "object":
                panel[c] = panel[c].astype("category")
        t = time.perf_counter()
        try:
            global_pkg = engine.train_global_lightgbm(panel, SKC, DC, SC, FREQ, cats, holdout_periods=0)
            if global_pkg is not None:
                global_pkg_backtest = engine.train_global_lightgbm(panel, SKC, DC, SC, FREQ, cats, holdout_periods=H)
        except Exception as exc:
            print("global LGBM unavailable:", exc)
        gtime = time.perf_counter() - t
    return engine, df, panel, prof_by_sku, seg_by_sku, global_pkg, global_pkg_backtest, gtime


def mode_profile():
    import app_v2_6 as engine
    os.makedirs(OUTDIR, exist_ok=True)
    eng, df, panel, prof_by_sku, seg_by_sku, gpkg, gpkg_bt, gtime = prep(use_global=True)
    print("PREP done. global_train_s=%.3f gpkg=%s" % (gtime, gpkg is not None))
    engine.set_inner_parallelism_disabled(True)  # == production worker (A1)

    summary = {"global_train_s": gtime, "global_available": gpkg is not None, "skus": {}}
    for segment, sku in REPS.items():
        pr = prof_by_sku.get(str(sku), {})
        hist_panel = df[df[SKC].astype(str) == str(sku)]
        n_hist = hist_panel[DC].nunique()
        prof = cProfile.Profile()
        pid = os.getpid()
        start_iso = _iso(); t0 = time.perf_counter()
        res = prof.runcall(
            engine.forecast_one_sku,
            sku=str(sku), panel=panel, profile_row=pr, h=H, freq=FREQ,
            sku_col=SKC, date_col=DC, sales_col=SC,
            global_pkg=gpkg, global_pkg_backtest=gpkg_bt,
            run_backtest=True, cv_mode=False, compare_algos=None,
        )
        total = time.perf_counter() - t0; end_iso = _iso()

        # Stage 8/9 measured: ForecastResult is already built (the return). Measure
        # build_forecast_detail + json serialization separately.
        import api
        hist_series = (hist_panel.sort_values(DC).set_index(DC)[SC])
        t = time.perf_counter()
        detail = api.build_forecast_detail(res, hist_series, horizon=str(H), brand=None, segment=segment)
        detail_s = time.perf_counter() - t
        t = time.perf_counter()
        payload = json.dumps({**detail, "id": "audit"}, default=str)
        json_s = time.perf_counter() - t

        # pstats rows
        st = pstats.Stats(prof)
        rows = []
        for (fpath, line, name), (cc, nc, tt, ct, callers) in st.stats.items():
            if tt < 0.0003 and ct < 0.0003:
                continue
            base = os.path.basename(fpath)
            rows.append({"file": base, "line": line, "name": name,
                         "ncalls": nc, "ccalls": cc, "tottime": tt, "cumtime": ct})
        rows.sort(key=lambda r: r["cumtime"], reverse=True)

        # ForecastResult facts
        aam = getattr(res, "all_algorithm_metrics", {}) or {}
        models = {}
        for m, d in aam.items():
            if not isinstance(d, dict):
                continue
            ff = d.get("future_forecast")
            models[m] = {
                "test_mape": d.get("test_mape"), "test_smape": d.get("test_smape"),
                "cv_mape": d.get("cv_mape"), "is_champion": bool(d.get("is_champion")),
                "test_reason": d.get("test_reason") or d.get("reason") or "",
                "fc_sum": (float(ff.sum()) if hasattr(ff, "sum") and ff is not None else None),
            }
        facts = {
            "segment_routing": segment,
            "n_history_months": int(n_hist),
            "pid": pid, "start": start_iso, "end": end_iso, "total_s": total,
            "strategy_used": getattr(res, "strategy_used", None),
            "auto_routed_strategy": getattr(res, "auto_routed_strategy", None),
            "cv_selected": getattr(res, "cv_selected", None),
            "cv_winner": getattr(res, "cv_winner", None),
            "cv_k": getattr(res, "cv_k", None),
            "backtest_mape": getattr(res, "backtest_mape", None),
            "backtest_smape": getattr(res, "backtest_smape", None),
            "train_mape": getattr(res, "train_mape", None),
            "test_horizon": getattr(res, "test_horizon", None),
            "ci_rows": (len(res.ci) if getattr(res, "ci", None) is not None else 0),
            "n_lookalikes": len(getattr(res, "lookalikes", []) or []),
            "build_detail_s": detail_s, "json_serialize_s": json_s,
            "json_bytes": len(payload),
            "models": models,
            "pstats": rows,
        }
        summary["skus"][str(sku)] = facts
        with open(os.path.join(OUTDIR, f"sku_{sku}.json"), "w") as f:
            json.dump(facts, f, indent=1, default=str)
        print("PROFILED %-28s %-9s %6.3fs champion=%s models=%d" % (
            segment, sku, total, facts["strategy_used"], len(models)))

    with open(os.path.join(OUTDIR, "profile_summary.json"), "w") as f:
        json.dump(summary, f, indent=1, default=str)
    print("WROTE", os.path.join(OUTDIR, "profile_summary.json"))


# ---- pool probe (must be top-level & spawn-importable) ----------------------
def pooled_probe(rid, payload_path, sku):
    import os, time, api
    t_enter = time.time(); pc0 = time.perf_counter()
    try:
        s, res, err = api._pp_forecast_worker_persistent(rid, payload_path, sku)
        champ = getattr(res, "strategy_used", None) if res is not None else None
    except Exception as exc:
        err = f"{type(exc).__name__}: {exc}"; champ = None
    t_exit = time.time()
    return {"sku": sku, "pid": os.getpid(), "t_enter": t_enter, "t_exit": t_exit,
            "compute_s": time.perf_counter() - pc0, "err": err, "champion": champ}


def mode_pool():
    from concurrent.futures import as_completed
    import api
    os.makedirs(OUTDIR, exist_ok=True)
    eng, df, panel, prof_by_sku, seg_by_sku, gpkg, gpkg_bt, gtime = prep(use_global=True)
    run_keys = sorted(df[SKC].dropna().astype(str).unique().tolist())
    limit = int(os.environ.get("AUDIT_POOL_NSKUS", "0") or 0)
    if limit and limit < len(run_keys):
        reps = [str(s) for s in REPS.values()]
        rest = [s for s in run_keys if s not in reps]
        run_keys = reps + rest[:max(0, limit - len(reps))]
    workers = min(os.cpu_count() or 1, 8)
    pp_shared = {
        "panel": panel, "prof_by_sku": prof_by_sku, "seg_by_sku": seg_by_sku,
        "segment_secondary": {}, "compare_algos": None,
        "periods": H, "freq": FREQ, "sku_col": SKC, "date_col": DC, "sales_col": SC,
        "global_pkg": gpkg, "global_pkg_backtest": gpkg_bt,
        "evaluate_oos": True, "cv_mode": False,
    }
    fd, ppath = tempfile.mkstemp(prefix="tl_audit_", suffix=".pkl")
    with os.fdopen(fd, "wb") as pf:
        pickle.dump(pp_shared, pf, protocol=pickle.HIGHEST_PROTOCOL)

    results = {"workers": workers, "cpu_count": os.cpu_count(),
               "n_skus": len(run_keys), "min_skus_threshold": api._PROCESSPOOL_MIN_SKUS,
               "processpool_enabled": api._PROCESSPOOL_ENABLED, "batches": []}
    try:
        for batch_i in (1, 2):
            rid = f"audit_{batch_i}_" + os.urandom(4).hex()
            pool = api._get_persistent_pool(workers)  # the REAL persistent singleton
            t_submit = {}
            wall0 = time.time(); pc0 = time.perf_counter()
            futs = {}
            for sku in run_keys:
                t_submit[sku] = time.time()
                futs[pool.submit(pooled_probe, rid, ppath, sku)] = sku
            tasks = []
            for fut in as_completed(futs):
                r = fut.result(); r["t_done"] = time.time()
                r["t_submit"] = t_submit[r["sku"]]
                tasks.append(r)
            wall = time.perf_counter() - pc0
            pids = {}
            for r in tasks:
                pids[r["pid"]] = pids.get(r["pid"], 0) + 1
            results["batches"].append({
                "batch": batch_i, "rid": rid, "wall_s": wall,
                "pid_taskcount": pids, "distinct_pids": len(pids),
                "pool_id": id(pool),
                "tasks": [{"sku": r["sku"], "pid": r["pid"],
                           "queue_wait_s": r["t_enter"] - r["t_submit"],
                           "compute_s": r["compute_s"],
                           "return_s": r["t_done"] - r["t_exit"],
                           "err": r["err"], "champion": r["champion"]} for r in tasks],
            })
            print("BATCH %d wall=%.2fs distinct_pids=%d pids=%s" % (batch_i, wall, len(pids), pids))
    finally:
        try: os.remove(ppath)
        except OSError: pass
    with open(os.path.join(OUTDIR, "pool_summary.json"), "w") as f:
        json.dump(results, f, indent=1, default=str)
    print("WROTE", os.path.join(OUTDIR, "pool_summary.json"))


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "profile"
    if mode == "profile":
        mode_profile()
    elif mode == "pool":
        mode_pool()
    else:
        print("unknown mode", mode)
