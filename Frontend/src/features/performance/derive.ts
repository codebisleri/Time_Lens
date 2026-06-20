import type { ForecastMetricRow, PooledGroup } from "@/types/forecast";

/**
 * Performance helpers. Group/overall accuracy is computed SERVER-SIDE as pooled
 * residual metrics (Σ|resid|/Σactual, pooled SMAPE, pooled bias) — Streamlit
 * _aggregate_metrics parity — and arrives via ForecastRunMetrics.groups. These
 * helpers only adapt the pooled groups for display and provide per-SKU helpers
 * (SKU-level WMAPE is already exact, no pooling needed).
 */

export const WMAPE_GOOD = 20;
export const WMAPE_POOR = 50;

export type Tone = "success" | "warning" | "destructive" | "muted";

/** Traffic-light tone for a WMAPE value (green <20, amber ≤50, red >50). */
export function wmapeTone(w: number | null | undefined): Tone {
  if (w == null || !Number.isFinite(w)) return "muted";
  if (w < WMAPE_GOOD) return "success";
  if (w <= WMAPE_POOR) return "warning";
  return "destructive";
}

export function bandTone(band: string): Tone {
  switch (band) {
    case "Good":
      return "success";
    case "Review":
      return "warning";
    case "Poor":
      return "destructive";
    default:
      return "muted";
  }
}

/** Held-out volume of a SKU row (forecast total is the only per-SKU volume the
 *  rows carry; used for the SKU scatter/table sizing only, not group metrics). */
export function vol(r: ForecastMetricRow): number {
  return r.forecastTotal != null && Number.isFinite(r.forecastTotal)
    ? Math.max(0, r.forecastTotal)
    : 0;
}

export interface GroupPerf {
  key: string;
  weightedWmape: number | null;
  smape: number | null;
  weightedBias: number | null;
  skuCount: number;
  volume: number;
  coveragePct: number;
  /** Pooled volume × WMAPE — how much this group drives total error. */
  errorContribution: number;
}

/** Adapt a server-side pooled group to the display shape. */
export function toGroupPerf(g: PooledGroup): GroupPerf {
  return {
    key: g.key,
    weightedWmape: g.weightedWmape,
    smape: g.smape,
    weightedBias: g.weightedBias,
    skuCount: g.skuCount,
    volume: g.volume ?? 0,
    coveragePct: g.coveragePct ?? 0,
    errorContribution: g.errorContribution,
  };
}

/** Per-SKU error contribution (volume × WMAPE), used to rank tables/drill-downs. */
export function errorContribution(r: ForecastMetricRow): number {
  if (r.testWmape == null || !Number.isFinite(r.testWmape)) return 0;
  return (vol(r) * r.testWmape) / 100;
}

/** Champion's symmetric MAPE for a SKU (per-SKU drill-down only). */
export function championSmape(r: ForecastMetricRow): number | null {
  const champ = r.allModels.find((m) => m.isChampion);
  return champ?.testSmape ?? null;
}

export function brandOf(r: ForecastMetricRow): string {
  return r.brand || "—";
}
export function segmentOf(r: ForecastMetricRow): string {
  return r.segment || "—";
}
