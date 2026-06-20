"use client";

import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Generic, domain-agnostic table built on TanStack Table. Column definitions
 * are authored per-feature (e.g. features/sku/columns.tsx) and passed in here.
 * Powers SKU Management, Forecast Results, and Reports lists. Server-side
 * pagination/sorting can be wired by lifting `sorting` and passing
 * `manualSorting`.
 */
interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  /** Optional row click handler (e.g. navigate to detail). */
  onRowClick?: (row: TData) => void;
  className?: string;
  /** Fixed viewport height (px) → internal scroll with a sticky header, mirroring
   *  Streamlit's `st.dataframe(height=…)`. Omit for a full-length table. */
  maxHeight?: number;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  onRowClick,
  className,
  maxHeight,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div
      className={cn("overflow-auto rounded-lg border border-border", className)}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-secondary/80 shadow-[inset_0_-1px_0_hsl(var(--border))] backdrop-blur supports-[backdrop-filter]:bg-secondary/70">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const canSort = header.column.getCanSort();
                const dir = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
                    className={cn(
                      "group/th h-11 px-4 text-left align-middle text-[11px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors",
                      canSort && "cursor-pointer select-none hover:text-foreground",
                      dir && "text-foreground",
                    )}
                    onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                  >
                    {header.isPlaceholder ? null : (
                      <span className="inline-flex items-center gap-1.5">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {canSort ? (
                          <span
                            className={cn(
                              "text-[10px] leading-none transition-opacity",
                              dir
                                ? "text-brand-accent opacity-100"
                                : "opacity-30 group-hover/th:opacity-70",
                            )}
                            aria-hidden
                          >
                            {dir === "asc" ? "▲" : dir === "desc" ? "▼" : "↕"}
                          </span>
                        ) : null}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.length ? (
            table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                onClick={() => onRowClick?.(row.original)}
                className={cn(
                  "border-b border-border/60 transition-colors hover:bg-accent/60",
                  onRowClick && "cursor-pointer",
                )}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 py-2.5 align-middle">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td
                colSpan={columns.length}
                className="px-4 py-10 text-center text-muted-foreground"
              >
                No results.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
