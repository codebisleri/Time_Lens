import type { ISODateString } from "./api";
import type { TimeSeriesDatum } from "./chart";

/** KPI tile shown on the Dashboard. */
export interface KpiMetric {
  key: string;
  label: string;
  value: number;
  format: "number" | "currency" | "percent" | "compact";
  /** Period-over-period change as a fraction; drives the up/down chip. */
  deltaPct?: number;
  /** Tiny sparkline series for the tile. */
  spark?: number[];
}

export interface DashboardSummary {
  generatedAt: ISODateString;
  kpis: KpiMetric[];
  /** Aggregate demand: actual + forecast over time. */
  demandTrend: TimeSeriesDatum[];
  /** Top SKUs by forecast volume, for the leaderboard widget. */
  topSkus: { skuId: string; skuCode: string; name: string; units: number }[];
}
