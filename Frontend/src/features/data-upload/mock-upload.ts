import type { RowIssue, UploadSummary } from "./types";

/**
 * Client-side upload/validation simulation.
 *
 * The mock API layer exposes no POST /datasets/upload route, and the API layer
 * is out of scope to change here — so the ingestion flow is simulated in the
 * feature using the existing upload store. Numbers are derived deterministically
 * from the file so the same file always yields the same result. Upload history
 * and hero stats still come from the real dataService.listDatasets().
 */

const ACCEPTED_EXTENSIONS = [".csv", ".xlsx"];

export function getFileTypeError(file: File): string | null {
  const name = file.name.toLowerCase();
  const ok = ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext));
  return ok ? null : "Unsupported file type. Upload a .csv or .xlsx file.";
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

const ISSUE_FIELDS = ["sku_code", "units_sold", "date", "price", "store"];

export function buildUploadSummary(file: File): UploadSummary {
  const seed = Math.max(1, Math.round(file.size / 64) + file.name.length);
  const rowsProcessed = 8_000 + (seed % 12_000);
  const missingValues = seed % 320;
  const duplicateSkus = seed % 40;
  const rowsRejected = (seed % 90) + duplicateSkus;

  const issues: RowIssue[] = Array.from({ length: 6 }, (_, i) => {
    const severity: RowIssue["severity"] = i % 3 === 0 ? "error" : "warning";
    const field = ISSUE_FIELDS[(seed + i) % ISSUE_FIELDS.length]!;
    const issue =
      severity === "error"
        ? `Invalid value in "${field}"`
        : `Missing "${field}" — defaulted`;
    return {
      id: `iss_${i}`,
      row: 100 + ((seed + i * 37) % rowsProcessed),
      field,
      issue,
      severity,
    };
  });

  return { rowsProcessed, rowsRejected, missingValues, duplicateSkus, issues };
}
