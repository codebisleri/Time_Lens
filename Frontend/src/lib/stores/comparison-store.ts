import { create } from "zustand";
import { devtools } from "zustand/middleware";

/**
 * Selection state for Scenario Comparison: which scenarios are on the canvas
 * and which one is pinned as the baseline. The computed ComparisonResult itself
 * comes from comparisonService and is not stored here.
 */
interface ComparisonState {
  selectedScenarioIds: string[];
  baselineScenarioId: string | null;
  metric: "units" | "revenue";

  addScenario: (id: string) => void;
  removeScenario: (id: string) => void;
  setBaseline: (id: string | null) => void;
  setMetric: (metric: "units" | "revenue") => void;
  clear: () => void;
}

const MAX_COMPARE = 4;

export const useComparisonStore = create<ComparisonState>()(
  devtools(
    (set) => ({
      selectedScenarioIds: [],
      baselineScenarioId: null,
      metric: "units",

      addScenario: (id) =>
        set((s) => {
          if (
            s.selectedScenarioIds.includes(id) ||
            s.selectedScenarioIds.length >= MAX_COMPARE
          ) {
            return s;
          }
          return {
            selectedScenarioIds: [...s.selectedScenarioIds, id],
            baselineScenarioId: s.baselineScenarioId ?? id,
          };
        }),
      removeScenario: (id) =>
        set((s) => {
          const selectedScenarioIds = s.selectedScenarioIds.filter(
            (x) => x !== id,
          );
          return {
            selectedScenarioIds,
            baselineScenarioId:
              s.baselineScenarioId === id
                ? (selectedScenarioIds[0] ?? null)
                : s.baselineScenarioId,
          };
        }),
      setBaseline: (baselineScenarioId) => set({ baselineScenarioId }),
      setMetric: (metric) => set({ metric }),
      clear: () => set({ selectedScenarioIds: [], baselineScenarioId: null }),
    }),
    { name: "comparison-store" },
  ),
);
