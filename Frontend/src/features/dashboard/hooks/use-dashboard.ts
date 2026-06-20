"use client";

import { useAsync } from "@/lib/hooks";
import { dashboardService } from "@/lib/api/services";

/** Loads the executive dashboard summary (KPIs, demand trend, top SKUs). */
export function useDashboard() {
  return useAsync(() => dashboardService.getSummary(), []);
}
