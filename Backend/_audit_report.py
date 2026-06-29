"""Aggregate all measured JSON outputs into the audit tables. Pure arithmetic on
measured data — no estimation. Prints structured numbers for the final report.
"""
import json, os, statistics as stx

A = "pp_data/_audit"
def L(name):
    p = os.path.join(A, name)
    return json.load(open(p)) if os.path.exists(p) else None

prof = L("profile_summary.json")
ph   = L("phases_summary.json")
pool = L("pool_summary.json")
endp = L("endpoints_summary.json")

SEG_ORDER = ["Stable High contributors","Stable Mid contributors","Stable Low contributors",
             "Volatile High contributors","Volatile Mid contributors","Volatile Low contributors"]
REPS = {"Stable High contributors":"BAG1031","Stable Mid contributors":"ACC1080",
        "Stable Low contributors":"APP1110","Volatile High contributors":"ACC1117",
        "Volatile Mid contributors":"FOO1062","Volatile Low contributors":"BAG1076"}

# stage mapping from phase_excl keys
STAGE_MAP = {
    "build_candidate_backtest_fns": "Routing/PoolBuild",
    "pick_champion_by_holdout": "ChampionSelection",
    "evaluate_all_candidates_test_mape": "ChampionSelection",
    "rolling_origin_train_backtest": "Validation",
    "timeseries_kfold_cv": "Validation",
    "fine_tune_winner": "Validation",
    "conditional_xgb_residual_correction": "Validation",
    "conformal_intervals": "Validation",
}

print("="*70)
print("PER-SKU PHASE DECOMPOSITION (clean, non-overlapping, measured)")
print("="*70)
if ph:
    for seg in SEG_ORDER:
        sku = REPS[seg]
        d = ph["skus"].get(sku)
        if not d: continue
        total = d["total_s"]; pe = d["phase_excl_s"]
        stage = {}
        for k,v in pe.items():
            stage[STAGE_MAP.get(k,"other")] = stage.get(STAGE_MAP.get(k,"other"),0)+v
        stage["Orchestration/Other"] = d["other_s"]
        print(f"\n--- {seg} | {sku} | total={total:.2f}s | champion={d['champion']}")
        for st in ["Routing/PoolBuild","ChampionSelection","Validation","Orchestration/Other"]:
            v = stage.get(st,0.0)
            print(f"   {st:24s} {v:7.3f}s  {100*v/total:5.1f}%")
        print("   phase detail (excl s):")
        for k,v in sorted(pe.items(), key=lambda x:-x[1]):
            print(f"      {k:38s} {v:7.3f}s  calls={d['phase_calls'].get(k)}")
        print("   model fits & inclusive time:")
        for m,t in sorted(d["model_incl_s"].items(), key=lambda x:-x[1]):
            print(f"      {m:34s} {t:7.3f}s  fits={d['model_fits'].get(m)}")

print("\n"+"="*70)
print("PROCESSPOOL (measured, real persistent pool)")
print("="*70)
if pool:
    print(f"workers={pool['workers']} cpu={pool['cpu_count']} n_skus={pool['n_skus']} "
          f"threshold={pool['min_skus_threshold']} enabled={pool['processpool_enabled']}")
    for b in pool["batches"]:
        ts = b["tasks"]
        qs = [t["queue_wait_s"] for t in ts]
        cs = [t["compute_s"] for t in ts]
        print(f"\nBatch {b['batch']} pool_id={b['pool_id']} wall={b['wall_s']:.2f}s "
              f"distinct_pids={b['distinct_pids']}")
        print(f"   pid->taskcount: {b['pid_taskcount']}")
        print(f"   queue_wait: min={min(qs):.3f} max={max(qs):.3f} mean={stx.mean(qs):.3f}")
        print(f"   compute_s : min={min(cs):.2f} max={max(cs):.2f} mean={stx.mean(cs):.2f} sum={sum(cs):.1f}")
        print(f"   return_s  : max={max(t['return_s'] for t in ts):.4f}")
    # reuse across batches
    if len(pool["batches"])>=2:
        p1=set(pool["batches"][0]["pid_taskcount"].keys())
        p2=set(pool["batches"][1]["pid_taskcount"].keys())
        print(f"\nPIDs batch1={sorted(p1)}")
        print(f"PIDs batch2={sorted(p2)}")
        print(f"SAME pool object across batches: {pool['batches'][0]['pool_id']==pool['batches'][1]['pool_id']}")
        print(f"PID overlap (reuse across runs): {sorted(p1 & p2)}")
    # per-rep in-pool compute
    print("\n   rep SKU in-pool compute (production wall, no profiler):")
    for seg in SEG_ORDER:
        sku=REPS[seg]
        for b in pool["batches"]:
            t=next((x for x in b["tasks"] if x["sku"]==sku),None)
            if t: print(f"      b{b['batch']} {seg:26s} {sku:9s} compute={t['compute_s']:6.2f}s pid={t['pid']} champ={t['champion']}")

print("\n"+"="*70)
print("CHAMPION / ALL-ALGORITHM METRICS (from profile run)")
print("="*70)
if prof:
    for seg in SEG_ORDER:
        sku=REPS[seg]; f=prof["skus"].get(sku)
        if not f: continue
        champs=[m for m,d in f["models"].items() if d["is_champion"]]
        print(f"\n{seg} | {sku} | champion={f['strategy_used']} | bt_wmape={f['backtest_mape']} bt_smape={f['backtest_smape']}")
        for m,d in sorted(f["models"].items(), key=lambda x:(x[1]['test_mape'] is None, x[1]['test_mape'] or 0)):
            print(f"   {m:42s} wmape={str(d['test_mape'])[:7]:7s} smape={str(d['test_smape'])[:7]:7s} champ={d['is_champion']}")

print("\n"+"="*70)
print("STAGE 8/9 (build_detail + json) and STAGE 6/7/10 (endpoints)")
print("="*70)
if prof:
    for seg in SEG_ORDER:
        sku=REPS[seg]; f=prof["skus"].get(sku)
        if f: print(f"{seg:26s} {sku:9s} build_detail={f['build_detail_s']*1000:.2f}ms json={f['json_serialize_s']*1000:.2f}ms bytes={f['json_bytes']}")
if endp:
    print(f"\nendpoints: dowhy_available={endp.get('dowhy_available')} upload_s={endp.get('upload_s')}")
    print(f"forecast_job: status={endp.get('forecast_job_status')} wait={endp.get('forecast_job_wait_s')}")
    for sku,r in endp.get("skus",{}).items():
        print(f"   {r['segment']:26s} {sku:9s} explain_local={r.get('explainability_local_s',0)*1000:.1f}ms "
              f"explain_horizon={r.get('explainability_horizon_s',0)*1000:.1f}ms "
              f"causal_feat={r.get('causal_features_s',0)*1000:.1f}ms causal_graph={r.get('causal_graph_s',0)*1000:.1f}ms "
              f"detailGET={r.get('forecast_detail_get_s',0)*1000:.1f}ms avail={r.get('explainability_available')}")
    print(f"causal estimation target={endp.get('causal_estimation_target')} run={endp.get('causal_run_wait_s')}s({endp.get('causal_run_status')}) "
          f"drivers={endp.get('causal_drivers_wait_s')}s({endp.get('causal_drivers_status')})")

# ---- model comparison across SKUs ----
print("\n"+"="*70)
print("MODEL EXECUTION COMPARISON (across reps, from phases)")
print("="*70)
if ph:
    agg={}
    champ_count={}
    for seg in SEG_ORDER:
        sku=REPS[seg]; d=ph["skus"].get(sku)
        if not d: continue
        for m,t in d["model_incl_s"].items():
            agg.setdefault(m,{"t":[],"fits":[]})
            agg[m]["t"].append(t); agg[m]["fits"].append(d["model_fits"].get(m,0))
    # champion counts from profile blends/strategy_used base models
    if prof:
        for seg in SEG_ORDER:
            sku=REPS[seg]; f=prof["skus"].get(sku)
            if not f: continue
            for m,dd in f["models"].items():
                if dd["is_champion"]:
                    champ_count[m]=champ_count.get(m,0)+1
    print(f"{'model':34s} {'avgT':>7s} {'maxT':>7s} {'minT':>7s} {'avgFits':>7s} {'nSKU':>4s}")
    for m,v in sorted(agg.items(), key=lambda x:-stx.mean(x[1]['t'])):
        print(f"{m:34s} {stx.mean(v['t']):7.2f} {max(v['t']):7.2f} {min(v['t']):7.2f} {stx.mean(v['fits']):7.1f} {len(v['t']):4d}")
    print("champion(base-model) counts:", champ_count)

# ---- validation comparison ----
print("\n"+"="*70)
print("VALIDATION STAGE COMPARISON (across reps, phase_excl)")
print("="*70)
if ph:
    VKEYS=["rolling_origin_train_backtest","timeseries_kfold_cv","fine_tune_winner",
           "conditional_xgb_residual_correction","conformal_intervals",
           "pick_champion_by_holdout","evaluate_all_candidates_test_mape"]
    for k in VKEYS:
        vals=[]; pcts=[]
        for seg in SEG_ORDER:
            sku=REPS[seg]; d=ph["skus"].get(sku)
            if not d: continue
            v=d["phase_excl_s"].get(k,0.0); vals.append(v); pcts.append(100*v/d["total_s"])
        if vals:
            print(f"{k:38s} avg={stx.mean(vals):6.3f}s max={max(vals):6.3f}s avg%={stx.mean(pcts):5.1f}")
print("\nDONE")
