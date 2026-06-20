import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

/**
 * SKU Management table UI state: the current selection set (for bulk actions)
 * and persisted view preferences (visible columns, page size). Server rows are
 * NOT stored here — they're fetched via skuService and held in component state.
 */
interface SkuState {
  selectedIds: string[];
  visibleColumns: string[];
  pageSize: number;

  toggleSelected: (id: string) => void;
  setSelected: (ids: string[]) => void;
  clearSelection: () => void;
  setVisibleColumns: (columns: string[]) => void;
  setPageSize: (size: number) => void;
  /** Clear transient selection (used by the workspace reset). View prefs kept. */
  reset: () => void;
}

const DEFAULT_COLUMNS = [
  "code",
  "name",
  "category",
  "status",
  "forecastAccuracy",
  "updatedAt",
];

export const useSkuStore = create<SkuState>()(
  devtools(
    persist(
      (set) => ({
        selectedIds: [],
        visibleColumns: DEFAULT_COLUMNS,
        pageSize: 20,

        toggleSelected: (id) =>
          set((s) => ({
            selectedIds: s.selectedIds.includes(id)
              ? s.selectedIds.filter((x) => x !== id)
              : [...s.selectedIds, id],
          })),
        setSelected: (selectedIds) => set({ selectedIds }),
        clearSelection: () => set({ selectedIds: [] }),
        setVisibleColumns: (visibleColumns) => set({ visibleColumns }),
        setPageSize: (pageSize) => set({ pageSize }),
        reset: () => set({ selectedIds: [] }),
      }),
      {
        name: "tl-sku-view",
        partialize: (s) => ({
          visibleColumns: s.visibleColumns,
          pageSize: s.pageSize,
        }),
      },
    ),
    { name: "sku-store" },
  ),
);
