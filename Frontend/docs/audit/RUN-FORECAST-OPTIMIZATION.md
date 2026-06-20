# Run Forecast — Optimization Implementation (fixes applied)

Implements the approved fixes from `RUN-FORECAST-AUDIT.md`. Engine math unchanged
— only execution speed, persistence order, polling, and UX. Verified end-to-end.

## Output-safety statement
No forecasting algorithm, ranking, routing, feature engineering, reconciliation,
horizon, or confidence-interval code was changed. For a **given configuration**
the engine produces identical outputs. Changes are: a default toggle value,
persistence ordering (INSERT-live then top-down UPDATE → same final values), and
frontend job handling.

## Part 1 — OOS backtest now opt-in (the 18× lever)
- `evaluateOos` default flipped to **OFF**: frontend `DEFAULT_CONFIG` and backend
  `start_forecast_run` (`payload.get("evaluateOos", False)`). Offered as an opt-in
  "Accuracy mode" checkbox.
- Measured: per-SKU 47s (OOS on) → **2.5s** (OOS off). Smoke: 2 SKUs in **7.3s**.

## Part 2 — No false completion
- The poll loop no longer breaks on a timer and falls through to "complete". It
  only settles on `status === "completed"` (success) or `"failed"` (error).

## Part 3 — Long-run support + refresh reconnect
- Removed the 20-minute `MAX_WAIT_MS` cap — `pollUntilDone()` polls until terminal
  (transient network errors `continue`, never false-exit).
- Active job id + mode persisted to `localStorage`; on mount the view reconnects
  to an in-flight job (the worker keeps running server-side) and resumes
  monitoring / settles it.

## Part 4 — Progress feedback (from real job updates)
- Worker emits staged messages: **"Training global model…"**, **"Forecasting
  {sku} (i of N)"**, **"Applying top-down routing…"**, **"Finalizing results…"**,
  plus `progress`/`skuCount`/`total`. No fabricated progress.

## Part 5 — Live partial results
- Reverted the F.7 whole-run deferral: each forecast is **committed as it
  finishes** (`/forecasts` populates during the run). Top-down (when enabled)
  re-routes then **UPDATEs** the already-persisted rows — identical values.
- Smoke confirmed `saw live partial results: True`.

## Part 6 — Empty-success prevention
- A completed run with `skuCount === 0` is surfaced as an **error** ("produced 0
  forecasts — every forecasting level failed"), never a success toast.

## Part 7 — Error surfacing
- Partial runs warn: "Forecast complete — X of N forecast; (N−X) skipped".
- Single-SKU empty result → error. Poll errors keep monitoring (no silent exit).
  Per-SKU engine exceptions remain logged + skipped (counted toward "skipped").

## Validation
- Backend `py_compile` ✓; frontend `type-check`/`lint`/`build` ✓.
- TestClient smoke (demo, sample mode, OOS off): **completed, 2/2 SKUs, 7.3s,
  2 forecasts persisted, live partial results seen** → SMOKE PASS.
- Per-SKU timing: OOS off 2.5s vs OOS on 47s (audit measurement).

## Files changed
- `Backend/api.py` — `evaluateOos` default OFF; worker: stage messages + live
  per-SKU commit + top-down UPDATE + "Finalizing" message.
- `Frontend/src/features/forecast-run/forecast-view.tsx` — `evaluateOos` default
  OFF; `pollUntilDone` (no cap, no false-complete); `finishPortfolio`
  (empty-success/skipped handling); localStorage job persistence + refresh
  reconnect.
- `Frontend/src/features/forecast-run/forecast-run-config.tsx` — relabel OOS as
  "Accuracy mode (slower)".
- `Frontend/src/types/forecast.ts` — `ForecastJob.total`/`runId`.
