import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

/**
 * Dynamic forecast-set filters (Phase X.P · Tasks 2 & 4).
 *
 * Replaces the hardcoded Brand/Segment filters with a generic, dataset-derived
 * system: the user first picks WHICH columns to filter by (`filterColumns`),
 * then selects values per column (`filterValues[column] = [...]`). Any entity
 * matching every active column's selected values is in the forecast set.
 *
 * Persisted (Zustand `persist`) so the chosen columns and values survive
 * refresh / browser restart / Electron restart.
 */
interface ForecastFiltersState {
  /** Active filter column keys (e.g. ["segment", "brand"]). */
  filterColumns: string[];
  /** Selected values per column key. */
  filterValues: Record<string, string[]>;
  /** Add/remove a column from the active set (clears its values when removed). */
  toggleColumn: (column: string) => void;
  /** Toggle a single value for a column. */
  toggleValue: (column: string, value: string) => void;
  /** Replace all selected values for a column. */
  setColumnValues: (column: string, values: string[]) => void;
  /** Clear all columns + values. */
  clearFilters: () => void;
}

export const useForecastFiltersStore = create<ForecastFiltersState>()(
  devtools(
    persist(
      (set) => ({
        filterColumns: [],
        filterValues: {},
        toggleColumn: (column) =>
          set((s) => {
            const active = s.filterColumns.includes(column);
            const filterColumns = active
              ? s.filterColumns.filter((c) => c !== column)
              : [...s.filterColumns, column];
            const filterValues = { ...s.filterValues };
            if (active) delete filterValues[column]; // dropping a column clears its values
            return { filterColumns, filterValues };
          }),
        toggleValue: (column, value) =>
          set((s) => {
            const cur = s.filterValues[column] ?? [];
            const next = cur.includes(value)
              ? cur.filter((v) => v !== value)
              : [...cur, value];
            return { filterValues: { ...s.filterValues, [column]: next } };
          }),
        setColumnValues: (column, values) =>
          set((s) => ({ filterValues: { ...s.filterValues, [column]: values } })),
        clearFilters: () => set({ filterColumns: [], filterValues: {} }),
      }),
      { name: "forecast-filters" },
    ),
    { name: "forecast-filters-store" },
  ),
);
