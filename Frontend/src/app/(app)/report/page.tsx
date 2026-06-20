import type { Metadata } from "next";
import { ReportView } from "@/features/report/report-view";

export const metadata: Metadata = { title: "Report" };

// Phase E — the executive Report hub: dashboard summary + one-click HTML report
// generation (segmentation, routed forecast) wired to the live /reports* backend,
// which calls the engine's headless build_*_html_report builders.
export default function ReportPage() {
  return <ReportView />;
}
