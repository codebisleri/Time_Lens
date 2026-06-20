import type { Forecast, ForecastSummary } from "@/types/forecast";
import { mockSkus } from "./skus";
import { makeSeries } from "./series";

const models = ["arima", "prophet", "ets", "ensemble"] as const;

export const mockForecasts: Forecast[] = mockSkus
  .filter((s) => s.hasForecast)
  .map((sku, i) => {
    const series = makeSeries({
      history: 26,
      horizon: 13,
      base: 120 + (i % 9) * 25,
      trend: 0.4 + (i % 5) * 0.2,
    });
    const accuracy = sku.forecastAccuracy ?? 0.85;
    return {
      id: `fc_${String(i + 1).padStart(3, "0")}`,
      skuId: sku.id,
      skuCode: sku.code,
      skuName: sku.name,
      horizon: "weekly",
      model: models[i % models.length]!,
      generatedAt: "2026-06-12T08:00:00.000Z",
      periodStart: series[0]!.date,
      periodEnd: series[series.length - 1]!.date,
      series,
      metrics: {
        accuracy,
        mape: Number((1 - accuracy).toFixed(3)),
        rmse: 12 + (i % 7),
        mae: 9 + (i % 5),
        bias: ((i % 5) - 2) / 10,
      },
    } satisfies Forecast;
  });

export const mockForecastSummaries: ForecastSummary[] = mockForecasts.map(
  (f) => ({
    id: f.id,
    skuId: f.skuId,
    skuCode: f.skuCode,
    skuName: f.skuName,
    horizon: f.horizon,
    model: f.model,
    accuracy: f.metrics.accuracy,
    totalForecastUnits: f.series.reduce((sum, p) => sum + (p.forecast ?? 0), 0),
    generatedAt: f.generatedAt,
  }),
);
