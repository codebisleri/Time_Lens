import { http } from "../client";
import { endpoints } from "../endpoints";
import type {
  SubmissionResponse,
  SubmissionFilterParams,
  SubmissionPatchPayload,
  SubmissionPatchResponse,
  SubmitPayload,
  SubmissionBatch,
} from "@/types/submission";

/**
 * Forecast Submission service — talks to the live D.1 backend worksheet API.
 * Mirrors the verb-thin pattern of forecast.service.ts; no business logic here.
 */
export const submissionService = {
  /** Load the planner worksheet (rows + KPIs + facets) for the current run. */
  get(params?: SubmissionFilterParams): Promise<SubmissionResponse> {
    return http.get<SubmissionResponse>(endpoints.forecasts.submission(), params);
  },

  /** Apply per-cell edits and/or a bulk operation; returns recomputed KPIs. */
  patch(payload: SubmissionPatchPayload): Promise<SubmissionPatchResponse> {
    return http.patch<SubmissionPatchResponse>(
      endpoints.forecasts.submission(),
      payload,
    );
  },

  /** Lock in the plan — creates a submission batch. */
  submit(payload: SubmitPayload): Promise<SubmissionBatch> {
    return http.post<SubmissionBatch>(
      endpoints.forecasts.submissionSubmit(),
      payload,
    );
  },

  /** Submission batch history (most recent first). */
  audit(datasetId?: string): Promise<SubmissionBatch[]> {
    return http.get<SubmissionBatch[]>(
      endpoints.forecasts.submissionAudit(),
      datasetId ? { datasetId } : undefined,
    );
  },

  /** Raw CSV of the full worksheet (real backend export). */
  exportCsv(datasetId?: string): Promise<string> {
    return http.get<string>(
      endpoints.forecasts.submissionExport(),
      datasetId ? { datasetId } : undefined,
    );
  },
};
