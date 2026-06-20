import type { Metadata } from "next";
import { ForecastSubmissionView } from "@/features/forecast-submission/submission-view";

export const metadata: Metadata = { title: "Forecast Submission" };

// Phase D.2 — the real Forecast Submission worksheet (cascading filters, KPI
// strip, bulk actions, editable month-level grid, submit + audit trail) wired to
// the live D.1 backend. The legacy approve/reject ReviewView remains reachable
// at /forecasts/review as a delinked legacy route.
export default function ForecastSubmissionPage() {
  return <ForecastSubmissionView />;
}
