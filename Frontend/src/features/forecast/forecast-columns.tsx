"use client";

import type { Column, ColumnDef } from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { formatNumber, formatPercent } from "@/lib/utils/format";
import {
  FORECAST_HEALTH_LABELS,
  FORECAST_HEALTH_VARIANT,
  type ForecastResultRow,
} from "./derive";

/** Friendly label per column id, used by the column-visibility menu. */
export const FORECAST_COLUMN_LABELS: Record<string, string> = {
  skuCode: "SKU",
  category: "Category",
  forecastUnits: "Forecast",
  actualUnits: "Actual",
  varianceUnits: "Variance",
  accuracy: "Accuracy %",
  status: "Status",
};

/** Columns that always stay visible / can't be hidden. */
export const FORECAST_LOCKED_COLUMNS = ["select", "skuCode"];

function SortableHeader({
  column,
  label,
  align = "left",
}: {
  column: Column<ForecastResultRow, unknown>;
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

/** Signed variance with a directional, tinted indicator. */
export function VarianceTag({
  units,
  pct,
}: {
  units: number;
  pct: number;
}) {
  const positive = units >= 0;
  return (
    <span
      className={cn(
        "inline-flex items-center justify-end gap-1 tabular-nums",
        positive ? "text-success" : "text-destructive",
      )}
    >
      {positive ? (
        <TrendingUp className="size-3.5" />
      ) : (
        <TrendingDown className="size-3.5" />
      )}
      {positive ? "+" : "−"}
      {formatNumber(Math.abs(units))}
      <span className="text-xs text-muted-foreground">
        ({formatPercent(Math.abs(pct))})
      </span>
    </span>
  );
}

/** Accuracy value tinted by its health band. */
export function AccuracyValue({ row }: { row: ForecastResultRow }) {
  const tone =
    row.status === "healthy"
      ? "text-success"
      : row.status === "warning"
        ? "text-warning"
        : "text-destructive";
  return (
    <span className={cn("font-medium tabular-nums", tone)}>
      {formatPercent(row.accuracy)}
    </span>
  );
}

export function ForecastStatusBadge({ row }: { row: ForecastResultRow }) {
  return (
    <Badge variant={FORECAST_HEALTH_VARIANT[row.status]}>
      {FORECAST_HEALTH_LABELS[row.status]}
    </Badge>
  );
}

/**
 * Column definitions for the Forecast Results table. The leading `select`
 * column and stable column ids keep the structure ready for a future approval
 * workflow, bulk approval, and export-selected without reshaping the table.
 */
export const forecastColumns: ColumnDef<ForecastResultRow>[] = [
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
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        aria-label="Select all rows on this page"
      />
    ),
    cell: ({ row }) => (
      <div onClick={(e) => e.stopPropagation()} className="flex">
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          aria-label={`Select ${row.original.skuCode}`}
        />
      </div>
    ),
  },
  {
    accessorKey: "skuCode",
    header: ({ column }) => (
      <SortableHeader column={column} label={FORECAST_COLUMN_LABELS.skuCode!} />
    ),
    cell: ({ row }) => (
      <div className="flex flex-col">
        <span className="font-mono text-xs font-medium text-foreground">
          {row.original.skuCode}
        </span>
        <span className="text-xs text-muted-foreground">
          {row.original.skuName}
        </span>
      </div>
    ),
  },
  {
    accessorKey: "category",
    header: ({ column }) => (
      <SortableHeader column={column} label={FORECAST_COLUMN_LABELS.category!} />
    ),
    cell: ({ row }) => (
      <span className="text-muted-foreground">{row.original.category}</span>
    ),
  },
  {
    accessorKey: "forecastUnits",
    header: ({ column }) => (
      <SortableHeader
        column={column}
        label={FORECAST_COLUMN_LABELS.forecastUnits!}
        align="right"
      />
    ),
    cell: ({ row }) => (
      <span className="block text-right tabular-nums text-foreground">
        {formatNumber(row.original.forecastUnits)}
      </span>
    ),
  },
  {
    accessorKey: "actualUnits",
    header: ({ column }) => (
      <SortableHeader
        column={column}
        label={FORECAST_COLUMN_LABELS.actualUnits!}
        align="right"
      />
    ),
    cell: ({ row }) => (
      <span className="block text-right tabular-nums text-foreground">
        {formatNumber(row.original.actualUnits)}
      </span>
    ),
  },
  {
    accessorKey: "varianceUnits",
    header: ({ column }) => (
      <SortableHeader
        column={column}
        label={FORECAST_COLUMN_LABELS.varianceUnits!}
        align="right"
      />
    ),
    cell: ({ row }) => (
      <div className="text-right">
        <VarianceTag
          units={row.original.varianceUnits}
          pct={row.original.variancePct}
        />
      </div>
    ),
  },
  {
    accessorKey: "accuracy",
    header: ({ column }) => (
      <SortableHeader
        column={column}
        label={FORECAST_COLUMN_LABELS.accuracy!}
        align="right"
      />
    ),
    cell: ({ row }) => (
      <div className="text-right">
        <AccuracyValue row={row.original} />
      </div>
    ),
  },
  {
    accessorKey: "status",
    header: ({ column }) => (
      <SortableHeader column={column} label={FORECAST_COLUMN_LABELS.status!} />
    ),
    cell: ({ row }) => <ForecastStatusBadge row={row.original} />,
  },
];
