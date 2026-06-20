"use client";

import { useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import {
  ChevronLeft,
  ChevronRight,
  Check,
  SlidersHorizontal,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDate, formatNumber } from "@/lib/utils/format";
import type { SkuRow } from "./derive";
import { SKU_STATUS_VARIANT } from "./derive";
import {
  SKU_COLUMN_LABELS,
  SKU_LOCKED_COLUMNS,
  skuColumns,
} from "./sku-columns";

const PAGE_SIZE_OPTIONS = [10, 20, 50];

/**
 * The SKU catalog table. Built directly on TanStack Table (rather than the
 * generic DataTable) because the catalog needs the full feature set: sorting,
 * pagination, column visibility, and row selection. Selection + a leading
 * checkbox column are wired now so future bulk actions / row actions slot in
 * without restructuring. Renders a full table on desktop and stacked cards on
 * mobile from the same row model.
 */
export function SkuTable({
  data,
  onRowClick,
}: {
  data: SkuRow[];
  onRowClick: (sku: SkuRow) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [rowSelection, setRowSelection] = useState({});
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  const table = useReactTable({
    data,
    columns: skuColumns as ColumnDef<SkuRow>[],
    state: { sorting, rowSelection, columnVisibility },
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 10 } },
  });

  const selectedCount = table.getSelectedRowModel().rows.length;
  const totalRows = data.length;
  const { pageIndex, pageSize } = table.getState().pagination;
  const pageStart = pageIndex * pageSize;

  const hideableColumns = table
    .getAllColumns()
    .filter((c) => c.getCanHide() && !SKU_LOCKED_COLUMNS.includes(c.id));

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {selectedCount > 0 ? (
            <span className="font-medium text-foreground">
              {formatNumber(selectedCount)} selected
            </span>
          ) : (
            <>
              {formatNumber(data.length)}{" "}
              {data.length === 1 ? "SKU" : "SKUs"}
            </>
          )}
        </p>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <SlidersHorizontal className="size-4" /> Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {hideableColumns.map((column) => (
              <DropdownMenuItem
                key={column.id}
                onSelect={(e) => {
                  e.preventDefault();
                  column.toggleVisibility(!column.getIsVisible());
                }}
                className="justify-between capitalize"
              >
                <span>{SKU_COLUMN_LABELS[column.id] ?? column.id}</span>
                {column.getIsVisible() ? (
                  <Check className="size-4 text-primary" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-lg border border-border md:block">
        <table className="w-full text-sm">
          <thead className="bg-secondary/40">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b border-border">
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="h-10 px-4 text-left align-middle"
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                onClick={() => onRowClick(row.original)}
                data-state={row.getIsSelected() ? "selected" : undefined}
                className={cn(
                  "cursor-pointer border-b border-border/60 transition-colors hover:bg-secondary/30",
                  "data-[state=selected]:bg-primary/5",
                )}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 py-2.5 align-middle">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile stacked cards */}
      <div className="space-y-3 md:hidden">
        {table.getRowModel().rows.map((row) => {
          const sku = row.original;
          return (
            <Card
              key={row.id}
              onClick={() => onRowClick(sku)}
              data-state={row.getIsSelected() ? "selected" : undefined}
              className="cursor-pointer p-4 transition-colors hover:border-border data-[state=selected]:border-primary/40 data-[state=selected]:bg-primary/5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div onClick={(e) => e.stopPropagation()} className="pt-0.5">
                    <Checkbox
                      checked={row.getIsSelected()}
                      onCheckedChange={(v) => row.toggleSelected(!!v)}
                      aria-label={`Select ${sku.code}`}
                    />
                  </div>
                  <div className="space-y-0.5">
                    <p className="font-medium text-foreground">{sku.name}</p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {sku.code}
                    </p>
                  </div>
                </div>
                <Badge
                  variant={SKU_STATUS_VARIANT[sku.status]}
                  className="capitalize"
                >
                  {sku.status}
                </Badge>
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Category</dt>
                  <dd className="text-foreground">{sku.category}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Price</dt>
                  <dd className="tabular-nums text-foreground">
                    {sku.unitPrice != null
                      ? formatCurrency(sku.unitPrice)
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    Forecast method
                  </dt>
                  <dd className="text-foreground">{sku.forecastMethodLabel}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Updated</dt>
                  <dd className="text-foreground">
                    {formatDate(sku.updatedAt)}
                  </dd>
                </div>
              </dl>
            </Card>
          );
        })}
      </div>

      {/* Pagination */}
      <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
        <p className="text-xs text-muted-foreground">
          Showing{" "}
          <span className="font-medium text-foreground">
            {totalRows === 0 ? 0 : pageStart + 1}–
            {Math.min(pageStart + pageSize, data.length)}
          </span>{" "}
          of <span className="font-medium text-foreground">{totalRows}</span>
        </p>

        <div className="flex items-center gap-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                {pageSize} / page
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {PAGE_SIZE_OPTIONS.map((size) => (
                <DropdownMenuItem
                  key={size}
                  onSelect={() => table.setPageSize(size)}
                  className="justify-between"
                >
                  {size} / page
                  {size === pageSize ? (
                    <Check className="size-4 text-primary" />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              aria-label="Previous page"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="px-1 text-xs tabular-nums text-muted-foreground">
              {pageIndex + 1} / {table.getPageCount() || 1}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              aria-label="Next page"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SkuTableSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-24" />
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="border-b border-border bg-secondary/40 p-3">
          <Skeleton className="h-4 w-full" />
        </div>
        <div className="divide-y divide-border/60">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 p-3.5">
              <Skeleton className="size-4 rounded" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="hidden h-4 w-24 sm:block" />
              <Skeleton className="hidden h-5 w-16 rounded-full sm:block" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
