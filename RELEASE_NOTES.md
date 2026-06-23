# Time Lens — Release Notes

## v1.0.0 — First Internal Release

DhishaAI **Time Lens** v1.0.0 — an enterprise demand-forecasting and planning
platform delivered as a Next.js web app, a FastAPI forecasting engine, and a
cross-platform Electron desktop application.

### Highlights

- **Forecast workflow** — end-to-end pipeline: Input & Configure → EDA →
  Profile & Route → Forecast → Explainability → Scenario → Reports. Per-item
  multi-model competition with champion selection by hold-out **WMAPE**.
- **Profile & Route** — intermittency-aware segmentation (Volatility ×
  Contribution) with auto-routing to best-fit model families, compact per-segment
  cards, and editable **primary + secondary models** per segment.
- **Dynamic filters & forecast-level terminology** — dataset-driven brand /
  segment / attribute filters; the whole app speaks the chosen forecast level
  (SKU, Material, Product, Customer, …).
- **Explainability** — per-forecast-level driver decomposition: Global Driver
  Contribution, monthly **Forecast Bridge**, and per-horizon contributions
  (trend / seasonality / holiday / promotion / price / weather / residual),
  with PNG & CSV export. Read-only; never alters forecasts.
- **Scenario analysis** — What-If feature simulation (re-forecast or apply a
  causal estimate) and **Causal Effect Estimation (DoWhy)**: treatments,
  confounders, instruments, effect modifiers, estimators, refuters, elasticity,
  robustness, and an effect chart with a plain-language summary.
- **Benchmark algorithms & top-down forecasting** — global benchmark pool and
  aggregate-then-allocate top-down routing for sparse/noisy items.
- **AI Assistant** — in-app Claude-powered assistant (server-side only; no API
  key ever reaches the browser) with server-side conversation memory; fully
  optional and isolated from the forecasting engine.
- **Desktop application** — frameless Electron shell bundling the FastAPI
  backend, with **Windows** (NSIS installer + portable) and **macOS** (dmg + zip,
  Intel & Apple Silicon) builds, and **workspace reset**.

### Platform support

- **Windows** — `TimeLens-Setup.exe` (NSIS) and `TimeLens.exe` (portable), x64.
- **macOS** — `TimeLens-<arch>.dmg` / `.zip` for Intel (x64) and Apple Silicon
  (arm64). Unsigned build: `xattr -cr "/Applications/Time Lens.app"` before first
  launch.

### Auto-updates

Built on `electron-updater` with electron-builder update feeds (`latest.yml` /
`latest-mac.yml`) and differential blockmaps — ready for GitHub Releases.

### Notes

- Forecast mathematics, WMAPE, champion selection, residual correction,
  confidence intervals, business rules, and scenario/report calculations are
  unchanged from the validated engine.
- Optional `dowhy` + `graphviz` enable the Scenario causal feature; without them
  the app degrades gracefully ("Causal analysis unavailable").
