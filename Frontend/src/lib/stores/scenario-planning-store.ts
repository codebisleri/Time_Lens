import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import type { ScenarioAdjustment } from "@/types/whatif";

/**
 * Scenario Planning state (Phase Y.A · Task 6 — state parity with Streamlit's
 * st.session_state). Holds the user's scenario assumptions and parameters for
 * BOTH sub-tools:
 *   • What-If Feature Simulation — sku, horizon, adjustments
 *   • Causal Effect Estimation (DoWhy) — treatments, confounders, methods, refuters
 *
 * Persisted to localStorage so assumptions/parameters/selections survive refresh,
 * browser restart, and Electron restart. Transient results (forecast series,
 * causal estimates) are NOT persisted — they are recomputed on demand.
 */
export type ScenarioMode = "whatif" | "causal";

interface ScenarioPlanningState {
  mode: ScenarioMode;
  sku: string;
  periods: number;
  /** What-If lever adjustments. */
  adjustments: ScenarioAdjustment[];
  applyCausal: boolean;
  /** What-If date window (start/end) for the exog adjustments (Streamlit parity). */
  start: string;
  end: string;
  // Causal Effect Estimation selections.
  treatments: string[];
  confounders: string[];
  instruments: string[];
  effectModifiers: string[];
  methods: string[];
  refuters: string[];
  computeCi: boolean;
  causalTask: "impact" | "drivers";

  setMode: (mode: ScenarioMode) => void;
  setSku: (sku: string) => void;
  setPeriods: (periods: number) => void;
  setAdjustments: (a: ScenarioAdjustment[]) => void;
  setApplyCausal: (v: boolean) => void;
  setWindow: (patch: Partial<Pick<ScenarioPlanningState, "start" | "end">>) => void;
  setCausal: (patch: Partial<Pick<ScenarioPlanningState,
    "treatments" | "confounders" | "instruments" | "effectModifiers" | "methods" | "refuters" | "computeCi" | "causalTask">>) => void;
  reset: () => void;
}

const DEFAULTS = {
  mode: "whatif" as ScenarioMode,
  sku: "",
  periods: 12,
  adjustments: [] as ScenarioAdjustment[],
  applyCausal: false,
  start: "",
  end: "",
  treatments: [] as string[],
  confounders: [] as string[],
  instruments: [] as string[],
  effectModifiers: [] as string[],
  methods: ["backdoor.linear_regression"],
  refuters: [
    "random_common_cause",
    "placebo_treatment_refuter",
    "data_subset_refuter",
    "add_unobserved_common_cause",
  ],
  computeCi: true,
  causalTask: "impact" as const,
};

export const useScenarioPlanningStore = create<ScenarioPlanningState>()(
  devtools(
    persist(
      (set) => ({
        ...DEFAULTS,
        setMode: (mode) => set({ mode }),
        setSku: (sku) => set({ sku }),
        setPeriods: (periods) => set({ periods }),
        setAdjustments: (adjustments) => set({ adjustments }),
        setApplyCausal: (applyCausal) => set({ applyCausal }),
        setWindow: (patch) => set(patch),
        setCausal: (patch) => set(patch),
        reset: () => set({ ...DEFAULTS }),
      }),
      {
        name: "scenario-planning",
        // Persist assumptions + parameters + selections (Task 6). No results.
        partialize: (s) => ({
          mode: s.mode,
          sku: s.sku,
          periods: s.periods,
          adjustments: s.adjustments,
          applyCausal: s.applyCausal,
          start: s.start,
          end: s.end,
          treatments: s.treatments,
          confounders: s.confounders,
          instruments: s.instruments,
          effectModifiers: s.effectModifiers,
          methods: s.methods,
          refuters: s.refuters,
          computeCi: s.computeCi,
          causalTask: s.causalTask,
        }),
      },
    ),
    { name: "scenario-planning-store" },
  ),
);
