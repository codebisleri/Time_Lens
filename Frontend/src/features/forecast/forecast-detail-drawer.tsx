"use client";

import { LineChart, X } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/feedback/empty-state";
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
import { formatDate, formatDelta, formatNumber, formatPercent } from "@/lib/utils/format";
import type { ForecastResultRow } from "./derive";
import {
  AccuracyValue,
  ForecastStatusBadge,
  VarianceTag,
} from "./forecast-columns";
import { ForecastMiniTrendChart } from "./forecast-mini-trend-chart";
import { useForecastDetail } from "./hooks/use-forecast-detail";

const CONTENT_CLASS =
  "w-full p-0 sm:max-w-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right data-[state=open]:fade-in data-[state=closed]:fade-out duration-200";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right text-sm font-medium text-foreground">
        {value}
      </dd>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </div>
  );
}

/**
 * Read-only forecast detail drawer. Opens over the analytics page (no
 * navigation). General info + headline metrics render instantly from the row;
 * bias and the history spark are fetched fresh by id (with a skeleton). Drawer
 * open/close is owned by the parent view (local feature state). Structured so a
 * future approval / edit action bar can drop into the footer.
 */
export function ForecastDetailDrawer({
  row,
  open,
  onOpenChange,
}: {
  row: ForecastResultRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const detail = useForecastDetail(open ? (row?.id ?? null) : null);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className={CONTENT_CLASS}>
        <div className="flex h-full flex-col">
          <SheetHeader className="flex-row items-start justify-between border-b border-border p-5">
            <div className="space-y-1">
              <SheetTitle>{row?.skuName ?? "Forecast detail"}</SheetTitle>
              <SheetDescription>
                {row ? `${row.skuCode} · ${row.category}` : "Forecast overview"}
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
            <div className="space-y-6 p-5">
              {!row ? null : detail.isError ? (
                <ErrorState
                  title="Couldn’t load forecast"
                  message={detail.error?.message}
                  onRetry={() => void detail.refetch().catch(() => {})}
                />
              ) : (
                <>
                  <Section title="General">
                    <dl className="divide-y divide-border/60">
                      <Field
                        label="SKU"
                        value={
                          <span className="font-mono text-xs">
                            {row.skuCode}
                          </span>
                        }
                      />
                      <Field label="Category" value={row.category} />
                      <Field
                        label="Status"
                        value={<ForecastStatusBadge row={row} />}
                      />
                    </dl>
                  </Section>

                  <Section title="Forecast Metrics">
                    <dl className="divide-y divide-border/60">
                      <Field
                        label="Forecast Value"
                        value={formatNumber(row.forecastUnits)}
                      />
                      <Field
                        label="Actual Value"
                        value={formatNumber(row.actualUnits)}
                      />
                      <Field
                        label="Variance"
                        value={
                          <VarianceTag
                            units={row.varianceUnits}
                            pct={row.variancePct}
                          />
                        }
                      />
                      <Field
                        label="Accuracy"
                        value={<AccuracyValue row={row} />}
                      />
                      <Field
                        label="Bias"
                        value={
                          detail.isLoading ? (
                            <Skeleton className="ml-auto h-4 w-12" />
                          ) : detail.data?.metrics.bias != null ? (
                            formatDelta(detail.data.metrics.bias)
                          ) : (
                            "—"
                          )
                        }
                      />
                    </dl>
                  </Section>

                  <Section title="Forecast History">
                    {detail.isLoading ? (
                      <Skeleton className="h-[168px] w-full" />
                    ) : detail.data?.series?.length ? (
                      <ForecastMiniTrendChart series={detail.data.series} />
                    ) : (
                      <EmptyState
                        icon={LineChart}
                        title="No history"
                        description="No series data for this forecast."
                      />
                    )}
                  </Section>

                  <Section title="Metadata">
                    <dl className="divide-y divide-border/60">
                      <Field
                        label="Last Forecast Date"
                        value={formatDate(
                          detail.data?.generatedAt ?? row.generatedAt,
                        )}
                      />
                      <Field label="Forecast Method" value={row.modelLabel} />
                      <Field
                        label="Accuracy (MAPE)"
                        value={formatPercent(1 - row.accuracy)}
                      />
                    </dl>
                  </Section>
                </>
              )}
            </div>
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  );
}
