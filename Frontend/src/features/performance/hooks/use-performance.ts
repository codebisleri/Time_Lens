"use client";

import { useAsync } from "@/lib/hooks";
import { forecastService } from "@/lib/api/services";
import type { ForecastRunMetrics } from "@/types/forecast";

/**
 * Loads the run-level forecast metrics (per-SKU WMAPE bands, brand/segment,
 * volume, strategy) in a single call — the foundation for the Performance tab's
 * pooled diagnostics. Per-SKU backtest series are fetched lazily in the drill-down.
 */
export function usePerformance() {
  return useAsync<ForecastRunMetrics>(() => forecastService.metrics(), []);
}
