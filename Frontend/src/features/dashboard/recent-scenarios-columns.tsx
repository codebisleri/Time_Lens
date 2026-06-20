import type { ColumnDef } from "@tanstack/react-table";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDate, formatDelta } from "@/lib/utils/format";
import type { Scenario, ScenarioStatus } from "@/types";

const STATUS_VARIANT: Record<
  ScenarioStatus,
  "success" | "warning" | "secondary"
> = {
  active: "success",
  draft: "warning",
  archived: "secondary",
};

export const recentScenarioColumns: ColumnDef<Scenario>[] = [
  {
    accessorKey: "name",
    header: "Scenario",
    cell: ({ row }) => (
      <div className="flex flex-col">
        <span className="font-medium text-foreground">{row.original.name}</span>
        <span className="text-xs capitalize text-muted-foreground">
          {row.original.horizon} · {row.original.levers.length} levers
        </span>
      </div>
    ),
  },
  {
    accessorKey: "createdBy",
    header: "Created by",
    cell: ({ row }) => (
      <span className="text-muted-foreground">
        {row.original.createdBy ?? "—"}
      </span>
    ),
  },
  {
    id: "revenueImpact",
    header: "Revenue impact",
    cell: ({ row }) => {
      const revenue = row.original.summary?.totalProjectedRevenue;
      const delta = row.original.summary?.revenueDeltaPct;
      if (revenue == null) return <span className="text-muted-foreground">—</span>;
      const positive = (delta ?? 0) >= 0;
      return (
        <div className="flex items-center gap-2">
          <span className="font-medium tabular-nums text-foreground">
            {formatCurrency(revenue)}
          </span>
          {delta != null ? (
            <span
              className={cn(
                "flex items-center gap-0.5 text-xs font-medium",
                positive ? "text-success" : "text-destructive",
              )}
            >
              {positive ? (
                <ArrowUpRight className="size-3" />
              ) : (
                <ArrowDownRight className="size-3" />
              )}
              {formatDelta(delta)}
            </span>
          ) : null}
        </div>
      );
    },
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => (
      <Badge variant={STATUS_VARIANT[row.original.status]} className="capitalize">
        {row.original.status}
      </Badge>
    ),
  },
  {
    accessorKey: "createdAt",
    header: "Created",
    cell: ({ row }) => (
      <span className="text-muted-foreground">
        {formatDate(row.original.createdAt)}
      </span>
    ),
  },
];
