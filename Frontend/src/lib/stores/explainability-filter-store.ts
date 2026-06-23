import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

/**
 * Explainability forecast-level filters (Phase X.ZZ.2 · Task 3). Replaces the
 * free-text SKU search with Brand + Segment multi-select filters that narrow the
 * forecast-level list. Persisted so selections survive refresh / restart.
 */
interface ExplainabilityFilterState {
  brands: string[];
  segments: string[];
  setBrands: (b: string[]) => void;
  setSegments: (s: string[]) => void;
  clear: () => void;
}

export const useExplainabilityFilterStore = create<ExplainabilityFilterState>()(
  devtools(
    persist(
      (set) => ({
        brands: [],
        segments: [],
        setBrands: (brands) => set({ brands }),
        setSegments: (segments) => set({ segments }),
        clear: () => set({ brands: [], segments: [] }),
      }),
      { name: "explainability-filters" },
    ),
    { name: "explainability-filter-store" },
  ),
);
