# Output Parity Validation — evaluateOos ON (A) vs OFF (B)

Validation only — no code changed. Same dataset, horizon (6), SKUs (8),
algorithms (`theta, holt_winters, autoarima, sarimax, croston_sba`), config; the
ONLY difference is `evaluateOos` (= engine `run_backtest`). Engine-direct via the
same `forecast_one_sku` call the worker uses. Statistical models are
deterministic, so A↔B differences are real (not RNG noise).

## Algorithm Selection Report — CHAMPION CHANGES 8/8
| SKU | Champion A (OOS on) | Champion B (OOS off) |
| --- | --- | --- |
| APP-2001 | autoarima | global_lgbm |
| APP-2002 | autoarima | global_lgbm |
| APP-2003 | autoarima | global_lgbm |
| APP-2004 | blend(holt_winters+autoarima+sarimax) | global_lgbm |
| APP-2005 | blend(autoarima+holt_winters+sarimax) | global_lgbm |
| APP-2006 | holt_winters | global_lgbm |
| APP-2007 | blend(theta+holt_winters+autoarima) | global_lgbm |
| APP-2008 | blend(theta+holt_winters+autoarima) | global_lgbm |

**Every SKU's selected model changed.** Root cause: the multi-model competition
is **backtest-driven** — the champion is chosen by hold-out (test) WMAPE produced
by the OOS backtest. With `run_backtest=False` there is no competition; the engine
falls back to each SKU's **routed/default strategy** (here `global_lgbm` for all),
*even ignoring `compare_algos`* (global_lgbm was not in the candidate list yet won
in B). So OOS off ≠ "same models, no metrics" — it changes *which model forecasts*.

## Forecast Value Report
| Metric | Value |
| --- | --- |
| Max absolute Δ (any period) | **1316.96 units** |
| Mean %diff across SKUs | **10.94 %** |
| Max %diff across SKUs | **29.32 %** |
| SKUs with 0 change | 1/8 (APP-2006 — routed default happened to equal the champion) |

## Confidence Interval Report
CIs are produced by the *selected* model, so they change wherever the champion
changes (8/8). Not comparable like-for-like because the underlying model differs.

## Accuracy Metric Report
| Metric | A (OOS on) | B (OOS off) |
| --- | --- | --- |
| test WMAPE (backtest) | 30.55 (example SKU) | **None** (no backtest) |
| MAPE / WMAPE / RMSE (OOS) | available | **not computed** |

B produces no out-of-sample accuracy metrics by design — so accuracy cannot be
reported or used for selection in fast mode.

## Output Parity Conclusion → **C — Material differences**
Disabling OOS does **not** preserve forecast outputs: the champion changes for
every SKU and forecast values differ by ~11% on average (up to ~29%), because
model selection depends on the backtest. **OOS is required for model selection**,
not merely for reporting accuracy.

### Caveat
Test ran without a global package passed (`global_pkg=None`); the shipped worker
trains global LightGBM when `useGlobal=true`. This does not change the conclusion —
B still bypasses the competition and uses the routed default; the champion/value
divergence holds. (Re-running with a global package would only change B's
global_lgbm numbers, not the fact that A≠B.)

## Recommendation (NOT implemented — validation phase)
The "default OOS off" optimization (`RUN-FORECAST-OPTIMIZATION.md` Part 1) trades
competition-based model selection for the routed default — a material behavior
change, not a transparent speed-up. Options for the owner to decide:
1. **Re-enable OOS by default** for correct model selection (accept the ~47s/SKU
   cost; keep the other optimizations — polling/false-completion/live-results/
   progress/empty-success — which are output-neutral and remain valid).
2. **Cheaper selection** (future work): replace the rolling-origin backtest with a
   single hold-out fold and/or exclude Prophet from the backtest — keeps
   competition-based selection at a fraction of the cost. Would need its own
   parity check.
3. **Keep OOS off** only if the business accepts routed-default forecasts for
   interactive runs and reserves "Accuracy mode" for final/published runs.

All other optimizations in this phase (Parts 2–7) are execution/UX only and do
**not** affect forecast values.
