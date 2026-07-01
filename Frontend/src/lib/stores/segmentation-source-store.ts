import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import type { SegmentationSource } from "@/types/segmentation";

/**
 * Segmentation-source state — the THREE-state model required by the redesigned
 * Profile & Route workflow:
 *
 *   • uploadedSegmentation  — the user's uploaded segment column (immutable; lives
 *     in the dataset, read on demand). Never modified.
 *   • generatedSegmentation — computed by TimeLens via "Run Segmentation"
 *     (persisted as an audit run). Never overwrites the uploaded column.
 *   • activeSegmentation    — `activeSource` below; simply references whichever of
 *     the two is in effect. The ONLY source consumed downstream.
 *
 * The actual segmentation PAYLOADS are fetched from the backend per source
 * (`/segmentation?source=…`); this store holds the lightweight selection + the
 * workflow gate flags (whether Run Segmentation has executed, and whether the
 * user has Proceeded past the source-choice popup). Persisted so a refresh keeps
 * the user past the gate. `activeSource` is mirrored to the dataset config
 * (`useGeneratedSegmentation`) so the backend forecast worker resolves the same
 * source — config stays the cross-request source of truth.
 */
interface SegmentationSourceState {
  /** Dataset these flags belong to; flags reset when it changes. */
  datasetId: string | null;
  /** An uploaded segment column exists for this dataset. */
  hasUploaded: boolean;
  /** "Run Segmentation" has executed this session → generatedSegmentation exists. */
  ran: boolean;
  /** The user has chosen a source and Proceeded (Case 2 auto-proceeds). Gates the
   *  rest of the Profile & Route page. */
  proceeded: boolean;
  /** The active segmentation source consumed by every downstream module. */
  activeSource: SegmentationSource;

  /** Initialise/repair for a dataset. Resets run/proceed flags when the dataset
   *  changes and seeds `activeSource` from the persisted config; a no-op (beyond
   *  refreshing `hasUploaded`) for the same dataset so user choices are kept. */
  init: (args: { datasetId: string; hasUploaded: boolean; useGenerated: boolean }) => void;
  setActiveSource: (s: SegmentationSource) => void;
  markRan: () => void;
  proceed: () => void;
  reset: () => void;
}

const INITIAL = {
  datasetId: null as string | null,
  hasUploaded: false,
  ran: false,
  proceeded: false,
  activeSource: "generated" as SegmentationSource,
};

export const useSegmentationSourceStore = create<SegmentationSourceState>()(
  devtools(
    persist(
      (set) => ({
        ...INITIAL,
        init: ({ datasetId, hasUploaded, useGenerated }) =>
          set((s) => {
            if (s.datasetId === datasetId) return { hasUploaded };
            return {
              datasetId,
              hasUploaded,
              ran: false,
              proceeded: false,
              // No uploaded column ⇒ generated is the only (and active) source.
              activeSource: !hasUploaded || useGenerated ? "generated" : "uploaded",
            };
          }),
        setActiveSource: (activeSource) => set({ activeSource }),
        markRan: () => set({ ran: true }),
        proceed: () => set({ proceeded: true }),
        reset: () => set({ ...INITIAL }),
      }),
      {
        name: "segmentation-source",
        partialize: (s) => ({
          datasetId: s.datasetId,
          ran: s.ran,
          proceeded: s.proceeded,
          activeSource: s.activeSource,
        }),
      },
    ),
    { name: "segmentation-source-store" },
  ),
);
