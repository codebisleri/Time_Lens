"""EXTERNAL measurement-only harness — Stages 6 (Explainability), 7 (Scenario),
9 (Serialization) and 10 (API response). Drives the REAL FastAPI app via
TestClient. App code is untouched. All timings measured (time.perf_counter).
"""
import os
os.environ.setdefault("STREAMLIT_SERVER_HEADLESS", "true")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
import sys, json, time
import warnings; warnings.filterwarnings("ignore")

CSV = "Data_for_forecast/retail_demo_data.csv"
REPS = {
    "Stable High contributors":   "BAG1031",
    "Stable Mid contributors":    "ACC1080",
    "Stable Low contributors":    "APP1110",
    "Volatile High contributors": "ACC1117",
    "Volatile Mid contributors":  "FOO1062",
    "Volatile Low contributors":  "BAG1076",
}
OUT = "pp_data/_audit/endpoints_summary.json"


def timed(fn):
    t = time.perf_counter()
    r = fn()
    return r, time.perf_counter() - t


def poll_job(client, job_id, kind="forecasts", timeout=180):
    t0 = time.perf_counter()
    while time.perf_counter() - t0 < timeout:
        r = client.get(f"/{kind}/jobs/{job_id}").json()
        if r.get("status") in ("completed", "failed"):
            return r, time.perf_counter() - t0
        time.sleep(0.4)
    return {"status": "timeout"}, time.perf_counter() - t0


def main():
    import scenario_engine, api
    from fastapi.testclient import TestClient
    client = TestClient(api.app)
    res = {"dowhy_available": bool(scenario_engine.DOWHY_AVAILABLE), "skus": {}}

    with open(CSV, "rb") as fh:
        raw = fh.read()
    (up, up_s) = timed(lambda: client.post("/datasets/upload",
                     files={"file": (os.path.basename(CSV), raw, "text/csv")}))
    dsid = up.json()["id"]
    res["upload_s"] = up_s
    res["datasetId"] = dsid
    print("uploaded dsid=%s in %.2fs" % (dsid, up_s))

    # Persist forecasts for the rep SKUs (so explainability reads a stored forecast).
    # Best-effort — explainability/causal endpoints work without it; if the run
    # endpoint shape differs we proceed and still measure Stage 6/7/9/10.
    reps = list(REPS.values())
    id_by_sku = {}
    try:
        (job, _) = timed(lambda: client.post("/forecasts/run", json={
            "datasetId": dsid, "skuIds": reps, "selectionMode": "pick",
            "periods": 6, "evaluateOos": True}))
        body = job.json()
        res["forecast_run_status_code"] = job.status_code
        res["forecast_run_body_keys"] = list(body.keys()) if isinstance(body, dict) else str(type(body))
        jid = body.get("id") if isinstance(body, dict) else None
        if jid:
            jr, jwait = poll_job(client, jid, "forecasts", timeout=600)
            res["forecast_job_status"] = jr.get("status")
            res["forecast_job_wait_s"] = jwait
            print("forecast job %s -> %s in %.1fs" % (jid, jr.get("status"), jwait))
        else:
            print("forecast/run returned no id (status=%s body=%s)" % (job.status_code, str(body)[:200]))
        fl = client.get(f"/forecasts?datasetId={dsid}").json()
        items = fl if isinstance(fl, list) else fl.get("items", fl.get("forecasts", []))
        for it in items:
            s = str(it.get("sku") or it.get("skuId") or it.get("skuCode") or "")
            if s and s not in id_by_sku:
                id_by_sku[s] = it.get("id")
    except Exception as exc:
        res["forecast_run_error"] = f"{type(exc).__name__}: {exc}"
        print("forecast/run skipped:", res["forecast_run_error"])

    for segment, sku in REPS.items():
        sku = str(sku)
        row = {"segment": segment}
        # Stage 6: Explainability
        (r1, t1) = timed(lambda: client.get(f"/explainability/local/{sku}?datasetId={dsid}"))
        (r2, t2) = timed(lambda: client.get(f"/explainability/horizon/{sku}?datasetId={dsid}"))
        j1 = r1.json()
        row["explainability_local_s"] = t1
        row["explainability_horizon_s"] = t2
        row["explainability_available"] = bool(j1.get("available"))
        row["explainability_contributions"] = j1.get("contributions")

        # Stage 7: Scenario / causal
        (r3, t3) = timed(lambda: client.get(
            f"/scenarios/causal/features?datasetId={dsid}&skuId={sku}"))
        j3 = r3.json()
        cols = j3.get("columns") or []
        outcome = j3.get("outcome")
        row["causal_features_s"] = t3
        row["causal_columns"] = cols
        row["causal_outcome"] = outcome
        treatments = cols[:1]  # one lever
        (r4, t4) = timed(lambda: client.post("/scenarios/causal/graph", json={
            "datasetId": dsid, "skuId": sku, "treatments": treatments}))
        row["causal_graph_s"] = t4

        # Stage 9/10: serialization + API response (GET stored forecast detail)
        fid = id_by_sku.get(sku)
        if fid:
            (r5, t5) = timed(lambda: client.get(f"/forecasts/{fid}"))
            row["forecast_detail_get_s"] = t5
            row["forecast_detail_bytes"] = len(r5.content)
        res["skus"][sku] = row
        print("%-26s %-9s explain=%.3fs horizon=%.3fs features=%.3fs graph=%.3fs detailGET=%s" % (
            segment, sku, t1, t2, t3, t4,
            ("%.3fs" % row.get("forecast_detail_get_s")) if fid else "n/a"))

    # Stage 7 full causal estimation (DoWhy) for ONE representative with levers
    target = None
    for sku in REPS.values():
        if res["skus"].get(str(sku), {}).get("causal_columns"):
            target = str(sku); break
    res["causal_estimation_target"] = target
    if target and res["dowhy_available"]:
        cols = res["skus"][target]["causal_columns"]
        (jr2, _) = timed(lambda: client.post("/scenarios/causal/run", json={
            "datasetId": dsid, "skuId": target, "treatments": cols[:1]}))
        cjid = jr2.json().get("id")
        cres, cwait = poll_job(client, cjid, "scenarios", timeout=300)
        res["causal_run_wait_s"] = cwait
        res["causal_run_status"] = cres.get("status")
        (jr3, _) = timed(lambda: client.post("/scenarios/causal/drivers", json={
            "datasetId": dsid, "skuId": target}))
        djid = jr3.json().get("id")
        dres, dwait = poll_job(client, djid, "scenarios", timeout=300)
        res["causal_drivers_wait_s"] = dwait
        res["causal_drivers_status"] = dres.get("status")
        print("CAUSAL %s run=%.1fs(%s) drivers=%.1fs(%s)" % (
            target, cwait, res["causal_run_status"], dwait, res["causal_drivers_status"]))
    else:
        print("CAUSAL estimation skipped (dowhy_available=%s target=%s)" % (
            res["dowhy_available"], target))

    os.makedirs("pp_data/_audit", exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(res, f, indent=1, default=str)
    print("WROTE", OUT)


if __name__ == "__main__":
    main()
