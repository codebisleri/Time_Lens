"use client";

import { useAsync } from "@/lib/hooks";
import { skuService, forecastService } from "@/lib/api/services";

export interface CategoryDatum {
  category: string;
  units: number;
}

/**
 * Forecast volume aggregated by category for the Category Performance chart.
 * Joins SKUs (sku → category) with forecast summaries (sku → units) using
 * existing services. No fixtures or services modified.
 */
export function useCategoryPerformance() {
  return useAsync<CategoryDatum[]>(async () => {
    const [skus, forecasts] = await Promise.all([
      skuService.list({ pageSize: 200 }),
      forecastService.list({ pageSize: 200 }),
    ]);

    const categoryBySku = new Map(skus.items.map((s) => [s.id, s.category]));
    const totals = new Map<string, number>();

    for (const f of forecasts.items) {
      const category = categoryBySku.get(f.skuId);
      if (!category) continue;
      totals.set(category, (totals.get(category) ?? 0) + f.totalForecastUnits);
    }

    return [...totals.entries()]
      .map(([category, units]) => ({ category, units }))
      .sort((a, b) => b.units - a.units);
  }, []);
}
