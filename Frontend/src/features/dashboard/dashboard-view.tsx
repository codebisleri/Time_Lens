"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LayoutDashboard } from "lucide-react";
import { PageShell } from "@/components/layout/page-shell";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/feedback/error-state";
import { useAsync } from "@/lib/hooks";
import { reportsService } from "@/lib/api/services";
import { routes } from "@/lib/constants/routes";
import { formatNumber } from "@/lib/utils/format";
import { WorkflowHero } from "@/features/workflow/workflow-hero";
import { WorkflowLock } from "@/features/workflow/workflow-lock";
import { useWorkflowStatus } from "@/features/workflow/use-workflow-status";
import { ReportSummaryPanel } from "@/features/report/report-summary";
import {
  ForecastIntelligenceStrip,
  IntelligenceLegend,
} from "./forecast-intelligence";

/**
 * Overview — a thin, real-data summary of the single active workflow (dataset,
 * forecast headline, segments, opportunities) sourced from /reports/summary.
 * Single-workflow mode: there is no dataset yet ⇒ this page is inaccessible and
 * the user is sent to Data Upload. No seeded/mock metrics are shown.
 */
export function DashboardView() {
  const router = useRouter();
  const workflow = useWorkflowStatus();
  const hasDataset = !!workflow.data?.datasetUploaded;
  const noDataset =
    !workflow.isLoading && workflow.data && !workflow.data.datasetUploaded;

  // No active dataset → the workflow hasn't started; send the user to step 1.
  useEffect(() => {
    if (noDataset) router.replace(routes.data);
  }, [noDataset, router]);

  // Only load the real overview once a dataset exists (avoids a 404 flash).
  const summary = useAsync(
    () => (hasDataset ? reportsService.summary() : Promise.resolve(null)),
    [hasDataset],
  );

  if (workflow.isLoading || noDataset) {
    return (
      <PageShell title="Overview" description="Your forecasting workflow at a glance.">
        {noDataset ? (
          <WorkflowLock
            title="No dataset yet"
            message="Upload a dataset to begin."
            href={routes.data}
            ctaLabel="Go to Data"
          />
        ) : (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i} className="p-5">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="mt-3 h-7 w-20" />
              </Card>
            ))}
          </div>
        )}
      </PageShell>
    );
  }

  const s = summary.data;
  return (
    <PageShell
      title="Overview"
      description="Executive view of the active demand-forecasting workflow — health, planning status, and what to action next."
    >
      <WorkflowHero
        step="Executive Overview"
        title="Forecast Intelligence Center"
        subtitle="Demand forecast health, planning status, and model readiness across the active portfolio."
        icon={LayoutDashboard}
        variant="horizon"
        metrics={
          s
            ? [
                { label: "Portfolio SKUs", value: formatNumber(s.dataset.skuCount ?? 0) },
                { label: "SKUs forecast", value: formatNumber(s.forecast.skusForecasted) },
                {
                  label: "Median WMAPE",
                  value:
                    s.forecast.medianTestWmape == null
                      ? "—"
                      : `${s.forecast.medianTestWmape.toFixed(1)}%`,
                },
                {
                  label: "Forecast units",
                  value: formatNumber(Math.round(s.forecast.totalForecastUnits ?? 0)),
                },
              ]
            : undefined
        }
      />

      {summary.isError ? (
        <ErrorState
          title="Couldn’t load the overview"
          message={summary.error?.message}
          onRetry={() => void summary.refetch().catch(() => {})}
        />
      ) : summary.isLoading || !s ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="p-5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-3 h-7 w-20" />
            </Card>
          ))}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold tracking-tight text-foreground">
              Forecast &amp; planning status
            </h2>
            <IntelligenceLegend />
          </div>
          <ForecastIntelligenceStrip summary={s} />
          <ReportSummaryPanel summary={s} />
        </>
      )}
    </PageShell>
  );
}
