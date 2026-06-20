import type { ValidationSeverity } from "@/types/dataset";

/** Visual phase of the upload area state machine.
 *  uploading → processing (parse/register dataset) → generating (forecasts) →
 *  success | error. */
export type UploadPhase =
  | "idle"
  | "uploading"
  | "processing"
  | "generating"
  | "success"
  | "error";

/** Row-level validation issue shown in the validation panel's issues table. */
export interface RowIssue {
  id: string;
  row: number;
  field: string;
  issue: string;
  severity: ValidationSeverity;
}

/** Result of validating an uploaded file (feature-local; mirrors what a real
 *  /datasets/upload response would carry). */
export interface UploadSummary {
  rowsProcessed: number;
  rowsRejected: number;
  missingValues: number;
  duplicateSkus: number;
  issues: RowIssue[];
}
