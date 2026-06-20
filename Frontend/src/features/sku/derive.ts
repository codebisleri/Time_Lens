import type { ForecastModel } from "@/types/forecast";
import type { Sku, SkuStatus } from "@/types/sku";

/**
 * Presentation-layer derivations for the SKU table and drawer.
 *
 * The `Sku` contract (and its mock fixtures) doesn't yet carry a forecast
 * method or a last-forecast timestamp, but the catalog UI needs to surface
 * both. Rather than mutate the shared type / fixtures / service, we derive
 * these fields deterministically from stable SKU data so the same SKU always
 * shows the same values. When the backend adds real fields, swap these helpers
 * for direct reads — the table/columns API stays unchanged.
 */

const FORECAST_MODELS: ForecastModel[] = [
  "arima",
  "prophet",
  "ets",
  "moving_average",
  "ensemble",
];

const FORECAST_MODEL_LABELS: Record<ForecastModel, string> = {
  arima: "ARIMA",
  prophet: "Prophet",
  ets: "ETS",
  moving_average: "Moving Average",
  ensemble: "Ensemble",
};

/** Stable small hash of a string, used to pick deterministic derived values. */
function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (h * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function forecastModelLabel(model: ForecastModel): string {
  return FORECAST_MODEL_LABELS[model];
}

/** Deterministic forecast model for a SKU; null when no forecast exists. */
export function deriveForecastModel(sku: Sku): ForecastModel | null {
  if (!sku.hasForecast) return null;
  return FORECAST_MODELS[hash(sku.id) % FORECAST_MODELS.length] ?? "arima";
}

/** Deterministic "last forecast" timestamp; null when no forecast exists. */
export function deriveLastForecastDate(sku: Sku): string | null {
  if (!sku.hasForecast) return null;
  // Offset a few days before the SKU's update time so the two read distinctly.
  const updated = new Date(sku.updatedAt).getTime();
  const offsetDays = (hash(sku.code) % 14) + 1;
  return new Date(updated - offsetDays * 24 * 60 * 60 * 1000).toISOString();
}

/** A SKU enriched with the derived presentation fields used by the catalog UI. */
export interface SkuRow extends Sku {
  forecastModel: ForecastModel | null;
  forecastMethodLabel: string;
  lastForecastDate: string | null;
}

export function toSkuRow(sku: Sku): SkuRow {
  const forecastModel = deriveForecastModel(sku);
  return {
    ...sku,
    forecastModel,
    forecastMethodLabel: forecastModel
      ? forecastModelLabel(forecastModel)
      : "—",
    lastForecastDate: deriveLastForecastDate(sku),
  };
}

/** Badge variant per SKU status, shared by table cells and the drawer. */
export const SKU_STATUS_VARIANT: Record<
  SkuStatus,
  "success" | "secondary" | "warning" | "default"
> = {
  active: "success",
  inactive: "secondary",
  discontinued: "warning",
  new: "default",
};
