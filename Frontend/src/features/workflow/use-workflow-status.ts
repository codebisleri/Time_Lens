"use client";

import { useAsync } from "@/lib/hooks";
import { workflowService } from "@/lib/api/services";

/** Loads the persisted backend workflow status (stage gating). */
export function useWorkflowStatus() {
  return useAsync(() => workflowService.status(), []);
}
