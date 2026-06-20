"use client";

import { useAsync } from "@/lib/hooks";
import { forecastService } from "@/lib/api/services";
import type { ForecastDetail } from "@/types/forecast";

/**
 * Loads a single forecast's full detail (series + in-sample fit + test
 * prediction + metrics) for the detail drawer / drill-down, exercising the real
 * loading state / skeleton. Returns null when no forecast is open.
 */
export function useForecastDetail(forecastId: string | null) {
  return useAsync<ForecastDetail | null>(async () => {
    if (!forecastId) return null;
    return forecastService.getById(forecastId);
  }, [forecastId]);
}
