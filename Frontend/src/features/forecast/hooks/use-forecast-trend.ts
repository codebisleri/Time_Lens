"use client";

import { useAsync } from "@/lib/hooks";
import { forecastService } from "@/lib/api/services";

/** Aggregate demand point: actuals (history) handing off to forecast + band.
 *  Optional `fit` (in-sample model fit over history) and `testPred` (hold-out /
 *  validation prediction over the backtest window) overlays power the Streamlit
 *  drill-down chart; they are null on points where the engine has no value. */
export interface ForecastBandPoint {
  date: string;
  actual: number | null;
  forecast: number | null;
  lower: number | null;
  upper: number | null;
  fit?: number | null;
  testPred?: number | null;
}

/** How many forecasts to aggregate into the portfolio trend (bounds the work). */
const TREND_SAMPLE_SIZE = 16;

/**
 * Builds the hero "portfolio demand" trend: historical actuals, forecast, and a
 * confidence band, aggregated pointwise across a bounded sample of forecasts.
 * The mock series share an aligned weekly date axis, so summation is exact.
 */
export function useForecastTrend() {
  return useAsync<ForecastBandPoint[]>(async () => {
    const summaries = await forecastService.list({ page: 1, pageSize: 500 });
    const ids = summaries.items.slice(0, TREND_SAMPLE_SIZE).map((f) => f.id);
    if (ids.length === 0) return [];

    const forecasts = await Promise.all(
      ids.map((id) => forecastService.getById(id)),
    );

    // Sum every series pointwise, keyed by date so axes always align.
    const byDate = new Map<string, ForecastBandPoint>();
    for (const forecast of forecasts) {
      for (const point of forecast.series) {
        const acc =
          byDate.get(point.date) ??
          { date: point.date, actual: null, forecast: null, lower: null, upper: null };
        if (point.actual != null) acc.actual = (acc.actual ?? 0) + point.actual;
        if (point.forecast != null)
          acc.forecast = (acc.forecast ?? 0) + point.forecast;
        if (point.lowerBound != null)
          acc.lower = (acc.lower ?? 0) + point.lowerBound;
        if (point.upperBound != null)
          acc.upper = (acc.upper ?? 0) + point.upperBound;
        byDate.set(point.date, acc);
      }
    }

    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, []);
}
