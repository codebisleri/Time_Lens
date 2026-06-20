import { http } from "../client";
import { endpoints } from "../endpoints";
import type {
  Scenario,
  ScenarioSummary,
  ScenarioListParams,
  CreateScenarioPayload,
  UpdateScenarioPayload,
} from "@/types/scenario";

export const scenarioService = {
  list(params?: ScenarioListParams): Promise<ScenarioSummary[]> {
    return http.get<ScenarioSummary[]>(endpoints.scenarios.list(), params);
  },

  getById(id: string): Promise<Scenario> {
    return http.get<Scenario>(endpoints.scenarios.detail(id));
  },

  create(payload: CreateScenarioPayload): Promise<Scenario> {
    return http.post<Scenario>(endpoints.scenarios.create(), payload);
  },

  update(id: string, payload: UpdateScenarioPayload): Promise<Scenario> {
    return http.patch<Scenario>(endpoints.scenarios.detail(id), payload);
  },
};
