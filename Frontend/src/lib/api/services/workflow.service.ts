import { http } from "../client";
import { endpoints } from "../endpoints";
import type { WorkflowStatus, WorkflowStep } from "@/types/workflow";

/** Backend-persisted workflow progression (mirrors Streamlit's stateful tabs). */
export const workflowService = {
  status(): Promise<WorkflowStatus> {
    return http.get<WorkflowStatus>(endpoints.workflow.status());
  },

  complete(step: WorkflowStep): Promise<WorkflowStatus> {
    return http.post<WorkflowStatus>(endpoints.workflow.complete(), { step });
  },
};
