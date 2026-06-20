import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

/**
 * Cross-page analytical filters (date range, region, category) shared by the
 * Dashboard and Forecast views. Holds *intent*; the data layer reads these to
 * build query params. Persisted so a user's working context survives reloads.
 */
export interface GlobalFilters {
  dateRange: { from: string | null; to: string | null };
  region: string | null;
  category: string | null;
}

interface FilterState extends GlobalFilters {
  setDateRange: (from: string | null, to: string | null) => void;
  setRegion: (region: string | null) => void;
  setCategory: (category: string | null) => void;
  reset: () => void;
}

const initial: GlobalFilters = {
  dateRange: { from: null, to: null },
  region: null,
  category: null,
};

export const useFilterStore = create<FilterState>()(
  devtools(
    persist(
      (set) => ({
        ...initial,
        setDateRange: (from, to) => set({ dateRange: { from, to } }),
        setRegion: (region) => set({ region }),
        setCategory: (category) => set({ category }),
        reset: () => set(initial),
      }),
      { name: "tl-filters" },
    ),
    { name: "filter-store" },
  ),
);
