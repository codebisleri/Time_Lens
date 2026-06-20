"use client";

import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { FileSpreadsheet, Inbox } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DataTable } from "@/components/data-table/data-table";
import { EmptyState } from "@/components/feedback/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, formatNumber } from "@/lib/utils/format";
import { useAuthStore } from "@/lib/stores";
import type { Dataset } from "@/types/dataset";
import { DatasetStatusBadge } from "./dataset-status-badge";

/**
 * Upload history. Columns: File, Uploaded By, Uploaded Date, Status, Records.
 * Datasets come from the real dataService.listDatasets(); "Uploaded by" is shown
 * from the current user (the Dataset shape carries no uploader field).
 */
export function UploadHistoryTable({ datasets }: { datasets: Dataset[] }) {
  const uploaderName = useAuthStore((s) => s.user?.name ?? "—");

  const columns = useMemo<ColumnDef<Dataset>[]>(
    () => [
      {
        accessorKey: "fileName",
        header: "File",
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <FileSpreadsheet className="size-4 shrink-0 text-muted-foreground" />
            <div className="flex flex-col">
              <span className="font-medium text-foreground">
                {row.original.fileName}
              </span>
              {row.original.skuCount != null ? (
                <span className="text-xs text-muted-foreground">
                  {formatNumber(row.original.skuCount)} SKUs
                </span>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        id: "uploadedBy",
        header: "Uploaded by",
        cell: () => <span className="text-muted-foreground">{uploaderName}</span>,
      },
      {
        accessorKey: "uploadedAt",
        header: "Uploaded",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {formatDate(row.original.uploadedAt)}
          </span>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <DatasetStatusBadge status={row.original.status} />,
      },
      {
        accessorKey: "rowCount",
        header: "Records",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.rowCount != null
              ? formatNumber(row.original.rowCount)
              : "—"}
          </span>
        ),
      },
    ],
    [uploaderName],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Upload history</CardTitle>
        <CardDescription>Previously ingested data files.</CardDescription>
      </CardHeader>
      <CardContent>
        {datasets.length ? (
          <DataTable columns={columns} data={datasets} />
        ) : (
          <EmptyState
            icon={Inbox}
            title="No uploads yet"
            description="Upload a CSV or XLSX file to populate your demand history."
          />
        )}
      </CardContent>
    </Card>
  );
}

export function UploadHistoryTableSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-4 w-52" />
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
