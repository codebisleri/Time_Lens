"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
  CheckCircle2,
  CopyX,
  FileX2,
  ShieldAlert,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/data-table/data-table";
import { EmptyState } from "@/components/feedback/empty-state";
import { formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { RowIssue, UploadSummary } from "./types";

const issueColumns: ColumnDef<RowIssue>[] = [
  {
    accessorKey: "row",
    header: "Row",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-muted-foreground">
        #{formatNumber(row.original.row)}
      </span>
    ),
  },
  {
    accessorKey: "field",
    header: "Field",
    cell: ({ row }) => (
      <span className="font-mono text-xs">{row.original.field}</span>
    ),
  },
  { accessorKey: "issue", header: "Issue" },
  {
    accessorKey: "severity",
    header: "Severity",
    cell: ({ row }) => (
      <Badge
        variant={row.original.severity === "error" ? "destructive" : "warning"}
        className="capitalize"
      >
        {row.original.severity}
      </Badge>
    ),
  },
];

function Metric({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  icon: typeof CheckCircle2;
  tone: "neutral" | "warning" | "destructive";
}) {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon
          className={cn(
            "size-4",
            tone === "destructive" && "text-destructive",
            tone === "warning" && "text-warning",
            tone === "neutral" && "text-success",
          )}
        />
        {label}
      </div>
      <p className="mt-2 text-xl font-semibold tracking-tight tabular-nums">
        {formatNumber(value)}
      </p>
    </div>
  );
}

/** Post-upload validation results: headline metrics + per-row issues table. */
export function ValidationPanel({ summary }: { summary: UploadSummary }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Validation results</CardTitle>
        <CardDescription>
          Summary of the most recent upload and any data quality issues found.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Metric
            label="Rows processed"
            value={summary.rowsProcessed}
            icon={CheckCircle2}
            tone="neutral"
          />
          <Metric
            label="Rows rejected"
            value={summary.rowsRejected}
            icon={FileX2}
            tone="destructive"
          />
          <Metric
            label="Missing values"
            value={summary.missingValues}
            icon={ShieldAlert}
            tone="warning"
          />
          <Metric
            label="Duplicate SKUs"
            value={summary.duplicateSkus}
            icon={CopyX}
            tone="warning"
          />
        </div>

        {summary.issues.length ? (
          <DataTable columns={issueColumns} data={summary.issues} />
        ) : (
          <EmptyState
            icon={CheckCircle2}
            title="No issues found"
            description="All rows passed validation."
          />
        )}
      </CardContent>
    </Card>
  );
}
