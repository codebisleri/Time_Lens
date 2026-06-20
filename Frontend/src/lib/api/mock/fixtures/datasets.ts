import type { Dataset, ForecastSettings } from "@/types/dataset";

export const mockDatasets: Dataset[] = [
  {
    id: "ds_001",
    fileName: "sales_history_2024_2025.csv",
    status: "ready",
    rowCount: 184_320,
    skuCount: 48,
    dateRange: { start: "2024-01-01T00:00:00.000Z", end: "2025-12-31T00:00:00.000Z" },
    columnMappings: [
      { sourceColumn: "date", role: "date", detectedType: "date" },
      { sourceColumn: "sku_code", role: "sku", detectedType: "string" },
      { sourceColumn: "units_sold", role: "quantity", detectedType: "number" },
      { sourceColumn: "store", role: "region", detectedType: "string" },
    ],
    issues: [
      {
        severity: "warning",
        code: "MISSING_VALUES",
        message: "412 rows have empty quantity and were treated as zero.",
        column: "units_sold",
        rowCount: 412,
      },
    ],
    uploadedAt: "2026-05-30T10:12:00.000Z",
  },
];

export const mockSettings: ForecastSettings = {
  defaultHorizon: "weekly",
  defaultModel: "ensemble",
  confidenceLevel: 0.95,
  aggregation: "sum",
  outlierHandling: "clip",
  currency: "USD",
  fiscalYearStartMonth: 1,
};
