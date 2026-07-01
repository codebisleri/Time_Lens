import type { ID, ISODateString } from "./api";

export type DatasetStatus =
  | "uploading"
  | "processing"
  | "validating"
  | "ready"
  | "failed";

export type ColumnRole =
  | "date"
  | "sku"
  | "quantity"
  | "price"
  | "region"
  | "category"
  | "ignore";

/** Mapping from a source CSV column to a canonical role (upload step 2). */
export interface ColumnMapping {
  sourceColumn: string;
  role: ColumnRole;
  /** Detected source type, used to suggest a mapping. */
  detectedType?: "string" | "number" | "date";
}

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  column?: string;
  rowCount?: number;
}

/** Detected source columns for each canonical role (from the live bridge). */
export interface DetectedMapping {
  date?: string | null;
  sku?: string | null;
  sales?: string | null;
  category?: string | null;
  price?: string | null;
}

/** One future-events calendar row (Streamlit events editor schema). */
export interface FutureEvent {
  event_start_date: string;
  event_end_date: string;
  event_name: string;
  event_type: string;
  impact_pct: string;
  applies_to: string;
  notes: string;
}

/**
 * Full Data-page configuration — mirrors the Streamlit sidebar `cfg`
 * (column mapping, frequency, horizon, exogenous, events, routing thresholds,
 * missing/outlier handling, holiday country). Persisted via PATCH /datasets/{id}/config.
 */
export interface DataConfig {
  dateCol: string | null;
  dateFormat: string;
  /** strftime string used when dateFormat === "Custom..." (Streamlit's custom input). */
  dateFormatCustom?: string | null;
  skuCol: string | null;
  salesCol: string | null;
  categoryCol: string | null;
  priceCol: string | null;
  segmentCol: string | null;
  /** Profile & Route — when true, forecasts use the GENERATED segmentation and
   *  ignore the uploaded segment column; when false (or no column) the uploaded
   *  column is used if present. Drives forecastSegmentationSource on the backend. */
  useGeneratedSegmentation?: boolean;
  brandCol: string | null;
  freq: string;
  horizon: number;
  useFullHistory: boolean;
  historyStart: string | null;
  coldStartMonths: number;
  shortHistoryMonths: number;
  exogNumeric: string[];
  exogCategorical: string[];
  exogStrategy: Record<string, string>;
  missingHandling: string;
  outlierHandling: string;
  holidayCountry: string;
  futureEvents: FutureEvent[];

  // ── F.7 parity (updated Streamlit Configuration & Preparation) ──
  /** Aggregation grain the engine forecasts at. */
  forecastLevelMode: "sku" | "custom" | "overall";
  /** Group-by columns when forecastLevelMode === "custom". */
  forecastLevelCols: string[];
  /** Top-down forecasting for hard-to-forecast SKUs (3b). */
  topDownEnabled: boolean;
  /** Aggregate level(s) to forecast top-down, then disaggregate. */
  topDownLevels: string[];
  /** Which SKU classes get top-down treatment. */
  topDownApply: {
    cold: boolean;
    short: boolean;
    lumpy: boolean;
    noisy: boolean;
  };
  /** How to split an aggregate forecast back to each SKU. */
  topDownDisagg: string;
  /** Task 19 — explicit eligible-SKU allowlist (Volatile segment + WMAPE>20%) the
   *  Top-Down recommendation applies to. Empty ⇒ apply by `topDownApply` classes. */
  topDownSkus?: string[];
}

/** Data preview + schema details (GET /datasets/{id}/preview). */
export interface DatasetSchemaRow {
  column: string;
  dtype: string;
  nonNull: number;
  unique: number;
  sample: string | null;
}

export interface DatasetPreview {
  columns: string[];
  rows: Record<string, string | null>[];
  schema: DatasetSchemaRow[];
}

/** Per-forecast-level categorical attributes for the dynamic filter UI (X.Q). */
export interface LevelAttributeColumn {
  key: string;
  label: string;
}
export interface LevelAttributeEntity {
  entity: string;
  attrs: Record<string, string>;
}
export interface LevelAttributes {
  columns: LevelAttributeColumn[];
  entities: LevelAttributeEntity[];
}

export interface Dataset {
  id: ID;
  fileName: string;
  status: DatasetStatus;
  rowCount?: number;
  skuCount?: number;
  dateRange?: { start: ISODateString; end: ISODateString };
  columnMappings?: ColumnMapping[];
  issues?: ValidationIssue[];
  uploadedAt: ISODateString;

  // ── Data-preparation metadata (optional; populated by the live bridge) ──
  /** Pandas frequency code (e.g. "MS", "W"). */
  frequency?: string;
  /** Human-readable cadence (e.g. "Monthly", "Weekly"). */
  frequencyLabel?: string;
  missingValues?: number;
  duplicateRows?: number;
  invalidDates?: number;
  outlierCount?: number;
  /** All source column names. */
  columns?: string[];
  detectedMapping?: DetectedMapping;
  /** Persisted Data-page configuration (live bridge). */
  config?: DataConfig;
}

/** Result returned after a file finishes parsing/validation. */
export interface UploadResult {
  dataset: Dataset;
  previewRows: Record<string, string>[];
  issues: ValidationIssue[];
}

/** Forecasting/global settings edited on the Data & Settings page. */
export interface ForecastSettings {
  defaultHorizon: "weekly" | "monthly" | "quarterly";
  defaultModel: string;
  confidenceLevel: number;
  /** How history is aggregated before modeling. */
  aggregation: "sum" | "average";
  outlierHandling: "none" | "clip" | "remove";
  currency: string;
  fiscalYearStartMonth: number;
}
