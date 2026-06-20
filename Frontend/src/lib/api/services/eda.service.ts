import { http } from "../client";
import { endpoints } from "../endpoints";
import type { EdaAnomalyApplyResult, EdaResult } from "@/types/eda";

/** One row of the editable anomaly-correction table. */
export interface EdaAnomalyCorrection {
  date: string;
  correct: boolean;
}

/** Exploratory Data Analysis (portfolio aggregate, or a single SKU). */
export const edaService = {
  get(params?: { datasetId?: string; sku?: string }): Promise<EdaResult> {
    return http.get<EdaResult>(endpoints.eda.get(), params);
  },

  /** Apply an edited anomaly table — recomputes the cleaned series server-side. */
  applyAnomalies(payload: {
    datasetId?: string;
    sku?: string | null;
    corrections: EdaAnomalyCorrection[];
  }): Promise<EdaAnomalyApplyResult> {
    return http.post<EdaAnomalyApplyResult>(endpoints.eda.anomalies(), payload);
  },
};
