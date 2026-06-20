# Run Forecast — Performance & Execution Audit (NO fixes applied)

Audit only. Root cause identified + measured. No optimizations implemented.

## TL;DR — Root cause
1. **The out-of-sample backtest dominates runtime.** Measured on the demo
   dataset (50 SKUs, monthly), one SKU's model competition:
   - backtest **OFF**: **2.52 s**
   - backtest **ON**: **47.04 s** (~**18×**)
   `evaluateOos` defaults **ON** (`api.py:2344`). So per-SKU cost is ~tens of
   seconds, and a portfolio run is `N × ~50s`.
2. **Large runs exceed the frontend's 20-minute poll cap → false "complete".**
   `selectionMode:"all"` / sampling pull up to `MAX_RUN_LIMIT = 60` SKUs ⇒ ~40–47
   min (extrapolated: 50 SKUs ≈ 39 min, 60 ≈ 47 min). The frontend stops polling
   at 20 min and **falsely reports success with empty results** (see Frontend bug).
3. **F.7 two-pass worker defers all DB writes to the end** ⇒ no partial/live
   results during the run; if it times out, metrics are empty → "appears frozen".

## Execution Flow Report
**Frontend** (`features/forecast-run/forecast-view.tsx`):
`Run forecasts` → `run()` → `forecastService.run(payload)` → `POST /forecasts/run`
returns a **job** immediately → `while (status !== completed|failed)` poll
`GET /forecasts/jobs/{id}` every `POLL_MS=2500ms`, cap `MAX_WAIT_MS=20min` →
on completed: `metrics.refetch()` (`GET /forecasts/metrics`).

**Backend** (`api.py`): `start_forecast_run` selects SKUs (pick/all/sample, ≤60),
registers an in-memory job, spawns a **daemon `threading.Thread`** running
`_forecast_worker`, returns the job. Worker: load df → history window → **outlier
clean** → **(F.7) forecast-level aggregate** → profiles + `build_panel_features`
→ **(if useGlobal) train_global_lightgbm ×2** (prod holdout=0 + backtest
holdout=periods) over the full panel → **Pass 1**: per-SKU `engine.forecast_one_sku`
(collect results, emit progress) → **(F.7) top-down re-route** → **Pass 2**: persist
each forecast (commit per SKU) → reconciliation → write `forecast_runs` → job
`completed`.

## Performance Report (measured, demo 50-SKU monthly, venv)
| Stage | Time | Notes |
| --- | --- | --- |
| `profile_all_skus` (all) | 0.01 s | cached; negligible |
| `build_panel_features` (all) | 0.34 s | negligible |
| `forecast_one_sku` 4-model, **OOS OFF** | **2.52 s** | base competition |
| `forecast_one_sku` 4-model, **OOS ON** | **47.04 s** | **rolling backtest refits per model/fold** |
| Extrapolated 50 SKUs (OOS ON) | **~39 min** | > 20-min frontend cap |
| Extrapolated 60 SKUs (OOS ON) | **~47 min** | > 20-min frontend cap |

The 4-model test **understates** production cost: the bridge default competes 6
algos (incl. `global_lgbm` + `moe`), and `useGlobal` adds two full-panel global
trainings up front. Prophet (cmdstanpy) refits on every backtest fold (visible as
repeated "Chain [1] start/done" logs) — a major contributor to the 18× blow-up.

## Backend Bottleneck Report
- **#1 — OOS backtest** inside `forecast_one_sku` (rolling-origin / per-fold refit
  of each candidate model × `periods` horizon). 2.5s→47s. The single biggest lever.
- **#2 — Per-SKU serial loop** (`_forecast_worker` Pass 1): no parallelism; total
  scales linearly `N × per-SKU`. CPU-bound Python.
- **#3 — Global LightGBM trained twice** over the FULL panel up front when
  `useGlobal` (default ON) — heavy, runs before any SKU progress (bar sits ~0%,
  message "Preparing data & features…").
- **#4 — GIL contention**: the worker runs CPU-bound model fitting in a thread;
  FastAPI sync handlers (the poll endpoint) share the process → progress polls can
  lag during heavy fitting, amplifying the "frozen" feeling.
- Prophet/cmdstanpy spawning per fold is disproportionately slow vs the statistical
  models.

## Streamlit Parity (Part 6.1)
The engine math is the SAME module (`api.py` imports `app_v2_6` and calls
`forecast_one_sku`/`train_global_lightgbm` directly) — the API layer did **not**
add algorithmic delay, and forecasting is **not** executed multiple times per
request (one worker thread per run; the frontend issues a single POST then polls).
Deviations from Streamlit are operational, not duplicative:
- Streamlit runs synchronously in one session and shows incremental `st` output
  as each SKU finishes; the bridge defers all persistence to **Pass 2** (F.7),
  so the React app shows **nothing until the whole run completes** (regression vs
  the previous per-SKU commit).
- Streamlit has no 20-min client cap; the React poll loop does.
No incorrect session-state duplication or duplicate processing was found.

## Frontend Bottleneck Report
- **BUG — false completion on timeout** (`forecast-view.tsx` `run()` ~L220-237 and
  `runSingleSku()` ~L160-180): when `waited > MAX_WAIT_MS` the loop `break`s while
  `job.status === "running"`; control falls through past the `failed` check to
  `toast.success("Forecast run complete")` + `setPhase("idle")` + `metrics.refetch()`.
  Result: after 20 min the user sees **"complete" with empty/partial results** even
  though the backend is still running. This is the primary "results never appear /
  appears frozen" symptom for large runs.
- **No "still running past cap" affordance** — the cap silently ends polling.
- Polling itself is fine (2.5s interval, in-memory job read is cheap); not a render
  loop. No excessive re-renders found in the run path; `cancelled` ref guards
  unmount. The clock's rAF is unrelated.

## Loading State Report
- A spinner + progress bar + `job.message` ARE shown while `phase==="running"`.
- Progress = `int((i+0.5)/total*100)` per SKU; during the upfront global training
  + first SKU it sits near 0% (looks stuck on big runs).
- On the timeout path the bar is abandoned mid-run and flipped to a false success.
- There is **no** stage / ETA / active-model / processed-count feedback.

## Error Report
- Per-SKU exceptions are **swallowed** (`forecast_one_sku failed for X` → warning,
  SKU skipped). If a systemic issue makes **every** SKU throw (e.g. a dtype/data
  problem), the run "completes" with **0 forecasts** and the UI shows success with
  an empty results panel — a **hidden failure**.
- Whole-run failures (parse/panel/DB) → job `failed` → surfaced correctly.
- `getJob` poll errors are caught and ignored (transient-tolerant; fine).
- `workflowService.complete` / `metrics.refetch` use `.catch(()=>{})` — acceptable,
  but a metrics-load failure is silent.

## API Report
- `POST /forecasts/run` returns a job immediately (non-blocking) ✓.
- `GET /forecasts/jobs/{id}` reads the in-memory `_JOBS` dict (lock-guarded), cheap ✓.
- Payload is correct (skuIds/selectionMode/periods/compareAlgos/flags). `periods`
  is overridden server-side by the saved config horizon (F.8) ✓.
- No duplicate requests/executions observed; one POST → one worker thread.
- No server-side request timeout issue (work is off-request in a thread).

## Progress System Feasibility (Part 9 — eval only, not implemented)
- A progress system **already partly exists**: the job exposes `progress`,
  `skuCount`, `total`, `message`, `status`.
- Feasible additions with modest worker changes: **current stage** (prep / global
  train / forecasting / top-down / persist), **processed forecasting-level count**
  (`i of N`, already in `message`), **active model name** (engine would need to
  surface the current candidate), **ETA** (derive from elapsed/▒done). Stage +
  count + ETA are low-effort (worker already emits per-SKU updates); active-model
  needs an engine hook (higher effort).

## Optimization Recommendations (identify only — do NOT implement yet)
1. **Default `evaluateOos` OFF** (or make the backtest cheap): single hold-out
   instead of per-fold rolling refit, fewer folds, and/or exclude Prophet from the
   backtest. Biggest win (≈18× per SKU).
2. **Fix the frontend timeout**: never false-complete — on cap, keep the run in a
   "still running" state (continue/long-poll, or surface "running in background")
   and only show results when `status==="completed"`. Raise/remove `MAX_WAIT_MS`.
3. **Restore live/partial results**: revert F.7's full deferral — commit each SKU
   in Pass 1 (then patch top-down rows), so `/forecasts` populates during the run.
4. **Parallelize the per-SKU loop** (process pool / joblib) — SKUs are independent;
   near-linear speedup, sidesteps the GIL.
5. **Train global LightGBM once / cache it**; skip when few SKUs selected.
6. **Surface 0-result completion as a warning**, not success; consider failing the
   run if every SKU errored.
7. **Bound/justify `MAX_RUN_LIMIT`** and warn the user of expected runtime
   (`N × per-SKU`), or chunk large runs.
8. Optionally move heavy work to a **process** (not thread) to free the API GIL.

## Files Involved
- `Frontend/src/features/forecast-run/forecast-view.tsx` (run/poll, timeout bug)
- `Frontend/src/features/forecast-run/forecast-run-config.tsx` (flags incl. evaluateOos default)
- `Frontend/src/lib/api/services/forecast.service.ts`, `lib/api/endpoints.ts`
- `Backend/api.py` — `start_forecast_run`, `_forecast_worker` (Pass1/Pass2, global train, top-down), `_job_update`, `get_forecast_job`, `DEFAULT_RUN_LIMIT=12`/`MAX_RUN_LIMIT=60`
- `Backend/app_v2_6 (1).py` — `forecast_one_sku` (OOS backtest), `train_global_lightgbm`

## Acceptance
✓ Root cause identified + **measured** (OOS backtest 18×) ✓ slow stages identified
✓ infinite/false-loading identified (20-min cap false-complete) ✓ hidden errors
identified (swallowed per-SKU, 0-result success) ✓ API/backend/frontend verified
✓ scaling extrapolated ✓ optimizations documented (not implemented).
