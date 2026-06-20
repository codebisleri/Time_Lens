"use client";

import { Check, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { useAsync } from "@/lib/hooks";
import { segmentationService } from "@/lib/api/services";
import type { SegmentedSku, SegmentationThresholds } from "@/types/segmentation";
import { formatNumber, formatPercent } from "@/lib/utils/format";

const CONTENT_CLASS =
  "w-full p-0 sm:max-w-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right data-[state=open]:fade-in data-[state=closed]:fade-out duration-200";

/**
 * Trace SKU — shows the step-by-step segmentation decision (engine
 * explain_sku_segment) plus the SKU's stats. Fetches on open.
 */
export function SegmentTraceDrawer({
  sku,
  open,
  onOpenChange,
  thresholds,
}: {
  sku: SegmentedSku | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  thresholds?: SegmentationThresholds;
}) {
  const trace = useAsync(
    async () => (open && sku ? segmentationService.trace(sku.sku, thresholds) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, sku?.sku, JSON.stringify(thresholds ?? {})],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className={CONTENT_CLASS}>
        <div className="flex h-full flex-col">
          <SheetHeader className="flex-row items-start justify-between border-b border-border p-5">
            <div className="space-y-1">
              <SheetTitle>{sku?.sku ?? "SKU trace"}</SheetTitle>
              <SheetDescription>
                {sku ? `${sku.segment}` : "Segmentation decision trace"}
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
            <div className="space-y-5 p-5">
              {sku ? (
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <Stat label="Volatility" value={sku.volatility} />
                  <Stat label="Contribution" value={sku.contribution} />
                  <Stat label="Pattern" value={sku.intermittency} />
                  <Stat
                    label="Revenue share"
                    value={sku.revenueSharePct != null ? formatPercent(sku.revenueSharePct / 100) : "—"}
                  />
                  <Stat
                    label="CV"
                    value={sku.cv != null ? formatNumber(sku.cv, { maximumFractionDigits: 2 }) : "—"}
                  />
                  <Stat label="Periods" value={formatNumber(sku.nPeriods)} />
                </dl>
              ) : null}

              <div className="space-y-1.5">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Decision trace
                </h3>
                {trace.isLoading ? (
                  <div className="space-y-2">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <Skeleton key={i} className="h-12 w-full" />
                    ))}
                  </div>
                ) : trace.isError ? (
                  <ErrorState
                    title="Couldn’t load trace"
                    message={trace.error?.message}
                    onRetry={() => void trace.refetch().catch(() => {})}
                  />
                ) : trace.data ? (
                  <ol className="space-y-2">
                    {trace.data.steps.map((s) => (
                      <li
                        key={s.step}
                        className="rounded-md border border-border/60 bg-card/40 p-3"
                      >
                        <div className="flex items-center gap-2">
                          <span className="flex size-5 items-center justify-center rounded-full border border-border text-xs tabular-nums text-muted-foreground">
                            {s.step}
                          </span>
                          <span className="text-sm font-medium text-foreground">
                            {s.name}
                          </span>
                          {s.stop ? (
                            <Badge variant="success" className="ml-auto">
                              <Check className="size-3" /> final
                            </Badge>
                          ) : null}
                        </div>
                        <p className="mt-1.5 text-xs text-muted-foreground">{s.detail}</p>
                        <p
                          className="mt-1 text-xs font-medium text-foreground"
                          dangerouslySetInnerHTML={{ __html: mdBold(s.verdict) }}
                        />
                      </li>
                    ))}
                  </ol>
                ) : null}
                {trace.data?.final ? (
                  <div className="pt-2 text-sm">
                    Final segment:{" "}
                    <Badge variant="default">{trace.data.final}</Badge>
                  </div>
                ) : null}
              </div>
            </div>
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium capitalize text-foreground">{value}</dd>
    </div>
  );
}

/** Render the engine's **bold** markers as <strong> (verdict strings use them). */
function mdBold(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}
