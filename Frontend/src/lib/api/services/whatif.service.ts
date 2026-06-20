import { http } from "../client";
import { endpoints } from "../endpoints";
import type { ForecastJob } from "@/types/forecast";
import type {
  RunScenarioPayload,
  SavedScenarioRow,
  ScenarioDetail,
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
};
