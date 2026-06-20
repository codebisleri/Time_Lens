"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/features/data/controls";
import { cn } from "@/lib/utils";
import { formatDateTime, formatNumber } from "@/lib/utils/format";
import type { SubmissionBatch, SubmissionRow } from "@/types/submission";

function Summary({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone: "neutral" | "success" | "warning";
}) {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3">
      <p
        className={cn(
          "text-xl font-semibold tabular-nums",
          tone === "success"
            ? "text-success"
            : tone === "warning"
              ? "text-warning"
              : "text-foreground",
        )}
      >
        {formatNumber(value)}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

/**
 * Submit panel — submitter + notes, whole-plan audit summary (overrides /
 * with-reason / missing-reason), the missing-reason warning, the submit action,
 * CSV download, and the batch audit trail.
 */
export function SubmissionPanel({
  planRows,
  defaultReason,
  batches,
  submitting,
  exporting,
  onSubmit,
  onExport,
}: {
  planRows: SubmissionRow[];
  defaultReason: string;
  batches: SubmissionBatch[];
  submitting: boolean;
  exporting: boolean;
  onSubmit: (submitter: string, notes: string) => Promise<SubmissionBatch>;
  onExport: () => void;
}) {
  const [submitter, setSubmitter] = useState("demo_planner");
  const [notes, setNotes] = useState("");
  const [done, setDone] = useState<SubmissionBatch | null>(null);

  const stats = useMemo(() => {
    let overrides = 0;
    let withReason = 0;
    for (const r of planRows) {
      if (r.submittedForecast !== r.modelForecast) {
        overrides += 1;
        if (r.reason && r.reason !== defaultReason) withReason += 1;
      }
    }
    return { overrides, withReason, missing: overrides - withReason };
  }, [planRows, defaultReason]);

  async function handleSubmit() {
    try {
      const batch = await onSubmit(submitter.trim() || "demo_planner", notes.trim());
      setDone(batch);
    } catch {
      /* error surfaced by the view */
    }
  }

  return (
    <Card className="space-y-5 p-5">
      <h3 className="text-sm font-medium text-foreground">
        📤 Submit final forecast
      </h3>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Submitter name / planner ID">
          <Input
            value={submitter}
            onChange={(e) => setSubmitter(e.target.value)}
            className="h-9"
          />
        </Field>
        <Field label="Submission notes (overall plan-cycle context)">
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Context for this plan cycle…"
            className="flex w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </Field>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Summary value={stats.overrides} label="month-cells overridden" tone="neutral" />
        <Summary value={stats.withReason} label="with a reason" tone="success" />
        <Summary
          value={stats.missing}
          label="missing a reason"
          tone={stats.missing > 0 ? "warning" : "success"}
        />
      </div>

      {stats.missing > 0 ? (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            {formatNumber(stats.missing)} override(s) have no reason recorded.
            Adding a reason makes the plan auditable — you can still submit.
          </span>
        </div>
      ) : null}

      {done ? (
        <div className="flex items-start gap-2 rounded-lg border border-success/40 bg-success/10 p-3 text-sm text-foreground">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
          <span>
            Submitted {formatDateTime(done.submittedAt)} by{" "}
            <strong>{done.submitter}</strong> — {formatNumber(done.overrideCount)}{" "}
            override(s), {done.pctChange > 0 ? "+" : ""}
            {done.pctChange.toFixed(1)}% vs model.
          </span>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          className="flex-1"
          onClick={handleSubmit}
          disabled={submitting || planRows.length === 0}
        >
          <Send className="size-4" />
          {submitting ? "Submitting…" : "Submit forecast"}
        </Button>
        <Button
          variant="outline"
          className="flex-1"
          onClick={onExport}
          disabled={exporting}
        >
          <Download className="size-4" />
          {exporting ? "Preparing…" : "Download CSV"}
        </Button>
      </div>

      <div className="space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Submission audit trail ({batches.length})
        </h4>
        {batches.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No submissions yet for this dataset.
          </p>
        ) : (
          <div className="max-h-64 overflow-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Submitted</th>
                  <th className="px-3 py-2 font-medium">Submitter</th>
                  <th className="px-3 py-2 text-right font-medium">Overrides</th>
                  <th className="px-3 py-2 text-right font-medium">Rows</th>
                  <th className="px-3 py-2 text-right font-medium">Units</th>
                  <th className="px-3 py-2 text-right font-medium">Δ%</th>
                  <th className="px-3 py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id} className="border-t border-border/60">
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                      {formatDateTime(b.submittedAt)}
                    </td>
                    <td className="px-3 py-2">{b.submitter}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(b.overrideCount)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(b.totalRows)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(Math.round(b.totalUnits))}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {b.pctChange > 0 ? "+" : ""}
                      {b.pctChange.toFixed(1)}%
                    </td>
                    <td className="max-w-64 truncate px-3 py-2 text-muted-foreground">
                      {b.notes || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
