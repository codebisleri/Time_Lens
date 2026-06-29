"""EXTERNAL measurement-only harness for the Global LGBM audit. App code untouched.
Measures (no estimation): global-model training time (each holdout), model &
panel-history sizes, a standalone recursive forecast (time + tracemalloc peak +
predict-call count), and total global predict reuse across a full forecast_one_sku.
"""
import os
os.environ.setdefault("STREAMLIT_SERVER_HEADLESS", "true")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
import json, time, pickle, tracemalloc, sys
import warnings; warnings.filterwarnings("ignore")
import pandas as pd

CSV="Data_for_forecast/retail_demo_data.csv"; SKC,DC,SC="sku","date","sales"; FREQ="MS"; H=6
TARGETS={"Volatile Mid contributors":"FOO1062","Stable Mid contributors":"ACC1080"}

def main():
    import app_v2_6 as engine
    df=pd.read_csv(CSV)
    profiles=engine.profile_all_skus(df,sku_col=SKC,sales_col=SC,date_col=DC,segment_col="",brand_col="",
                                     cold_start_threshold=6,short_history_threshold=12)
    prof_by_sku={str(r["sku"]):r for r in profiles.to_dict("records")}

    t=time.perf_counter(); panel=engine.build_panel_features(df,date_col=DC,sales_col=SC,sku_col=SKC,freq=FREQ)
    panel_build_s=time.perf_counter()-t
    brand_c=next((c for c in df.columns if c.lower() in ("brand","manufacturer","vendor","label")),None)
    cats=[c for c in [brand_c,"price_band"] if c and c in panel.columns]
    for c in cats:
        if str(panel[c].dtype)=="object": panel[c]=panel[c].astype("category")

    # training time per holdout (st.cache_resource memoizes; bypass via __wrapped__ for true fit time)
    raw_train=getattr(engine.train_global_lightgbm,"__wrapped__",engine.train_global_lightgbm)
    t=time.perf_counter(); gpkg=raw_train(panel,SKC,DC,SC,FREQ,cats,holdout_periods=0); train0_s=time.perf_counter()-t
    t=time.perf_counter(); gpkg_bt=raw_train(panel,SKC,DC,SC,FREQ,cats,holdout_periods=H); trainN_s=time.perf_counter()-t

    out={"panel_build_s":panel_build_s,"train_holdout0_s":train0_s,"train_holdoutN_s":trainN_s,
         "n_skus_total":int(df[SKC].nunique()),
         "panel_rows":int(len(panel)),"panel_cols":int(panel.shape[1]),
         "feature_cols_count":len(gpkg.feature_cols),"feature_cols":gpkg.feature_cols,
         "categorical_cols":gpkg.categorical_cols,
         "lgbm_params":gpkg.model.get_params(),
         "n_estimators_fit":int(getattr(gpkg.model,"n_estimators_",getattr(gpkg.model,"n_estimators",0))),
         "train_rows_holdout0":int(len(gpkg.panel_history.dropna(subset=['lag_1']))),
         "train_rows_holdoutN":int(len(gpkg_bt.panel_history.dropna(subset=['lag_1']))),
         }
    # sizes
    out["model_pickle_bytes"]=len(pickle.dumps(gpkg.model))
    out["package_pickle_bytes"]=len(pickle.dumps(gpkg))
    out["panel_history_mem_bytes"]=int(gpkg.panel_history.memory_usage(deep=True).sum())
    out["panel_full_mem_bytes"]=int(panel.memory_usage(deep=True).sum())
    out["booster_num_trees"]=int(gpkg.model.booster_.num_trees())

    # count predict calls by wrapping the fitted model's predict
    orig_predict=gpkg.model.predict
    counters={"predict_calls":0,"predict_rows":0}
    def counting_predict(X,*a,**k):
        counters["predict_calls"]+=1
        try: counters["predict_rows"]+=len(X)
        except Exception: pass
        return orig_predict(X,*a,**k)
    gpkg.model.predict=counting_predict

    out["skus"]={}
    engine.set_inner_parallelism_disabled(True)
    for seg,sku in TARGETS.items():
        sku=str(sku)
        # (A) standalone single recursive forecast: time + peak mem + predict calls
        counters["predict_calls"]=0; counters["predict_rows"]=0
        tracemalloc.start()
        t=time.perf_counter()
        fc=engine.forecast_with_global_lgbm(gpkg,sku,H)
        single_s=time.perf_counter()-t
        cur,peak=tracemalloc.get_traced_memory(); tracemalloc.stop()
        rec={"segment":seg,
             "primary_strategy":prof_by_sku.get(sku,{}).get("recommended_strategy"),
             "standalone_forecast_s":single_s,
             "standalone_predict_calls":counters["predict_calls"],
             "standalone_peak_mem_bytes":int(peak),
             "forecast_values":[round(float(v),2) for v in fc.tolist()],
             "sku_history_rows":int((gpkg.panel_history[gpkg.panel_history[SKC]==sku]).shape[0]),
             }
        out["skus"][sku]=rec
        print("%-26s %-9s standalone=%.4fs predicts=%d peakKB=%.1f fc=%s"%(
            seg,sku,single_s,rec["standalone_predict_calls"],peak/1024,rec["forecast_values"]))

    # (B) FULL forecast_one_sku for one target -> count total global predict reuse
    target=str(TARGETS["Volatile Mid contributors"])
    counters["predict_calls"]=0; counters["predict_rows"]=0
    t=time.perf_counter()
    res=engine.forecast_one_sku(sku=target,panel=panel,profile_row=prof_by_sku.get(target,{}),
        h=H,freq=FREQ,sku_col=SKC,date_col=DC,sales_col=SC,
        global_pkg=gpkg,global_pkg_backtest=gpkg_bt,run_backtest=True,cv_mode=False)
    full_s=time.perf_counter()-t
    out["full_forecast_one_sku"]={
        "target":target,"total_s":full_s,
        "global_predict_calls_total":counters["predict_calls"],
        "champion":getattr(res,"strategy_used",None),
        "global_in_all_models": "global_lgbm" in (getattr(res,"all_algorithm_metrics",{}) or {}),
        "global_test_wmape": (getattr(res,"all_algorithm_metrics",{}) or {}).get("global_lgbm",{}).get("test_mape"),
    }
    print("FULL %s total=%.2fs global_predict_calls=%d champion=%s"%(
        target,full_s,counters["predict_calls"],out["full_forecast_one_sku"]["champion"]))

    os.makedirs("pp_data/_audit",exist_ok=True)
    with open("pp_data/_audit/global_lgbm.json","w") as f: json.dump(out,f,indent=1,default=str)
    print("WROTE pp_data/_audit/global_lgbm.json")

if __name__=="__main__":
    main()
