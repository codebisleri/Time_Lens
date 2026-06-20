"use client";

import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/data-table/data-table";
import { formatNumber, formatPercent } from "@/lib/utils/format";
import type { SegmentedSku } from "@/types/segmentation";

/** Per-SKU segmentation table. Rows open the trace drawer. */
export function SegmentTable({
  data,
  onRowClick,
}: {
  data: SegmentedSku[];
  onRowClick: (sku: SegmentedSku) => void;
}) {
  const columns = useMemo<ColumnDef<SegmentedSku>[]>(
    () => [
      {
        accessorKey: "sku",
        header: "SKU",
        cell: ({ row }) => (
          <span className="font-mono text-xs font-medium text-foreground">
            {row.original.sku}
          </span>
        ),
      },
      {
        accessorKey: "segment",
        header: "Segment",
        cell: ({ row }) => <Badge variant="secondary">{row.original.segment}</Badge>,
      },
      {
        accessorKey: "volatility",
        header: "Volatility",
        cell: ({ row }) => (
          <span className="capitalize text-muted-foreground">
            {row.original.volatility}
          </span>
        ),
      },
      {
        accessorKey: "contribution",
        header: "Contribution",
        cell: ({ row }) => (
          <span className="capitalize text-muted-foreground">
            {row.original.contribution}
          </span>
        ),
      },
      {
        accessorKey: "revenueSharePct",
        header: "Revenue share",
        cell: ({ row }) => (
          <span className="tabular-nums text-foreground">
            {row.original.revenueSharePct != null
              ? formatPercent(row.original.revenueSharePct / 100)
              : "—"}
          </span>
        ),
      },
      {
        accessorKey: "nPeriods",
        header: "Periods",
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {formatNumber(row.original.nPeriods)}
          </span>
        ),
      },
      {
        accessorKey: "brand",
        header: "Brand",
        cell: ({ row }) => (
          <span className="text-muted-foreground">{row.original.brand ?? "—"}</span>
        ),
      },
    ],
    [],
  );

  // Fixed-height, internally-scrolled, sortable grid — mirrors Streamlit's
  // `st.dataframe(profiles, height=400)` (no pagination; sort by clicking a
  // column header; search/segment filters live above the table).
  return <DataTable columns={columns} data={data} onRowClick={onRowClick} maxHeight={400} />;
}
