"use client";

import type { Column, ColumnDef } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDate, formatPercent } from "@/lib/utils/format";
import type { SkuRow } from "./derive";
import { SKU_STATUS_VARIANT } from "./derive";

/** Friendly label per column id, used by the column-visibility menu. */
export const SKU_COLUMN_LABELS: Record<string, string> = {
  code: "SKU Code",
  name: "Product Name",
  category: "Category",
  unitPrice: "Price",
  forecastMethodLabel: "Forecast Method",
  status: "Status",
  updatedAt: "Last Updated",
};

/** Columns that always stay visible / can't be hidden from the menu. */
export const SKU_LOCKED_COLUMNS = ["select", "code"];

/** Sortable header button with a direction indicator. */
function SortableHeader({
  column,
  label,
  align = "left",
}: {
  column: Column<SkuRow, unknown>;
  label: string;
  align?: "left" | "right";
}) {
  const sorted = column.getIsSorted();
  return (
    <button
      type="button"
      onClick={() => column.toggleSorting(sorted === "asc")}
      className={cn(
        "group/sort inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground",
        align === "right" && "flex-row-reverse",
      )}
    >
      {label}
      {sorted === "asc" ? (
        <ArrowUp className="size-3.5" />
      ) : sorted === "desc" ? (
        <ArrowDown className="size-3.5" />
      ) : (
        <ChevronsUpDown className="size-3.5 opacity-40 transition-opacity group-hover/sort:opacity-100" />
      )}
    </button>
  );
}

/**
 * Column definitions for the SKU catalog table. Authored per-feature and passed
 * into TanStack Table. The leading `select` column and per-column `meta.label`
 * keep the structure ready for future bulk actions, row actions, and a
 * configurable column-visibility menu without reshaping the table.
 */
export const skuColumns: ColumnDef<SkuRow>[] = [
  {
    id: "select",
    enableSorting: false,
    enableHiding: false,
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllPageRowsSelected() ||
          (table.getIsSomePageRowsSelected() && "indeterminate")
        }
        onCheckedChange={(value) =>
          table.toggleAllPageRowsSelected(!!value)
        }
        aria-label="Select all rows on this page"
      />
    ),
    cell: ({ row }) => (
      // Stop propagation so toggling selection never opens the detail drawer.
      <div onClick={(e) => e.stopPropagation()} className="flex">
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          aria-label={`Select ${row.original.code}`}
        />
      </div>
    ),
  },
  {
    accessorKey: "code",
    header: ({ column }) => (
      <SortableHeader column={column} label={SKU_COLUMN_LABELS.code!} />
    ),
    cell: ({ row }) => (
      <span className="font-mono text-xs font-medium text-foreground">
        {row.original.code}
      </span>
    ),
  },
  {
    accessorKey: "name",
    header: ({ column }) => (
      <SortableHeader column={column} label={SKU_COLUMN_LABELS.name!} />
    ),
    cell: ({ row }) => (
      <div className="flex flex-col">
        <span className="font-medium text-foreground">{row.original.name}</span>
        {row.original.brand ? (
          <span className="text-xs text-muted-foreground">
            {row.original.brand}
          </span>
        ) : null}
      </div>
    ),
  },
  {
    accessorKey: "category",
    header: ({ column }) => (
      <SortableHeader column={column} label={SKU_COLUMN_LABELS.category!} />
    ),
    cell: ({ row }) => (
      <span className="text-muted-foreground">{row.original.category}</span>
    ),
  },
  {
    accessorKey: "unitPrice",
    header: ({ column }) => (
      <SortableHeader
        column={column}
        label={SKU_COLUMN_LABELS.unitPrice!}
        align="right"
      />
    ),
    cell: ({ row }) => (
      <span className="block text-right tabular-nums text-foreground">
        {row.original.unitPrice != null
          ? formatCurrency(row.original.unitPrice)
          : "—"}
      </span>
    ),
  },
  {
    accessorKey: "forecastMethodLabel",
    header: ({ column }) => (
      <SortableHeader
        column={column}
        label={SKU_COLUMN_LABELS.forecastMethodLabel!}
      />
    ),
    cell: ({ row }) =>
      row.original.forecastModel ? (
        <Badge variant="secondary">{row.original.forecastMethodLabel}</Badge>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    accessorKey: "status",
    header: ({ column }) => (
      <SortableHeader column={column} label={SKU_COLUMN_LABELS.status!} />
    ),
    cell: ({ row }) => (
      <Badge
        variant={SKU_STATUS_VARIANT[row.original.status]}
        className="capitalize"
      >
        {row.original.status}
      </Badge>
    ),
  },
  {
    accessorKey: "updatedAt",
    header: ({ column }) => (
      <SortableHeader column={column} label={SKU_COLUMN_LABELS.updatedAt!} />
    ),
    cell: ({ row }) => (
      <span className="text-muted-foreground">
        {formatDate(row.original.updatedAt)}
      </span>
    ),
  },
];

/** Compact accuracy text reused by the mobile card + drawer. */
export function formatAccuracy(value?: number): string {
  return value != null ? formatPercent(value) : "—";
}
