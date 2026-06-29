"""EXTERNAL measurement-only harness — clean, NON-OVERLAPPING stage decomposition.

Monkeypatches (in THIS process only; the engine source is untouched) the engine's
top-level pipeline phase functions with depth-guarded timers so each phase bucket
is exclusive of the OTHER wrapped phases but INCLUSIVE of the model fits it drives.
Models are timed as a separate cross-cut (outermost-call only). No cProfile here,
so wall numbers are clean (no profiler inflation). Runs the same 6 representative
SKUs through the same engine.forecast_one_sku the production worker runs, inner
parallelism disabled (== worker). All timings measured.
"""
import os
os.environ.setdefault("STREAMLIT_SERVER_HEADLESS", "true")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
import json, time
import warnings; warnings.filterwarnings("ignore")
from _audit_timeline import prep, REPS, SKC, DC, SC, FREQ, H, OUTDIR

PHASES = [
    "build_candidate_backtest_fns",   # pool build (routing realised)
    "pick_champion_by_holdout",       # champion selection (candidate holdouts)
    "evaluate_all_candidates_test_mape",  # all-algorithm / blend metrics
    "rolling_origin_train_backtest",  # in-sample rolling origin
    "timeseries_kfold_cv",            # cross validation
    "fine_tune_winner",               # hyperparameter fine tuning
    "conditional_xgb_residual_correction",  # residual correction
    "conformal_intervals",            # confidence intervals
]
MODELS = [
    "forecast_sarimax_with_promo", "forecast_with_global_lgbm", "forecast_moe",
    "forecast_chronos", "forecast_tsb", "forecast_prophet", "forecast_autoarima",
    "forecast_holt_winters", "forecast_theta", "forecast_naive_seasonal",
    "forecast_catboost_uni", "forecast_xgb_quantile_90",
    "forecast_neural_elasticity_uni", "forecast_dl_moe",
]

_stack = []            # active phase frames (for child subtraction)
_phase_excl = {}
_phase_incl = {}
_phase_calls = {}
_model_incl = {}
_model_calls = {}
_model_depth = [0]


def _wrap_phase(engine, name):
    orig = getattr(engine, name)
    def w(*a, **k):
        frame = {"child": 0.0}
        _stack.append(frame)
        t0 = time.perf_counter()
        try:
            return orig(*a, **k)
        finally:
            dt = time.perf_counter() - t0
            _stack.pop()
            _phase_incl[name] = _phase_incl.get(name, 0.0) + dt
            _phase_excl[name] = _phase_excl.get(name, 0.0) + (dt - frame["child"])
            _phase_calls[name] = _phase_calls.get(name, 0) + 1
            if _stack:
                _stack[-1]["child"] += dt   # subtract from enclosing phase only
    return w


def _wrap_model(engine, name):
    orig = getattr(engine, name)
    def w(*a, **k):
        outer = _model_depth[0] == 0
        _model_depth[0] += 1
        t0 = time.perf_counter()
        try:
            return orig(*a, **k)
        finally:
            dt = time.perf_counter() - t0
            _model_depth[0] -= 1
            _model_calls[name] = _model_calls.get(name, 0) + 1   # every invocation == 1 fit
            if outer:  # inclusive time, outermost call only (avoid model-in-model double count)
                _model_incl[name] = _model_incl.get(name, 0.0) + dt
    return w


def main():
    import app_v2_6 as engine
    for nm in PHASES:
        if hasattr(engine, nm):
            setattr(engine, nm, _wrap_phase(engine, nm))
    for nm in MODELS:
        if hasattr(engine, nm):
            setattr(engine, nm, _wrap_model(engine, nm))

    eng, df, panel, prof_by_sku, seg_by_sku, gpkg, gpkg_bt, gtime = prep(use_global=True)
    engine.set_inner_parallelism_disabled(True)
    print("PREP done global=%.3fs" % gtime)

    out = {"global_train_s": gtime, "skus": {}}
    for segment, sku in REPS.items():
        sku = str(sku)
        _phase_excl.clear(); _phase_incl.clear(); _phase_calls.clear()
        _model_incl.clear(); _model_calls.clear(); _stack.clear(); _model_depth[0] = 0
        pr = prof_by_sku.get(sku, {})
        t0 = time.perf_counter()
        res = engine.forecast_one_sku(
            sku=sku, panel=panel, profile_row=pr, h=H, freq=FREQ,
            sku_col=SKC, date_col=DC, sales_col=SC,
            global_pkg=gpkg, global_pkg_backtest=gpkg_bt,
            run_backtest=True, cv_mode=False, compare_algos=None,
        )
        total = time.perf_counter() - t0
        phases = dict(_phase_excl)
        accounted = sum(phases.values())
        out["skus"][sku] = {
            "segment": segment, "total_s": total,
            "champion": getattr(res, "strategy_used", None),
            "phase_excl_s": phases,
            "phase_incl_s": dict(_phase_incl),
            "phase_calls": dict(_phase_calls),
            "other_s": total - accounted,
            "model_incl_s": dict(_model_incl),
            "model_fits": dict(_model_calls),
        }
        print("%-26s %-9s total=%6.2fs accounted=%5.2fs other=%5.2fs champ=%s" % (
            segment, sku, total, accounted, total - accounted, getattr(res, "strategy_used", None)))

    os.makedirs(OUTDIR, exist_ok=True)
    with open(os.path.join(OUTDIR, "phases_summary.json"), "w") as f:
        json.dump(out, f, indent=1, default=str)
    print("WROTE", os.path.join(OUTDIR, "phases_summary.json"))


if __name__ == "__main__":
    main()
