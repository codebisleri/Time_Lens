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
  /** Apply a DoWhy causal estimate (ATE) directly to the baseline (parity with
   *  render_whatif_tab's "Apply causal estimate from DoWhy" option). */
  causalAte?: number;
}

// ── Causal Effect Estimation (DoWhy) — parity with render_causal_tab ──────────
export interface CausalFeaturesResponse {
  available: boolean; // DoWhy + graphviz installed
  columns: string[]; // candidate treatments / confounders ("potential")
  outcome: string | null;
  exogAccountedFor: string[];
  message: string;
}

export interface CausalEstimateRow {
  Treatment: string;
  "Causal Estimate": number | null;
  "Causal Effect (per +1 unit)": number | null;
  "Elasticity (% per +1%)": number | null;
  Robustness: string;
  Interpretation: string;
  reliabilityLevel: "success" | "info" | "warning";
  reliabilityHead: string;
  reliabilityExpl: string;
}

export interface CausalMethodRow {
  Treatment: string;
  Method: string;
  "Causal Effect": number | null;
  "CI low": number | null;
  "CI high": number | null;
  "p-value": number | null;
  Note: string;
}

export interface CausalRefutationRow {
  Treatment: string;
  Refuter: string;
  "Refuted effect": number | null;
  Verdict: string;
  "p-value": number | null;
}

export interface CausalRunResult {
  sku: string;
  outcome: string;
  potential: string[];
  exogAccountedFor: string[];
  estimates: CausalEstimateRow[];
  methodComparison: CausalMethodRow[];
  refutation: CausalRefutationRow[];
  estimands: Record<string, string>;
  dotGraph: string;
  variables: {
    treatments: string[];
    outcome: string;
    confounders: string[];
    instruments: string[];
    effect_modifiers: string[];
  };
  generatedAt: ISODateString;
}

export interface RunCausalPayload {
  skuId: string;
  treatments: string[];
  confounders?: string[];
  instruments?: string[];
  effectModifiers?: string[];
  methods?: string[];
  refuters?: string[];
  computeCi?: boolean;
  datasetId?: ID;
}

export interface DriverRow {
  Lever: string;
  "Impact on demand": number | null;
}

export interface DriversResult {
  sku: string;
  outcome: string;
  ranked: DriverRow[];
  generatedAt: ISODateString;
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
