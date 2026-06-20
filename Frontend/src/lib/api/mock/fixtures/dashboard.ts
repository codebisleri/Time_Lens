import type { DashboardSummary } from "@/types/dashboard";
import { mockForecasts } from "./forecasts";

const demandTrend = (() => {
  // Merge all forecast series into a single aggregate actual/forecast trend.
  const byDate = new Map<string, { actual: number; forecast: number }>();
  for (const fc of mockForecasts.slice(0, 12)) {
    for (const p of fc.series) {
      const entry = byDate.get(p.date) ?? { actual: 0, forecast: 0 };
      entry.actual += p.actual ?? 0;
      entry.forecast += p.forecast ?? 0;
      byDate.set(p.date, entry);
    }
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({
      date,
      actual: v.actual || null,
      forecast: v.forecast || null,
    }));
})();

export const mockDashboard: DashboardSummary = {
  generatedAt: "2026-06-16T08:00:00.000Z",
  kpis: [
    {
      key: "total_skus",
      label: "Total SKUs",
      value: 48,
      format: "number",
      deltaPct: 0.063,
      spark: [40, 41, 42, 44, 44, 46, 47, 48],
    },
    {
      key: "forecast_accuracy",
      label: "Forecast Accuracy",
      value: 0.873,
      format: "percent",
      deltaPct: 0.014,
      spark: [0.84, 0.85, 0.86, 0.85, 0.87, 0.87, 0.88, 0.87],
    },
    {
      key: "revenue_impact",
      label: "Revenue Impact",
      value: 2_410_000,
      format: "currency",
      deltaPct: 0.082,
      spark: [2.0, 2.1, 2.15, 2.2, 2.3, 2.35, 2.38, 2.41],
    },
    {
      key: "inventory_value",
      label: "Inventory Value",
      value: 1_840_000,
      format: "currency",
      deltaPct: -0.021,
      spark: [1.92, 1.9, 1.88, 1.87, 1.86, 1.85, 1.85, 1.84],
    },
  ],
  demandTrend,
  topSkus: mockForecasts.slice(0, 6).map((f) => ({
    skuId: f.skuId,
    skuCode: f.skuCode,
    name: f.skuName,
    units: f.series.reduce((s, p) => s + (p.forecast ?? 0), 0),
  })),
};
