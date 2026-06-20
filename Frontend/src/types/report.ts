import type { ID, ISODateString, ListParams } from "./api";

export type ReportType =
  | "forecast_summary"
  | "accuracy"
  | "scenario_comparison"
  | "demand_plan"
  | "inventory_outlook";

export type ReportStatus = "generating" | "ready" | "failed";
export type ExportFormat = "pdf" | "xlsx" | "csv";

export interface Report {
  id: ID;
  name: string;
  type: ReportType;
  status: ReportStatus;
  /** Parameters the report was generated with (date range, SKUs, scenario...). */
  params?: Record<string, unknown>;
  generatedAt?: ISODateString;
  createdAt: ISODateString;
  fileUrl?: string;
}

export interface ReportListParams extends ListParams {
  type?: ReportType;
  status?: ReportStatus;
}

export interface GenerateReportPayload {
  name: string;
  type: ReportType;
  params?: Record<string, unknown>;
  format: ExportFormat;
}

// ── Live Report hub (Phase E) — mirrors Backend/api.py /reports* ───────────────
export type ReportKind = "segmentation" | "routed_forecast";

/** One generatable report and whether the current state allows it. */
export interface ReportCatalogItem {
  type: ReportKind;
  title: string;
  available: boolean;
  reason: string;
}

/** A persisted, generated report (history row / generate response). */
export interface GeneratedReport {
  id: ID;
  datasetId: string;
  type: ReportKind;
  title: string;
  status: "ready" | "generating" | "failed";
  sizeBytes: number | null;
  generatedAt: ISODateString;
}

export interface ReportOpportunity {
  sku: string;
  name: string;
  strategy: string | null;
  wmape: number | null;
  band: string;
  forecastTotal: number | null;
}

/** Executive dashboard payload for GET /reports/summary. */
export interface ReportSummary {
  dataset: {
    id: string;
    name: string | null;
    skuCount: number | null;
    rowCount: number | null;
    dateStart: string | null;
    dateEnd: string | null;
  };
  forecast: {
    runId: string | null;
    skusForecasted: number;
    medianTestWmape: number | null;
    totalForecastUnits: number | null;
    bands: Record<string, number>;
  };
  segments: {
    total: number;
    distribution: { segment: string; skuCount: number }[];
  };
  topOpportunities: ReportOpportunity[];
  availableReports: ReportCatalogItem[];
}

export interface GenerateLiveReportPayload {
  type: ReportKind;
  datasetId?: string;
}
