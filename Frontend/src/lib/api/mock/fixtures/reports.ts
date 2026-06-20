import type { Report } from "@/types/report";

export const mockReports: Report[] = [
  {
    id: "rpt_001",
    name: "Q2 Forecast Summary",
    type: "forecast_summary",
    status: "ready",
    generatedAt: "2026-06-10T08:00:00.000Z",
    createdAt: "2026-06-10T07:58:00.000Z",
    fileUrl: "#",
  },
  {
    id: "rpt_002",
    name: "Model Accuracy — May",
    type: "accuracy",
    status: "ready",
    generatedAt: "2026-06-01T08:00:00.000Z",
    createdAt: "2026-06-01T07:55:00.000Z",
    fileUrl: "#",
  },
  {
    id: "rpt_003",
    name: "Summer Promo vs Baseline",
    type: "scenario_comparison",
    status: "generating",
    createdAt: "2026-06-16T09:30:00.000Z",
  },
];
