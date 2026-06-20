import { http } from "../client";
import { endpoints } from "../endpoints";
import type {
  GeneratedReport,
  GenerateLiveReportPayload,
  ReportSummary,
} from "@/types/report";

/**
 * Reports service — talks to the live /reports* backend (engine HTML builders).
 * Verb-thin, matching forecast/submission services; no business logic here.
 */
export const reportsService = {
  /** Executive dashboard: dataset, forecast headline, segments, opportunities. */
  summary(datasetId?: string): Promise<ReportSummary> {
    return http.get<ReportSummary>(
      endpoints.reports.summary(),
      datasetId ? { datasetId } : undefined,
    );
  },

  /** Generated-report history (most recent first). */
  list(datasetId?: string): Promise<GeneratedReport[]> {
    return http.get<GeneratedReport[]>(
      endpoints.reports.list(),
      datasetId ? { datasetId } : undefined,
    );
  },

  /** Build an executive HTML report via the engine builders. */
  generate(payload: GenerateLiveReportPayload): Promise<GeneratedReport> {
    return http.post<GeneratedReport>(endpoints.reports.generate(), payload);
  },

  getById(id: string): Promise<GeneratedReport> {
    return http.get<GeneratedReport>(endpoints.reports.detail(id));
  },

  /** Raw self-contained HTML for a generated report. */
  download(id: string): Promise<string> {
    return http.get<string>(endpoints.reports.download(id));
  },
};
