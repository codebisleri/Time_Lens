import type {
  Forecast,
  ForecastModel,
  ForecastSummary,
} from "@/types/forecast";

/**
 * Presentation-layer derivations for Forecast Results.
 *
 * The `ForecastSummary` contract carries forecast units and accuracy but not a
 * category, an actual-vs-forecast variance, or a health status — all of which
 * the analytics table/drawer need. Rather than mutate the shared types,
 * fixtures, or services, we derive these deterministically (same forecast →
 * same values) by joining with the SKU catalog for category and synthesizing a
 * stable variance from the known accuracy. Swap for real backend fields later;
 * the table/columns API stays unchanged.
 */

export type ForecastHealth = "healthy" | "warning" | "needs_review";

export const FORECAST_HEALTH_LABELS: Record<ForecastHealth, string> = {
  healthy: "Healthy",
  warning: "Warning",
  needs_review: "Needs Review",
};

export const FORECAST_HEALTH_VARIANT: Record<
  ForecastHealth,
  "success" | "warning" | "destructive"
> = {
  healthy: "success",
  warning: "warning",
  needs_review: "destructive",
};

const FORECAST_MODEL_LABELS: Record<ForecastModel, string> = {
  arima: "ARIMA",
  prophet: "Prophet",
  ets: "ETS",
  moving_average: "Moving Average",
  ensemble: "Ensemble",
};

export function forecastModelLabel(model: ForecastModel): string {
  return FORECAST_MODEL_LABELS[model];
}

/** Stable small hash, used to pick a deterministic variance direction. */
function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (h * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function healthFromAccuracy(accuracy: number): ForecastHealth {
  if (accuracy >= 0.9) return "healthy";
  if (accuracy >= 0.8) return "warning";
  return "needs_review";
}

/** A forecast summary enriched with the analytics fields the catalog UI needs. */
export interface ForecastResultRow {
  id: string;
  skuId: string;
  skuCode: string;
  skuName: string;
  category: string;
  model: ForecastModel;
  modelLabel: string;
  horizon: ForecastSummary["horizon"];
  forecastUnits: number;
  actualUnits: number;
  varianceUnits: number;
  /** Signed variance as a fraction of forecast (actual − forecast) / forecast. */
  variancePct: number;
  accuracy: number;
  status: ForecastHealth;
  generatedAt: string;
}

export function toForecastResultRow(
  summary: ForecastSummary,
  category: string,
): ForecastResultRow {
  const accuracy = summary.accuracy ?? 0.85;
  const mape = Math.max(0, 1 - accuracy);
  const forecastUnits = Math.round(summary.totalForecastUnits);

  // Direction of the miss is stable per forecast; magnitude tracks the error.
  const sign = hash(summary.id) % 2 === 0 ? 1 : -1;
  const variancePct = sign * mape;
  const actualUnits = Math.round(forecastUnits * (1 + variancePct));
  const varianceUnits = actualUnits - forecastUnits;

  return {
    id: summary.id,
    skuId: summary.skuId,
    skuCode: summary.skuCode,
    skuName: summary.skuName,
    category,
    model: summary.model,
    modelLabel: forecastModelLabel(summary.model),
    horizon: summary.horizon,
    forecastUnits,
    actualUnits,
    varianceUnits,
    variancePct,
    accuracy,
    status: healthFromAccuracy(accuracy),
    generatedAt: summary.generatedAt,
  };
}

/** Bias from a fully-loaded forecast, used by the detail drawer. */
export function forecastBias(forecast: Forecast): number | undefined {
  return forecast.metrics.bias;
}
