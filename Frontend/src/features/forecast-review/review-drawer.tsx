"use client";

import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/feedback/error-state";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { formatNumber, formatPercent } from "@/lib/utils/format";
import type { ForecastSummary } from "@/types/forecast";
import { ForecastMiniTrendChart } from "@/features/forecast/forecast-mini-trend-chart";
import { useForecastDetail } from "@/features/forecast/hooks/use-forecast-detail";
import {
  DECISION_LABEL,
  DECISION_VARIANT,
  type ReviewDecision,
  type ReviewRecord,
} from "./review-types";

const CONTENT_CLASS =
  "w-full p-0 sm:max-w-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right data-[state=open]:fade-in data-[state=closed]:fade-out duration-200";

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
        {value}
      </p>
    </div>
  );
}

/**
 * Planner review drawer: shows the real forecast (history + projection + metrics)
 * and lets the planner override the total, add notes, and approve/reject. The
 * decision is returned to the parent (persisted locally there).
 */
export function ReviewDrawer({
  summary,
  record,
  open,
  onOpenChange,
  onSave,
}: {
  summary: ForecastSummary | null;
  record: ReviewRecord | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (decision: ReviewDecision, overrideUnits: number | null, notes: string) => void;
}) {
  const detail = useForecastDetail(open ? (summary?.id ?? null) : null);
  const [override, setOverride] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  // Re-seed editable fields whenever a different forecast is opened.
  useEffect(() => {
    if (!open || !summary) return;
    setOverride(
      record?.overrideUnits != null
        ? String(record.overrideUnits)
        : String(Math.round(summary.totalForecastUnits)),
    );
    setNotes(record?.notes ?? "");
  }, [open, summary, record]);

  function commit(decision: ReviewDecision) {
    const parsed = Number(override);
    const overrideUnits =
      override.trim() === "" || Number.isNaN(parsed) ? null : parsed;
    onSave(decision, overrideUnits, notes.trim());
    onOpenChange(false);
  }

  const m = detail.data?.metrics;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className={CONTENT_CLASS}>
        <div className="flex h-full flex-col">
          <SheetHeader className="flex-row items-start justify-between border-b border-border p-5">
            <div className="space-y-1">
              <SheetTitle>{summary?.skuCode ?? "Forecast review"}</SheetTitle>
              <SheetDescription>
                {summary ? `${summary.skuName} · ${summary.model}` : "Review"}
              </SheetDescription>
            </div>
            <SheetClose
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors",
                "hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
              aria-label="Close"
            >
              <X className="size-4" />
            </SheetClose>
          </SheetHeader>

          <ScrollArea className="flex-1">
            {summary ? (
              <div className="space-y-6 p-5">
                {record?.decision ? (
                  <Badge variant={DECISION_VARIANT[record.decision]}>
                    {DECISION_LABEL[record.decision]}
                  </Badge>
                ) : null}

                <div className="grid grid-cols-3 gap-3">
                  <Metric
                    label="Accuracy"
                    value={
                      summary.accuracy != null
                        ? formatPercent(summary.accuracy)
                        : "—"
                    }
                  />
                  <Metric
                    label="MAPE"
                    value={m?.mape != null ? formatPercent(m.mape) : "—"}
                  />
                  <Metric
                    label="Bias"
                    value={
                      m?.bias != null
                        ? `${m.bias >= 0 ? "+" : ""}${formatPercent(m.bias)}`
                        : "—"
                    }
                  />
                </div>

                <div className="space-y-2">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Forecast history
                  </h3>
                  {detail.isLoading ? (
                    <Skeleton className="h-[168px] w-full" />
                  ) : detail.isError ? (
                    <ErrorState
                      title="Couldn’t load forecast"
                      message={detail.error?.message}
                      onRetry={() => void detail.refetch().catch(() => {})}
                    />
                  ) : detail.data?.series?.length ? (
                    <ForecastMiniTrendChart series={detail.data.series} />
                  ) : null}
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="override"
                    className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    Override total units
                  </label>
                  <Input
                    id="override"
                    type="number"
                    value={override}
                    onChange={(e) => setOverride(e.target.value)}
                    className="tabular-nums"
                  />
                  <p className="text-xs text-muted-foreground">
                    Model total: {formatNumber(Math.round(summary.totalForecastUnits))}.
                    Clear to keep the model output.
                  </p>
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="notes"
                    className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    Notes
                  </label>
                  <textarea
                    id="notes"
                    rows={3}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Reasoning for the decision…"
                    className="flex w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  />
                </div>
              </div>
            ) : null}
          </ScrollArea>

          <div className="flex items-center gap-2 border-t border-border p-4">
            <Button
              variant="outline"
              className="flex-1 border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={() => commit("rejected")}
              disabled={!summary}
            >
              <X className="size-4" /> Reject
            </Button>
            <Button
              className="flex-1 bg-success text-success-foreground hover:bg-success/90"
              onClick={() => commit("approved")}
              disabled={!summary}
            >
              <Check className="size-4" /> Approve
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
