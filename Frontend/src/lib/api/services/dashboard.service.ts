import { http } from "../client";
import { endpoints } from "../endpoints";
import type { DashboardSummary } from "@/types/dashboard";

export const dashboardService = {
  getSummary(): Promise<DashboardSummary> {
    return http.get<DashboardSummary>(endpoints.dashboard.summary());
  },
};
