"use client";

import { useAsync } from "@/lib/hooks";
import { scenarioService } from "@/lib/api/services";
import type { Scenario } from "@/types";

/**
 * Recent scenario runs for the activity table. The list endpoint returns
 * summaries; we fan out to fetch the full scenarios (which carry createdBy and
 * projected revenue) for the most recently updated few. Uses existing services
 * only — no API-layer changes.
 */
export function useRecentScenarios(limit = 5) {
  return useAsync<Scenario[]>(async () => {
    const summaries = await scenarioService.list();
    const recent = [...summaries]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
    return Promise.all(recent.map((s) => scenarioService.getById(s.id)));
  }, [limit]);
}
