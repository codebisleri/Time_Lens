import type { ID, ISODateString, ListParams } from "./api";
import type { ForecastPoint, ForecastHorizon } from "./forecast";

export type ScenarioStatus = "draft" | "active" | "archived";
export type LeverType =
  | "price_change"
  | "promotion"
  | "demand_uplift"
  | "seasonality"
  | "market_growth"
  | "supply_constraint";

/** A single adjustable assumption applied on top of a baseline forecast. */
export interface AssumptionLever {
  id: ID;
  type: LeverType;
  label: string;
  /** Percentage (-1..n) or absolute value depending on lever type. */
  value: number;
  unit: "percent" | "absolute";
  /** Optional window the lever applies to. */
  effectiveFrom?: ISODateString;
  effectiveTo?: ISODateString;
  /** Restrict the lever to a subset of SKUs/categories; empty = all. */
  appliesTo?: ID[];
}

export interface Scenario {
  id: ID;
  name: string;
  description?: string;
  status: ScenarioStatus;
  horizon: ForecastHorizon;
  /** Baseline forecast this scenario is derived from. */
  baselineForecastId?: ID;
  levers: AssumptionLever[];
  /** Resulting adjusted series (computed by the backend scenario engine). */
  projectedSeries?: ForecastPoint[];
  /** Headline rollups for cards/comparison. */
  summary?: ScenarioSummaryMetrics;
  createdBy?: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface ScenarioSummaryMetrics {
  totalProjectedUnits: number;
  totalProjectedRevenue?: number;
  /** Delta vs baseline, as a fraction. */
  unitsDeltaPct?: number;
  revenueDeltaPct?: number;
}

/** Trimmed row for scenario lists. */
export interface ScenarioSummary {
  id: ID;
  name: string;
  status: ScenarioStatus;
  horizon: ForecastHorizon;
  leverCount: number;
  unitsDeltaPct?: number;
  updatedAt: ISODateString;
}

export interface ScenarioListParams extends ListParams {
  status?: ScenarioStatus;
}

export interface CreateScenarioPayload {
  name: string;
  description?: string;
  horizon: ForecastHorizon;
  baselineForecastId?: ID;
  levers: Omit<AssumptionLever, "id">[];
}

export interface UpdateScenarioPayload {
  name?: string;
  description?: string;
  status?: ScenarioStatus;
  levers?: AssumptionLever[];
}
