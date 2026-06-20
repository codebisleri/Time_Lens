/**
 * Forecast Submission domain types — mirror the live backend contract
 * (Backend/api.py `/forecasts/submission*`, camelCase) one-to-one. The backend
 * worksheet is a long-format SKU × forecast-month frame the planner edits.
 */

/** One editable worksheet row (a single SKU in a single forecast month). */
export interface SubmissionRow {
  id: string;
  sku: string;
  forecastMonth: string; // ISO date (month-end)
  productName: string;
  category: string;
  brand: string;
  segment: string;
  strategy: string;
  mape: number | null; // backtest WMAPE, already a percentage (e.g. 15.3)
  modelForecast: number; // immutable model output
  submittedForecast: number; // planner-edited value (defaults to modelForecast)
  lastYearSameMonth: number | null; // YoY anchor
  last3moAvg: number | null; // MoM anchor for the first month
  momPct: number | null; // % vs previous submitted month (or last3moAvg)
  yoyPct: number | null; // % vs same calendar month last year
  deltaVsModelPct: number | null; // % the edit differs from the model
  reason: string; // one of reasonOptions
  notes: string;
}

/** Aggregate metrics over the rows in scope (filtered view). */
export interface SubmissionKpis {
  modelUnits: number;
  submittedUnits: number;
  deltaUnits: number;
  deltaPct: number;
  avgMomPct: number | null;
  avgYoyPct: number | null;
  overrideCells: number;
  overrideSkus: number;
  skuCount: number;
  rowCount: number;
}

/** Distinct values for the cascading filters, computed over the full run. */
export interface SubmissionFacets {
  categories: string[];
  brands: string[];
  products: string[];
  segments: string[];
  skus: string[];
}

/** Response of GET /forecasts/submission. */
export interface SubmissionResponse {
  datasetId: string;
  runId: string | null;
  rows: SubmissionRow[];
  kpis: SubmissionKpis;
  reasonOptions: string[];
  totalRows: number;
  totalSkus: number;
  filteredRows: number;
  facets: SubmissionFacets;
}

/** Per-cell edit sent to PATCH /forecasts/submission. */
export interface SubmissionEdit {
  id: string;
  submittedForecast?: number;
  reason?: string;
  notes?: string;
}

export type SubmissionBulkOp = "uplift" | "copy_ly" | "reset" | "reason";

/** Bulk operation applied to every row matching the active filter. */
export interface SubmissionBulk {
  op: SubmissionBulkOp;
  value?: number; // uplift %
  reason?: string; // for the "reason" op
}

/** Query params accepted by GET /forecasts/submission and the bulk filter. */
export interface SubmissionFilterParams {
  datasetId?: string;
  category?: string; // comma-separated
  brand?: string;
  product?: string;
  segment?: string;
  sku?: string;
  overriddenOnly?: boolean;
  wmapeThreshold?: number;
}

export interface SubmissionPatchPayload {
  datasetId?: string;
  edits?: SubmissionEdit[];
  bulk?: SubmissionBulk;
  filter?: SubmissionFilterParams;
}

export interface SubmissionPatchResponse {
  runId: string;
  updated: number;
  kpis: SubmissionKpis;
}

export interface SubmitPayload {
  datasetId?: string;
  submitter: string;
  notes?: string;
}

/** A persisted submission batch (one planner submit) — drives the audit trail. */
export interface SubmissionBatch {
  id: string;
  datasetId: string;
  runId: string;
  submittedAt: string;
  submitter: string;
  notes: string;
  overrideCount: number;
  totalRows: number;
  totalUnits: number;
  pctChange: number;
}

/** Client-side filter UI state (multi-select aware). */
export interface SubmissionFilterState {
  category: string[];
  brand: string[];
  product: string[];
  segment: string[];
  sku: string[];
  overriddenOnly: boolean;
  wmapeThreshold: number;
}

export const EMPTY_SUBMISSION_FILTERS: SubmissionFilterState = {
  category: [],
  brand: [],
  product: [],
  segment: [],
  sku: [],
  overriddenOnly: false,
  wmapeThreshold: 0,
};
