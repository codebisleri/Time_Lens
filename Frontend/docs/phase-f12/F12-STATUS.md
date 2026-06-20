# Phase F.12 — Stability Hotfixes: Status

Forecast parity untouched (no engine/competition/evaluateOos/backtest/CI/
reconciliation/routing/profiling changes). Build: `type-check`/`lint`/`build` ✓;
backend `py_compile` ✓.

## Done & verified
| # | Item | What changed |
| --- | --- | --- |
| 4 | Remove Overview workflow stepper | Verified the 5-step stepper (`PrepStepper`) renders ONLY in Input Data & Configuration (`data-view`); Overview has no stepper — already correct. |
| 6 | Event Calendar date validation | New `parseEventDate` accepts **DD-MM-YYYY / DD/MM/YYYY / YYYY-MM-DD**; **missing required columns are detected BEFORE dates** ("Missing required column: notes"); end-before-start uses the new parser. (`future-events.tsx`) |
| 7 | Remove EDA/quality cards | Removed **Missing Values** + **Outliers** tiles from Data Quality Check; kept Total Rows / Duplicate Rows / Invalid Dates / Frequency. (`quality-schema.tsx`) |
| 8 | zrender addColorStop crash | Hardened the central `sanitizeEChartsOption`: any gradient `colorStops` color that isn't a non-empty string → safe fallback; empty solid `color` dropped. Applies to **every** chart + the resize path. (`lib/charts/sanitize.ts`) |
| 9 | Chart toolbar position | Verified the shared toolbox is injected at `right:10, top:4` (**top-right**) for all cartesian charts — already consistent. |
| 11 | Persist EDA state | New persisted `useEdaStore` (Zustand + localStorage) caches `ran` + scope + selectedSku + per-scope result. EDA **survives navigation / sidebar / forecast runs / refresh**; shows instantly with no "Run EDA" re-click; cleared only on new dataset upload. (`stores/eda-store.ts`, `eda-view.tsx`, `data-view.tsx`) |
| 12 | Forecast stall at 16% | Root cause: progress is per-SKU (`(0.5/N)*100` = 16% for 3 SKUs) and real per-model stages need engine hooks (engine is locked). Output-safe fix: an always-animating **shimmer** on the progress bar + the staged worker messages added earlier ("Training global model…", "Forecasting i/N", "Applying top-down…", "Finalizing…") → never appears frozen. |
| 13 | Forecast survives navigation | Already satisfied by the optimization-phase design: the run is a server-side job (independent of the page); navigating away stops polling but does NOT cancel the job, and returning **reconnects via localStorage** and resumes progress/results. |
| 14 | Suppress Streamlit warnings | Silenced `ScriptRunContext` UserWarnings + `MemoryCacheStorageManager` logs (logger levels + `warnings.filterwarnings`, `propagate=False`). No Streamlit context created. (`api.py`) |

## Deferred (with reasons — larger / iterative; not done this pass)
| # | Item | Why deferred |
| --- | --- | --- |
| 1 | Header badge redesign | The Time Lens element is now the live clock capsule (glass + glow + animation, refined over several prior phases). A further "badge" redesign is cosmetic-iterative; can do, but low marginal value. |
| 2 | Full login redesign (floating KPI cards, particles, animated dashboard) | Large. Current login already has an animated forecasting backdrop + glass card. Note: floating KPI cards reintroduce the on-screen forecast numbers that F.9 explicitly removed — worth confirming the direction before rebuilding. |
| 3 | Shared `app-header.tsx` for User Manual | Medium. The User Manual is a standalone popup window outside the app shell; `EnterpriseHeader` depends on app stores (theme/user/ui) + router context that the popup may not have. Needs a context-safe shared header extraction. |
| 5 | Remove previous forecast data | Ambiguous without a repro. Single-workflow mode already purges prior runs on upload, and `/forecasts/metrics` returns the latest run (which #5 says is acceptable). Need a concrete repro of the stale data to target precisely. |
| 10 | Streamlit EDA parity (monthly boxplots + 4-stack decomposition) | Large. The 4-stacked decomposition (Observed/Trend/Seasonal/Residual, shared x-axis, residual points) is buildable from existing decomposition data; the monthly **boxplots** need raw per-month distribution data the bridge may not yet expose. Needs new chart components + possible backend support. |

## Recommendation
The high-impact stability items (crash, validation, state persistence, progress,
warnings) are done. I'd tackle #10 (decomposition 4-stack) next as the biggest
remaining parity gap, then #3 (shared manual header). #2 needs a direction call
(floating KPI numbers vs the earlier "no numbers on login" rule).
