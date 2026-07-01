import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import type { StoredCausalGraph } from "@/types/whatif";

/**
 * Scenario Planning state. Holds the user's selections for both sub-tools:
 *   • Causal Effect Estimation (DoWhy) — treatments, confounders, methods, refuters
 *   • What-If Feature Simulation — gated on the cached `causalGraph`; the per-month
 *     grid values are local component state, so only the SKU + the DoWhy graph live
 *     here.
 *
 * Persisted to localStorage so selections survive refresh, browser restart, and
 * Electron restart. Transient results (forecast series, causal estimates) are NOT
 * persisted — they are recomputed on demand.
 */
export type ScenarioMode = "whatif" | "causal";

interface ScenarioPlanningState {
  mode: ScenarioMode;
  sku: string;
  // Causal Effect Estimation selections.
  treatments: string[];
  confounders: string[];
  instruments: string[];
  effectModifiers: string[];
  methods: string[];
  refuters: string[];
  computeCi: boolean;
  causalTask: "impact" | "drivers";
  /**
   * DoWhy output graph, cached so the What-If Feature Simulation can CONSUME it.
   * What-If stays locked until a graph exists for the active SKU
   * (`causalGraph.sku === activeSku`). Persisted → the gate + graph survive
   * refresh / restart. Cleared on reset.
   */
  causalGraph: StoredCausalGraph | null;

  setMode: (mode: ScenarioMode) => void;
  setSku: (sku: string) => void;
  setCausal: (patch: Partial<Pick<ScenarioPlanningState,
    "treatments" | "confounders" | "instruments" | "effectModifiers" | "methods" | "refuters" | "computeCi" | "causalTask">>) => void;
  setCausalGraph: (graph: StoredCausalGraph | null) => void;
  reset: () => void;
}

const DEFAULTS = {
  // TASK 5 — the Scenario workflow is strictly DoWhy → graph → What-If, so the
  // page must ALWAYS open on the Causal Effect Estimation (DoWhy) tab. `mode` is
  // intentionally NOT persisted (see partialize) so every entry resets to causal.
  mode: "causal" as ScenarioMode,
  sku: "",
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
  causalGraph: null as StoredCausalGraph | null,
};

export const useScenarioPlanningStore = create<ScenarioPlanningState>()(
  devtools(
    persist(
      (set) => ({
        ...DEFAULTS,
        setMode: (mode) => set({ mode }),
        setSku: (sku) => set({ sku }),
        setCausal: (patch) => set(patch),
        setCausalGraph: (causalGraph) => set({ causalGraph }),
        reset: () => set({ ...DEFAULTS }),
      }),
      {
        name: "scenario-planning",
        // Persist selections (no transient results).
        partialize: (s) => ({
          mode: s.mode,
          sku: s.sku,
          treatments: s.treatments,
          confounders: s.confounders,
          instruments: s.instruments,
          effectModifiers: s.effectModifiers,
          methods: s.methods,
          refuters: s.refuters,
          computeCi: s.computeCi,
          causalTask: s.causalTask,
          causalGraph: s.causalGraph,
        }),
      },
    ),
    { name: "scenario-planning-store" },
  ),
);
