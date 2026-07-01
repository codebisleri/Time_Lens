import warnings; warnings.filterwarnings("ignore")
import time, json
import httpx

B = "http://127.0.0.1:8077"
c = httpx.Client(base_url=B, timeout=120)
results = {}
def ok(name, cond, extra=""):
    results[name] = bool(cond)
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {extra}")

# 1. Auth (login flow)
r = c.post("/auth/register", json={"email":"rc1@timelens.local","password":"rc1pass"})
tok = r.json().get("token") if r.status_code < 400 else None
if not tok:
    tok = c.post("/auth/login", json={"email":"rc1@timelens.local","password":"rc1pass"}).json().get("token")
ok("auth_login", bool(tok))
H = {"Authorization": f"Bearer {tok}"}

# 2. Upload dataset
with open("Data_for_forecast/retail_demo_data.csv","rb") as fh:
    up = c.post("/datasets/upload", headers=H, files={"file":("retail_demo_data.csv", fh.read(), "text/csv")}).json()
dsid = up.get("id"); ok("upload_dataset", bool(dsid), f"skuCount={up.get('skuCount')}")

# 3. EDA
eda = c.get("/eda", headers=H, params={"datasetId":dsid})
ok("eda", eda.status_code==200, f"http={eda.status_code}")

# 4. Segmentation
seg = c.post("/segmentation/run", headers=H, json={"datasetId":dsid})
ok("segmentation", seg.status_code==200 and (seg.json().get("totalSkus",0)>0), f"segs={len(seg.json().get('segments',[]))}")

# 5. Forecast (18 SKUs) + poll
import pandas as pd
skus = sorted(pd.read_csv("Data_for_forecast/retail_demo_data.csv")["sku"].unique())[:18]
job = c.post("/forecasts/run", headers=H, json={"datasetId":dsid,"selectionMode":"pick","skuIds":list(skus),"periods":6}).json()
jid = job.get("id"); status="?"
if jid:
    for _ in range(80):
        j = c.get(f"/forecasts/jobs/{jid}", headers=H).json()
        status = j.get("status")
        if status in ("completed","failed"): break
        time.sleep(3)
ok("forecast_run", status=="completed", f"status={status}")

# 6. Top-Down config persist (Task 19) — set eligible allowlist, verify it sticks
c.patch(f"/datasets/{dsid}/config", headers=H, json={"topDownEnabled":True,"topDownSkus":list(skus[:3])})
cfg = c.get(f"/datasets/{dsid}", headers=H).json().get("config",{})
ok("topdown_config_persist", cfg.get("topDownEnabled")==True and len(cfg.get("topDownSkus") or [])==3)
c.patch(f"/datasets/{dsid}/config", headers=H, json={"topDownEnabled":False,"topDownSkus":[]})

# 7. Scenario — whatif grid (Task 2) + causal features
grid = c.get("/scenarios/whatif/grid", headers=H, params={"datasetId":dsid,"skuId":skus[0]}).json()
ok("scenario_whatif_grid", grid.get("available")==True and len(grid.get("months",[]))>0, f"months={len(grid.get('months',[]))} feats={len(grid.get('features',[]))}")
cf = c.get("/scenarios/causal/features", headers=H, params={"datasetId":dsid,"skuId":skus[0]}).json()
ok("scenario_causal_features", "available" in cf, f"dowhy={cf.get('available')}")

# 8. Reports (Task 15 standardized header)
for rtype in ("segmentation","routed_forecast"):
    g = c.post("/reports/generate", headers=H, json={"datasetId":dsid,"type":rtype})
    rid = g.json().get("id") if g.status_code<400 else None
    html = ""
    if rid:
        html = c.get(f"/reports/{rid}/download", headers=H).text
    hdr = ('class="hero"' in html and "Time" in html and "Generated On" in html and "<svg" in html)
    ok(f"report_{rtype}", bool(rid) and hdr, f"len={len(html)} std_header={hdr}")

print("\n=== SUMMARY ===")
print(json.dumps(results, indent=0))
print("ALL_PASS" if all(results.values()) else "SOME_FAIL")
