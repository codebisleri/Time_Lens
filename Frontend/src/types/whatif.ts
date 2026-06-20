/**
 * Scenario Planning (What-If) — mirrors the Streamlit render_whatif_tab contract.
 * A scenario adjusts exogenous features over a date range and re-forecasts with
 * the SKU's fitted base model (Prophet / AutoARIMA / SARIMAX).
 */
import type { ID, ISODateString } from "./api";

export type WhatIfChangeType =
  | "Percentage Change"
  | "Constant Change"
  | "Set to New Value";

export interface ScenarioAdjustment {
  feature: string;
  type: WhatIfChangeType;
  value: number;
}

export interface ScenarioSeriesPoint {
  date: ISODateString;
  baseline: number | null;
  scenario?: number | null;
}

export interface ScenarioRunResult {
  sku: string;
  championModel: string;
  /** True when a scenario re-forecast was produced; false → see `message`. */
  supported: boolean;
  message: string;
  changeTypes: WhatIfChangeType[];
  availableFeatures: string[];
  appliedAdjustments: ScenarioAdjustment[];
  baselineTotal: number;
  scenarioTotal: number | null;
  deltaUnits: number | null;
  changePct: number | null;
  series: ScenarioSeriesPoint[];
  generatedAt: ISODateString;
}

export interface RunScenarioPayload {
  skuId: string;
  periods?: number;
  models?: string[];
  adjustments?: ScenarioAdjustment[];
  start?: string;
  end?: string;
  datasetId?: ID;
}

export interface SavedScenarioRow {
  id: ID;
  name: string;
  sku: string;
  createdAt: ISODateString;
  changePct: number | null;
  championModel: string | null;
}

export interface ScenarioDetail {
  id: ID;
  datasetId: string;
  name: string;
  sku: string;
  adjustments: ScenarioAdjustment[];
  result: ScenarioRunResult;
  createdAt: ISODateString;
}
