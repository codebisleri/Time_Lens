"use client";

import { useAsync } from "@/lib/hooks";
import { forecastService, skuService } from "@/lib/api/services";
import { toForecastResultRow, type ForecastResultRow } from "../derive";

/**
 * Loads the forecast results catalog: forecast summaries joined with the SKU
 * catalog (for category) and enriched with derived variance / status. Resolves
 * the whole set so the table runs search / filter / sort / paginate
 * client-side. When the backend scales, lift these to server params.
 */
export function useForecastResults() {
  return useAsync<ForecastResultRow[]>(async () => {
    const [forecasts, skus] = await Promise.all([
      forecastService.list({ page: 1, pageSize: 500 }),
      skuService.list({ page: 1, pageSize: 500 }),
    ]);

    const categoryBySku = new Map(skus.items.map((s) => [s.id, s.category]));

    return forecasts.items.map((summary) =>
      toForecastResultRow(summary, categoryBySku.get(summary.skuId) ?? "—"),
    );
  }, []);
}
