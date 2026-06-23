/** Retail segmentation payloads (backend `/segmentation*`). */
export type SegmentGroup = "matrix" | "lifecycle" | "triage";

/** Per-segment model-architecture recipe (drives the Segment Model Architecture cards). */
export interface SegmentArchitecture {
  primary: string;
  primaryKey: string;
  blend: string[];
  blendMethod: string | null;
  features: string[];
  residualBooster: string | null;
  ciSource: string | null;
  reconcile: string | null;
  tagline: string | null;
}

export interface SegmentSummary {
  segment: string;
  group: SegmentGroup;
  skuCount: number;
  revenueSharePct: number | null;
  priority: string | null;
  strategy: string | null;
  forecast: string | null;
  safetyStock: string | null;
  color: string | null;
  recommendedModel: string;
  architecture: SegmentArchitecture;
}

export interface SegmentedSku {
  sku: string;
  segment: string;
  volatility: string;
  contribution: string;
  intermittency: string;
  cv: number | null;
  meanSales: number | null;
  totalRevenue: number | null;
  nPeriods: number;
  revenueSharePct: number | null;
  brand: string | null;
}

export interface BrandBreakdown {
  brand: string;
  skuCount: number;
  revenueSharePct: number | null;
}

export interface SegmentationParams {
  cv_threshold: number;
  high_cum_share: number;
  mid_cum_share: number;
  min_periods: number;
  new_product_months: number;
  churn_months: number;
  short_history_months: number;
}

/** Threshold-knob overrides sent to the backend (camelCase query/body keys). */
export interface SegmentationThresholds {
  highCumShare?: number;
  midCumShare?: number;
  minPeriods?: number;
  newProductMonths?: number;
  churnMonths?: number;
  shortHistoryMonths?: number;
}

/** Brand × Segment crosstab — counts of SKUs per brand per segment. */
export interface BrandSegmentMatrix {
  segments: string[];
  brands: string[];
  counts: number[][];
  rowTotals: number[];
  colTotals: number[];
}

export interface StrategyDistItem {
  strategy: string;
  label: string;
  family: string | null;
  count: number;
  color: string;
}

export interface IntermittencyDistItem {
  pattern: string;
  count: number;
  color: string;
}

export interface SegmentationResult {
  datasetId: string;
  params: SegmentationParams;
  totalSkus: number;
  revenueBasis: "revenue" | "volume";
  segments: SegmentSummary[];
  skus: SegmentedSku[];
  brands: BrandBreakdown[];
  brandSegmentMatrix: BrandSegmentMatrix | null;
  strategyDistribution: StrategyDistItem[];
  intermittencyDistribution: IntermittencyDistItem[];
  /** Routing KPI counts computed server-side over ALL profiled SKUs (Streamlit
   *  render_profiling_tab parity). The UI renders these verbatim — no client
   *  re-aggregation over a paginated/capped SKU list. */
  routing: RoutingSummary;
  generatedAt: string;
  runId?: string | null;
}

export interface RoutingSummary {
  skusProfiled: number;
  coldStart: number;
  shortHistory: number;
  intermittentLumpy: number;
  brands: number;
}

/** Validate & Save payload for `POST /segmentation/run`. */
export interface SegmentationRunPayload extends SegmentationThresholds {
  datasetId?: string;
  validatedBy?: string;
  notes?: string;
  /** Phase X.D · Task 3 — performance metric (numeric column) for contribution.
   *  Forward-compatible: the current backend auto-detects the column and ignores
   *  this key, so no API contract changes. */
  metricColumn?: string;
}

export interface SegmentationRun {
  runId: string;
  runAt: string;
  nSkus: number;
  validatedBy: string | null;
  notes: string | null;
  datasetFingerprint: string | null;
}

export interface SegmentTraceStep {
  step: number;
  name: string;
  detail: string;
  verdict: string;
  outcome: string | null;
  stop: boolean;
}

export interface SegmentTrace {
  sku: string;
  final: string | null;
  steps: SegmentTraceStep[];
}
