import type { ID, ISODateString, ListParams } from "./api";

export type SkuStatus = "active" | "inactive" | "discontinued" | "new";

/** Intermittent-demand class (SBC) surfaced by the Profile & Route workflow. */
export type DemandPattern =
  | "smooth"
  | "erratic"
  | "intermittent"
  | "lumpy"
  | "dead";

export type VolatilityBand = "low" | "medium" | "high";
export type AbcClass = "A" | "B" | "C";

export interface Sku {
  id: ID;
  code: string;
  name: string;
  category: string;
  subCategory?: string;
  brand?: string;
  status: SkuStatus;
  /** Selling location / store grouping the SKU belongs to. */
  region?: string;
  unitCost?: number;
  unitPrice?: number;
  leadTimeDays?: number;
  /** Latest forecast accuracy (e.g. 1 - MAPE), 0–1. */
  forecastAccuracy?: number;
  /** Whether a forecast currently exists for this SKU. */
  hasForecast: boolean;
  updatedAt: ISODateString;

  // ── Profile & Route enrichment (optional; populated by the live bridge) ──
  /** SBC demand pattern: smooth / erratic / intermittent / lumpy / dead. */
  demandPattern?: DemandPattern;
  volatility?: VolatilityBand;
  /** Coefficient of variation of demand. */
  cv?: number;
  /** Average demand interval (intermittency). */
  adi?: number;
  meanSales?: number;
  nMonths?: number;
  /** Raw engine strategy label (e.g. "croston_sba"). */
  recommendedStrategy?: string;
  /** Human-readable strategy label (e.g. "Croston / SBA"). */
  recommendedStrategyLabel?: string;
  /** Algorithm family for grouping (e.g. "Croston", "SARIMAX", "Ensemble"). */
  strategyFamily?: string;
  isColdStart?: boolean;
  isShortHistory?: boolean;
  /** Pareto class from cumulative revenue share. */
  abcClass?: AbcClass;
  /** Share of total (proxied) revenue, 0–100. */
  revenueSharePct?: number;
}

export interface SkuListParams extends ListParams {
  status?: SkuStatus;
  category?: string;
  region?: string;
  hasForecast?: boolean;
}

export interface SkuUpdatePayload {
  name?: string;
  category?: string;
  status?: SkuStatus;
  unitCost?: number;
  unitPrice?: number;
  leadTimeDays?: number;
}

/** Bulk operations from the SKU Management table. */
export interface SkuBulkActionPayload {
  skuIds: ID[];
  action: "activate" | "deactivate" | "discontinue" | "delete";
}
