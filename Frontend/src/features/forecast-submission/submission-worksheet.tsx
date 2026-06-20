"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { submissionService } from "@/lib/api/services";
import { downloadFile } from "@/lib/utils/download";
import { useSubmission } from "./hooks/use-submission";
import { SubmissionFilters } from "./submission-filters";
import { SubmissionKpiStrip } from "./submission-kpis";
import { SubmissionBulkActions } from "./submission-bulk-actions";
import { SubmissionGrid } from "./submission-grid";
import { SubmissionDrilldown } from "./submission-drilldown";
import { SubmissionPanel } from "./submission-panel";

function LoadingState() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} className="p-5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-3 h-7 w-16" />
          </Card>
        ))}
      </div>
      <Skeleton className="h-[420px] w-full" />
    </div>
  );
}

/**
 * The Forecast Submission worksheet CONTENT (no page chrome) — cascading
 * filters, KPI strip, bulk actions, editable grid, per-SKU drill-down, and the
 * submit/export/audit panel. Shared by the standalone Submission page AND the
 * inline post-forecast workflow, so both render the identical worksheet.
 */
export function SubmissionWorksheet() {
  const {
    filters,
    setFilters,
    query,
    plan,
    audit,
    isMutating,
    applyEdits,
    applyBulk,
    submit,
  } = useSubmission();
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    setExporting(true);
    try {
      const csv = await submissionService.exportCsv();
      const stamp = new Date().toISOString().replace(/[:T]/g, "").slice(0, 13);
      downloadFile(`forecast_submission_${stamp}.csv`, csv);
    } catch {
      /* ignore — export failures are non-fatal */
    } finally {
      setExporting(false);
    }
  }

  const data = query.data;
  const noRun = query.isSuccess && (!data || data.runId === null);

  if (query.isError) {
    return (
      <ErrorState
        title="Couldn’t load the submission worksheet"
        message={query.error?.message}
        onRetry={() => void query.refetch().catch(() => {})}
      />
    );
  }
  if (noRun) {
    return (
      <EmptyState
        title="No forecast to submit yet"
        description="Run a forecast above to build the submission worksheet."
      />
    );
  }
  if (query.isLoading && !data) return <LoadingState />;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <SubmissionFilters
        filters={filters}
        facets={data.facets}
        summary={`${data.filteredRows} month-row(s) · ${data.kpis.skuCount} SKU(s) in view (of ${data.totalSkus} SKUs · ${data.totalRows} total rows).`}
        onChange={setFilters}
      />

      <SubmissionKpiStrip kpis={data.kpis} />

      <SubmissionBulkActions
        reasonOptions={data.reasonOptions}
        rowsInView={data.filteredRows}
        disabled={isMutating}
        onApply={(bulk) => void applyBulk(bulk).catch(() => {})}
      />

      <SubmissionGrid
        rows={data.rows}
        reasonOptions={data.reasonOptions}
        disabled={isMutating}
        onEdit={(edit) => void applyEdits([edit]).catch(() => {})}
      />

      <SubmissionDrilldown rows={data.rows} />

      <SubmissionPanel
        planRows={plan.data?.rows ?? data.rows}
        defaultReason={data.reasonOptions[0] ?? ""}
        batches={audit.data ?? []}
        submitting={isMutating}
        exporting={exporting}
        onSubmit={(submitter, notes) => submit(submitter, notes)}
        onExport={handleExport}
      />
    </div>
  );
}
