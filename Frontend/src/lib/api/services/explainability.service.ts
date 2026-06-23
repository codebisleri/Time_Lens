import { http } from "../client";
import { endpoints } from "../endpoints";
import type {
  HorizonExplainability,
  LocalExplainability,
} from "@/types/explainability";

/** Read-only, FORECAST-LEVEL explainability (Phase X.U → X.W). Never reruns or
 *  retrains forecasts; portfolio/global drivers were removed in X.W. */
export const explainabilityService = {
  local(level: string, datasetId?: string): Promise<LocalExplainability> {
    return http.get<LocalExplainability>(endpoints.explainability.local(level), { datasetId });
  },
  horizon(level: string, datasetId?: string): Promise<HorizonExplainability> {
    return http.get<HorizonExplainability>(endpoints.explainability.horizon(level), { datasetId });
  },
};
