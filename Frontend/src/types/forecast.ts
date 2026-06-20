import type { ID, ISODateString, ListParams } from "./api";

export type ForecastHorizon = "weekly" | "monthly" | "quarterly";
export type ForecastModel =
  | "arima"
  | "prophet"
  | "ets"
  | "moving_average"
  | "ensemble";
export type ForecastJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

/** A single point on a forecast series. */
export interface ForecastPoint {
  date: ISODateString;
  /** Observed value, present for historical/actual points. */
  actual?: number;
  /** Predicted value, present for forecasted points. */
  forecast?: number;
  /** Confidence interval bounds (e.g. 95%). */
  lowerBound?: number;
  upperBound?: number;
}

/** Accuracy / error metrics for a forecast. */
export interface ForecastMetrics {
  mape?: number;
  /** Symmetric MAPE (defined even when actuals are zero). */
  smape?: number;
  rmse?: number;
  mae?: number;
  bias?: number;
  /** Convenience accuracy = 1 - MAPE, 0–1. */
  accuracy?: number;
}

export interface Forecast {
  id: ID;
  skuId: ID;
  skuCode: string;
  skuName: string;
  horizon: ForecastHorizon;
  model: ForecastModel;
  generatedAt: ISODateString;
  periodStart: ISODateString;
  periodEnd: ISODateString;
  series: ForecastPoint[];
  metrics: ForecastMetrics;
}

/** A {date, value} overlay point (in-sample fit / test prediction / actuals). */
export interface ForecastValuePoint {
  date: ISODateString;
  value: number | null;
}

/**
 * Full forecast detail (GET /forecasts/{id}). Extends Forecast with the engine's
 * diagnostic overlays the Streamlit drill-down chart renders — these are ALREADY
 * produced by the bridge (`build_forecast_detail`): in-sample fit (rolling-origin
 * train prediction), the hold-out/validation test prediction, and the held-out
 * test actuals.
 */
export interface ForecastDetail extends Forecast {
  fit?: ForecastValuePoint[];
  testPred?: ForecastValuePoint[];
  testActual?: ForecastValuePoint[];
  strategyLabel?: string;
  trainWmape?: number | null;
  testWmape?: number | null;
}

/** Lightweight row for the Forecast Results list/table. */
export interface ForecastSummary {
  id: ID;
  skuId: ID;
  skuCode: string;
  skuName: string;
  horizon: ForecastHorizon;
  model: ForecastModel;
  accuracy?: number;
  totalForecastUnits: number;
  generatedAt: ISODateString;
}

export interface ForecastListParams extends ListParams {
  horizon?: ForecastHorizon;
  model?: ForecastModel;
  skuId?: ID;
}

/** Request to (re)run the forecasting engine for one or more SKUs. */
export interface RunForecastPayload {
  skuIds: ID[];
  horizon: ForecastHorizon;
  model?: ForecastModel;
  periods: number;
  /** Target a specific uploaded dataset (defaults to the latest server-side). */
  datasetId?: ID;
  /** Cap the number of SKUs forecast when skuIds is empty (top-N by volume). */
  limit?: number;
  // ── Streamlit Forecast-tab config (Phase C) ──
  selectionMode?: "pick" | "sample" | "all";
  brands?: string[];
  segments?: string[];
  samplePerStrategy?: number;
  /** Algorithm keys to benchmark per SKU (champion picked from this set). */
  compareAlgos?: string[];
  /** Auto-select the champion via K-fold cross-validation. */
  cvMode?: boolean;
  reconcile?: boolean;
  useGlobal?: boolean;
  /** Evaluate out-of-sample accuracy (backtest) over the horizon — Streamlit
   *  default ON; when off the engine skips backtesting (no test metrics). */
  evaluateOos?: boolean;
}

/** Algorithm registry entry (GET /forecasts/algorithms). */
export interface AlgorithmInfo {
  key: string;
  name: string;
  family: string | null;
  icon: string | null;
  description: string | null;
}

export interface ForecastAlgorithms {
  strategyInfo: AlgorithmInfo[];
  additionalAlgorithms: AlgorithmInfo[];
  recommended: string[];
  selectable: string[];
  minHistoryForCv: number;
}

/** One per-algorithm comparison row (all-models-per-SKU). */
export interface AllModelRow {
  algorithm: string;
  label: string;
  isChampion: boolean;
  testWmape: number | null;
  testSmape: number | null;
  cvWmape: number | null;
  valWmape: number | null;
  forecastTotal: number | null;
  reason: string;
}

/** Per-SKU row in the run metrics (GET /forecasts/metrics). */
export interface ForecastMetricRow {
  id: string;
  sku: string;
  strategy: string;
  strategyLabel: string;
  brand: string | null;
  segment: string | null;
  trainWmape: number | null;
  testWmape: number | null;
  /** Forecast bias as a percent (signed; +over / −under), null if no backtest. */
  bias: number | null;
  /** Symmetric MAPE as a percent, null if no backtest. */
  smape: number | null;
  band: "Good" | "Review" | "Poor" | "No metric";
  forecastTotal: number | null;
  overridden: boolean;
  cvSelected: boolean;
  allModels: AllModelRow[];
}

/** Pooled metrics for a group (segment/brand/brand×segment) or overall.
 *  Computed server-side over the held-out residual long frame — Streamlit
 *  _aggregate_metrics parity (Σ|resid|/Σactual, pooled SMAPE, pooled bias). */
export interface PooledGroup {
  key: string;
  brand?: string;
  segment?: string;
  weightedWmape: number | null;
  smape: number | null;
  weightedBias: number | null;
  volume: number | null;
  skuCount: number;
  coveragePct: number | null;
  errorContribution: number;
}

export interface PooledOverall {
  weightedWmape: number | null;
  smape: number | null;
  weightedBias: number | null;
  volume: number | null;
  skuCount: number;
  coveragePct: number | null;
}

export interface ForecastRunMetrics {
  runId: string | null;
  /** Whether this run was launched with brand reconciliation enabled. */
  reconciled: boolean;
  /** Whether a global LightGBM package was trained for this run. */
  globalTrained: boolean;
  kpis: {
    skusForecasted: number;
    medianTrainWmape: number | null;
    medianTestWmape: number | null;
    totalForecastUnits: number | null;
  };
  bands: Record<string, number>;
  skus: ForecastMetricRow[];
  /** Pooled-residual aggregates (Streamlit parity). */
  groups: {
    overall: PooledOverall;
    segment: PooledGroup[];
    brand: PooledGroup[];
    brandSegment: PooledGroup[];
  };
}

// ── Brand-level reconciliation (GET /forecasts/reconciliation) ───────────────
export interface ReconciliationPoint {
  date: ISODateString;
  bottomUp: number | null;
  topDown: number | null;
  reconciled: number | null;
}

export interface BrandReconciliation {
  brand: string;
  series: ReconciliationPoint[];
  /** Brand-level historical actuals (before the forecast horizon) — the engine's
   *  Streamlit reconciliation chart overlays history continuing into the split. */
  history?: ForecastValuePoint[];
  /** Previous-year actuals aligned to each forecast-horizon period (date − 1yr). */
  previousYear?: ForecastValuePoint[];
}

export interface ReconciliationResult {
  runId: string | null;
  brands: string[];
  reconciliation: BrandReconciliation[];
}

// ── Single-SKU Multi-Model Competition (real Streamlit single-series engine) ──
export interface SingleSkuRankingRow {
  model: string;
  trainWmape: number | null;
  trainRmse: number | null;
  testWmape: number | null;
  testRmse: number | null;
  isChampion: boolean;
}

export interface SingleSkuSeriesPoint {
  date: ISODateString;
  actual?: number | null;
  forecast?: number | null;
  lower?: number | null;
  upper?: number | null;
}

export interface SingleSkuResult {
  sku: string;
  periods: number;
  models: string[];
  championModel: string;
  errorCorrectionApplied: boolean;
  trainWmape: number | null;
  testWmape: number | null;
  ranking: SingleSkuRankingRow[];
  series: SingleSkuSeriesPoint[];
  narrative: string;
  generatedAt: ISODateString;
}

export interface RunSingleSkuPayload {
  skuId: string;
  periods: number;
  models: string[];
  datasetId?: ID;
}

/** Async job handle returned when a forecast run is kicked off. */
export interface ForecastJob {
  id: ID;
  status: ForecastJobStatus;
  progress: number;
  skuIds: ID[];
  startedAt: ISODateString;
  completedAt?: ISODateString;
  error?: string;
  /** Number of forecasts produced so far (populated as the run progresses). */
  skuCount?: number;
  /** Total forecasting-level entities the run will process. */
  total?: number;
  /** Run id once the worker assigns one. */
  runId?: string | null;
  /** Human-readable in-flight status (e.g. "Forecasting ACC-4001 (1 of 5)"). */
  message?: string;
  /** Inline result payload for jobs that carry one (e.g. scenario what-if). */
  result?: unknown;
}
