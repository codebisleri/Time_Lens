import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { AssumptionLever, ForecastHorizon } from "@/types";

/**
 * Working draft for the Scenario Planning builder. Holds the in-progress
 * assumption levers and a dirty flag so the UI can warn on unsaved changes.
 * Persisted draft is intentionally NOT enabled — a scenario is committed via
 * scenarioService.create.
 */
type DraftLever = Omit<AssumptionLever, "id"> & { id: string };

interface ScenarioDraftState {
  name: string;
  description: string;
  horizon: ForecastHorizon;
  baselineForecastId: string | null;
  levers: DraftLever[];
  isDirty: boolean;

  setMeta: (meta: Partial<Pick<ScenarioDraftState, "name" | "description" | "horizon" | "baselineForecastId">>) => void;
  addLever: (lever: DraftLever) => void;
  updateLever: (id: string, patch: Partial<DraftLever>) => void;
  removeLever: (id: string) => void;
  reset: () => void;
}

const initial = {
  name: "",
  description: "",
  horizon: "weekly" as ForecastHorizon,
  baselineForecastId: null,
  levers: [] as DraftLever[],
  isDirty: false,
};

export const useScenarioStore = create<ScenarioDraftState>()(
  devtools(
    (set) => ({
      ...initial,
      setMeta: (meta) => set({ ...meta, isDirty: true }),
      addLever: (lever) =>
        set((s) => ({ levers: [...s.levers, lever], isDirty: true })),
      updateLever: (id, patch) =>
        set((s) => ({
          levers: s.levers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
          isDirty: true,
        })),
      removeLever: (id) =>
        set((s) => ({
          levers: s.levers.filter((l) => l.id !== id),
          isDirty: true,
        })),
      reset: () => set(initial),
    }),
    { name: "scenario-store" },
  ),
);
