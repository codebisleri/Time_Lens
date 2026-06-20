import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { EdaResult } from "@/types/eda";

/**
 * Persisted EDA state (F.12 #11). Survives page navigation, sidebar changes, and
 * forecast execution — and a refresh (localStorage). Stores the "ran" gate, the
 * chosen scope/SKU, and a per-key result cache so returning to EDA shows the
 * existing analysis instantly without re-clicking "Run EDA". Cleared only when
 * the dataset changes (call `reset()` on upload) or the user explicitly reruns.
 */
type Scope = "portfolio" | "sku";

interface EdaState {
  ran: boolean;
  scope: Scope;
  selectedSku: string | null;
  /** key = "portfolio" | <sku code> → last EDA result for that scope. */
  cache: Record<string, EdaResult>;
  setUi: (patch: Partial<Pick<EdaState, "ran" | "scope" | "selectedSku">>) => void;
  cacheResult: (key: string, result: EdaResult) => void;
  reset: () => void;
}

export const useEdaStore = create<EdaState>()(
  persist(
    (set) => ({
      ran: false,
      scope: "portfolio",
      selectedSku: null,
      cache: {},
      setUi: (patch) => set(patch),
      cacheResult: (key, result) =>
        set((s) => ({ cache: { ...s.cache, [key]: result } })),
      reset: () => set({ ran: false, scope: "portfolio", selectedSku: null, cache: {} }),
    }),
    { name: "tl-eda-state" },
  ),
);
