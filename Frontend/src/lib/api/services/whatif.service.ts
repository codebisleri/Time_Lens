import { http } from "../client";
import { endpoints } from "../endpoints";
import type { ForecastJob } from "@/types/forecast";
import type {
  CausalFeaturesResponse,
  CausalGraphPayload,
  CausalGraphResponse,
  RunCausalPayload,
  RunScenarioPayload,
  SavedScenarioRow,
  ScenarioDetail,
  WhatIfGridResponse,
} from "@/types/whatif";

/**
 * Scenario Planning (What-If) service — the live backend engine that re-fits the
 * single-series model, applies exog adjustments, and re-forecasts. Run returns a
 * job to poll (its `result` carries the ScenarioRunResult on completion).
 */
export const whatifService = {
  run(payload: RunScenarioPayload): Promise<ForecastJob> {
    return http.post<ForecastJob>(endpoints.scenarios.run(), payload);
  },
  /** Forecast-horizon months + per-feature baseline level for the editable
   *  What-If grid (read-only; no forecast is re-run). */
  whatifGrid(skuId: string, datasetId?: string): Promise<WhatIfGridResponse> {
    return http.get<WhatIfGridResponse>(endpoints.scenarios.whatifGrid(), {
      skuId,
      datasetId,
    });
  },
  save(payload: {
    name: string;
    sku: string;
    result: unknown;
    adjustments?: unknown;
  }): Promise<{ id: string }> {
    return http.post<{ id: string }>(endpoints.scenarios.save(), payload);
  },
  list(): Promise<SavedScenarioRow[]> {
    return http.get<SavedScenarioRow[]>(endpoints.scenarios.list());
  },
  getById(id: string): Promise<ScenarioDetail> {
    return http.get<ScenarioDetail>(endpoints.scenarios.detail(id));
  },
  remove(id: string): Promise<{ deleted: string }> {
    return http.delete<{ deleted: string }>(endpoints.scenarios.remove(id));
  },

  // ── Causal Effect Estimation (DoWhy) ──────────────────────────────────────
  /** Candidate levers + DoWhy availability for a SKU (no estimation). */
  causalFeatures(skuId: string, datasetId?: string): Promise<CausalFeaturesResponse> {
    return http.get<CausalFeaturesResponse>(endpoints.scenarios.causalFeatures(), {
      skuId,
      datasetId,
    });
  },
  /** Estimate causal effects — returns a job to poll (result = CausalRunResult). */
  causalRun(payload: RunCausalPayload): Promise<ForecastJob> {
    return http.post<ForecastJob>(endpoints.scenarios.causalRun(), payload);
  },
  /** Rank every lever by impact — returns a job to poll (result = DriversResult). */
  causalDrivers(payload: { skuId: string; useAllConfounders?: boolean; datasetId?: string }): Promise<ForecastJob> {
    return http.post<ForecastJob>(endpoints.scenarios.causalDrivers(), payload);
  },
  /** Read-only causal DAG ({nodes, edges}) for the current selection. No DoWhy
   *  estimation runs — pure structure for the visualization (Phase Y.6). */
  causalGraph(payload: CausalGraphPayload): Promise<CausalGraphResponse> {
    return http.post<CausalGraphResponse>(endpoints.scenarios.causalGraph(), payload);
  },
};
