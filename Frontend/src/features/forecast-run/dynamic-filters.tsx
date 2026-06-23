"use client";

import { Filter, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Field } from "@/features/data/controls";
import { useForecastFiltersStore } from "@/lib/stores/forecast-filters-store";

/**
 * Dynamic, dataset-derived forecast-set filters (Phase X.P · Task 2).
 *
 * Step 1 — the user picks WHICH columns to filter by (chips). The column list is
 * derived from the dataset (labelled with the real column names), never
 * hardcoded "Brand"/"Segment".
 * Step 2 — each chosen column shows a value multi-select (the distinct values
 * present in the data).
 * Step 3 — matching forecast-level entities update automatically (the count is
 * shown by the parent).
 *
 * Selections live in the persisted forecast-filters store (Task 4).
 */
export function DynamicFilters({
  columns,
  valuesByColumn,
  levelPlural,
  matchCount,
  totalCount,
}: {
  /** Available filter columns derived from the dataset (key + display label). */
  columns: { key: string; label: string }[];
  /** Distinct values available per column key. */
  valuesByColumn: Record<string, string[]>;
  levelPlural: string;
  matchCount: number;
  totalCount: number;
}) {
  const filterColumns = useForecastFiltersStore((s) => s.filterColumns);
  const filterValues = useForecastFiltersStore((s) => s.filterValues);
  const toggleColumn = useForecastFiltersStore((s) => s.toggleColumn);
  const toggleValue = useForecastFiltersStore((s) => s.toggleValue);
  const clearFilters = useForecastFiltersStore((s) => s.clearFilters);

  if (!columns.length) {
    return <p className="text-xs text-muted-foreground">No filterable columns in this dataset.</p>;
  }

  const active = filterColumns.filter((c) => columns.some((col) => col.key === c));

  return (
    <div className="space-y-3">
      {/* Step 1 — choose filter columns */}
      <Field label="Filter columns">
        <div className="flex flex-wrap items-center gap-1.5">
          {columns.map((col) => {
            const on = filterColumns.includes(col.key);
            return (
              <button
                key={col.key}
                type="button"
                onClick={() => toggleColumn(col.key)}
                aria-pressed={on}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
                  on
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-secondary",
                )}
              >
                <Filter className="size-3" />
                {col.label}
              </button>
            );
          })}
          {active.length ? (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" /> Clear
            </button>
          ) : null}
        </div>
      </Field>

      {/* Step 2 — per-column value selectors */}
      {active.map((key) => {
        const col = columns.find((c) => c.key === key)!;
        const values = valuesByColumn[key] ?? [];
        const selected = filterValues[key] ?? [];
        return (
          <Field key={key} label={`${col.label} (${selected.length || "all"})`}>
            <div className="flex max-h-40 flex-wrap gap-1.5 overflow-auto rounded-md border border-border p-2">
              {values.length ? (
                values.map((v) => {
                  const on = selected.includes(v);
                  return (
                    <button
                      key={v}
                      type="button"
                      onClick={() => toggleValue(key, v)}
                      aria-pressed={on}
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-xs transition-colors",
                        on
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:bg-secondary",
                      )}
                    >
                      {v}
                    </button>
                  );
                })
              ) : (
                <p className="text-xs text-muted-foreground">No values.</p>
              )}
            </div>
          </Field>
        );
      })}

      {/* Step 3 — matching entity count */}
      <p className="text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{matchCount}</span> of {totalCount}{" "}
        {levelPlural} match the {active.length ? "filters" : "(no filters)"}.
      </p>
    </div>
  );
}
