"use client";

import { FileBarChart } from "lucide-react";
import { PageShell } from "@/components/layout/page-shell";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/feedback/error-state";
import { WorkflowHero } from "@/features/workflow/workflow-hero";
import { WorkflowLock } from "@/features/workflow/workflow-lock";
import { useWorkflowStatus } from "@/features/workflow/use-workflow-status";
import { routes } from "@/lib/constants/routes";
import type { GeneratedReport, ReportKind } from "@/types/report";
import { useReport } from "./hooks/use-report";
import { ReportSummaryPanel } from "./report-summary";
import { ReportGenerators } from "./report-generators";

/** Latest generated report per type (backend keeps one per type; be defensive). */
function latestByType(
  reports: GeneratedReport[],
): Partial<Record<ReportKind, GeneratedReport>> {
  const out: Partial<Record<ReportKind, GeneratedReport>> = {};
  for (const r of reports) {
    if (!out[r.type]) out[r.type] = r;
  }
  return out;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h2>
  );
}

/**
 * Report (Step 8) — the executive report hub. Mirrors the Streamlit Report tab:
 * an executive dashboard (summary · forecast · segment · top opportunities) plus
 * one-click HTML report generation, download, and a generated-report history.
 * All HTML is built server-side by the engine's headless build_*_html_report.
 */
export function ReportView() {
  const workflow = useWorkflowStatus();
  const { summary, history, generating, downloading, generate, download } =
    useReport();

  const gated =
    !workflow.isLoading && workflow.data && !workflow.data.datasetUploaded;

  if (gated) {
    return (
      <PageShell
        title="Report"
        description="Step 8 — executive HTML reports for segmentation and the routed forecast."
      >
        <WorkflowLock
          title="No data yet"
          message="Upload a dataset first."
          href={routes.data}
          ctaLabel="Go to Data"
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Report"
      description="Executive HTML reports — self-contained, brandable, emailable. Charts stay interactive."
    >
      <WorkflowHero
        step="Step 8 · Report"
        title="Executive Forecast Reporting"
        subtitle="Self-contained, brandable HTML reports for segmentation and the routed forecast — emailable, with interactive charts."
        icon={FileBarChart}
        variant="band"
      />

      {summary.isError ? (
        <ErrorState
          title="Couldn’t load the report dashboard"
          message={summary.error?.message}
          onRetry={() => void summary.refetch().catch(() => {})}
        />
      ) : summary.isLoading && !summary.data ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i} className="p-5">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="mt-3 h-7 w-20" />
              </Card>
            ))}
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      ) : summary.data ? (
        <div className="space-y-8">
          <div id="summary" className="scroll-mt-24">
            <ReportSummaryPanel summary={summary.data} />
          </div>

          <div id="generate" className="scroll-mt-24 space-y-4">
            <SectionTitle>Generate &amp; download reports</SectionTitle>
            <ReportGenerators
              catalog={summary.data.availableReports}
              latest={latestByType(history.data ?? [])}
              generating={generating}
              downloading={downloading}
              onGenerate={(type) => void generate(type).catch(() => {})}
              onDownload={(r) => void download(r).catch(() => {})}
            />
          </div>
        </div>
      ) : null}
    </PageShell>
  );
}
