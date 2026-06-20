"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { CheckCircle2, ClipboardList, ListChecks, XCircle } from "lucide-react";
import { PageShell } from "@/components/layout/page-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable } from "@/components/data-table/data-table";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useAsync } from "@/lib/hooks";
import { forecastService } from "@/lib/api/services";
import { formatNumber, formatPercent } from "@/lib/utils/format";
import type { ForecastSummary } from "@/types/forecast";
import { WorkflowLock } from "@/features/workflow/workflow-lock";
import { useWorkflowStatus } from "@/features/workflow/use-workflow-status";
import { routes } from "@/lib/constants/routes";
import { ReviewDrawer } from "./review-drawer";
import {
  DECISION_LABEL,
  DECISION_VARIANT,
  REVIEW_STORAGE_KEY,
  type ReviewDecision,
  type ReviewMap,
} from "./review-types";

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof CheckCircle2;
  label: string;
  value: number;
  tone: "neutral" | "success" | "destructive";
}) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon
          className={
            tone === "success"
              ? "size-4 text-success"
              : tone === "destructive"
                ? "size-4 text-destructive"
                : "size-4 text-primary"
          }
        />
        {label}
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-foreground">
        {formatNumber(value)}
      </p>
    </Card>
  );
}

/**
 * Forecast Review — the planner's approval screen over real generated forecasts.
 * Approve / reject / override / notes are captured per forecast and persisted
 * locally (the bridge has no approval store yet). Mirrors the Streamlit
 * "Forecast Submission" stage.
 */
export function ForecastReviewView() {
  const workflow = useWorkflowStatus();
  const forecasts = useAsync(
    () => forecastService.list({ page: 1, pageSize: 500 }),
    [],
  );
  const [reviews, setReviews] = useState<ReviewMap>({});
  const [active, setActive] = useState<ForecastSummary | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(REVIEW_STORAGE_KEY);
      if (saved) setReviews(JSON.parse(saved));
    } catch {
      /* ignore */
    }
  }, []);

  const persist = useCallback((next: ReviewMap) => {
    setReviews(next);
    try {
      localStorage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore quota */
    }
  }, []);

  const items = useMemo<ForecastSummary[]>(
    () => forecasts.data?.items ?? [],
    [forecasts.data],
  );

  const counts = useMemo(() => {
    let approved = 0;
    let rejected = 0;
    for (const it of items) {
      const d = reviews[it.id]?.decision;
      if (d === "approved") approved += 1;
      else if (d === "rejected") rejected += 1;
    }
    return { total: items.length, approved, rejected, pending: items.length - approved - rejected };
  }, [items, reviews]);

  const openReview = useCallback((summary: ForecastSummary) => {
    setActive(summary);
    setOpen(true);
  }, []);

  const saveReview = useCallback(
    (decision: ReviewDecision, overrideUnits: number | null, notes: string) => {
      if (!active) return;
      persist({
        ...reviews,
        [active.id]: {
          decision,
          overrideUnits,
          notes,
          updatedAt: new Date().toISOString(),
        },
      });
    },
    [active, reviews, persist],
  );

  const columns = useMemo<ColumnDef<ForecastSummary>[]>(
    () => [
      {
        accessorKey: "skuCode",
        header: "SKU",
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
        accessorKey: "model",
        header: "Model",
        cell: ({ row }) => (
          <Badge variant="secondary">{row.original.model}</Badge>
        ),
      },
      {
        accessorKey: "accuracy",
        header: "Accuracy",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.accuracy != null
              ? formatPercent(row.original.accuracy)
              : "—"}
          </span>
        ),
      },
      {
        id: "units",
        header: "Forecast units",
        cell: ({ row }) => {
          const override = reviews[row.original.id]?.overrideUnits;
          const base = Math.round(row.original.totalForecastUnits);
          return (
            <span className="tabular-nums text-foreground">
              {override != null ? (
                <>
                  {formatNumber(override)}{" "}
                  <span className="text-xs text-muted-foreground line-through">
                    {formatNumber(base)}
                  </span>
                </>
              ) : (
                formatNumber(base)
              )}
            </span>
          );
        },
      },
      {
        id: "decision",
        header: "Status",
        cell: ({ row }) => {
          const d = reviews[row.original.id]?.decision ?? "pending";
          return <Badge variant={DECISION_VARIANT[d]}>{DECISION_LABEL[d]}</Badge>;
        },
      },
    ],
    [reviews],
  );

  const gated =
    !workflow.isLoading && workflow.data && !workflow.data.forecastCompleted;

  if (gated) {
    return (
      <PageShell
        title="Forecast Review"
        description="Step 6 — review, override, and approve generated forecasts."
      >
        <WorkflowLock
          title="No forecasts to review"
          message="Run a forecast first."
          href={routes.forecast}
          ctaLabel="Go to Forecast"
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Forecast Review"
      description="Review, override, and approve generated forecasts before submission."
    >

      {forecasts.isLoading ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="p-5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-3 h-7 w-16" />
            </Card>
          ))}
        </div>
      ) : forecasts.isError ? null : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard icon={ListChecks} label="Total" value={counts.total} tone="neutral" />
          <StatCard icon={CheckCircle2} label="Approved" value={counts.approved} tone="success" />
          <StatCard icon={XCircle} label="Rejected" value={counts.rejected} tone="destructive" />
          <StatCard icon={ClipboardList} label="Pending" value={counts.pending} tone="neutral" />
        </div>
      )}

      <Card>
        <CardContent className="pt-6">
          {forecasts.isError ? (
            <ErrorState
              title="Couldn’t load forecasts"
              message={forecasts.error?.message}
              onRetry={() => void forecasts.refetch().catch(() => {})}
            />
          ) : forecasts.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No forecasts to review"
              description="Run a forecast from the configuration page to populate the review queue."
            />
          ) : (
            <DataTable columns={columns} data={items} onRowClick={openReview} />
          )}
        </CardContent>
      </Card>

      <ReviewDrawer
        summary={active}
        record={active ? reviews[active.id] : undefined}
        open={open}
        onOpenChange={setOpen}
        onSave={saveReview}
      />
    </PageShell>
  );
}
