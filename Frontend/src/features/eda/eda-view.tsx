"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarRange,
  ChevronDown,
  Gauge,
  IndianRupee,
  LineChart,
  Loader2,
  Play,
  Rows3,
} from "lucide-react";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatDate, formatFrequency, formatIndianCurrency, formatNumber } from "@/lib/utils/format";
import { routes } from "@/lib/constants/routes";
import { workflowService } from "@/lib/api/services";
import { WorkflowHero } from "@/features/workflow/workflow-hero";
import { ContinueButton } from "@/features/workflow/continue-button";
import { WorkflowLock } from "@/features/workflow/workflow-lock";
import { useWorkflowStatus } from "@/features/workflow/use-workflow-status";
import type { EdaResult } from "@/types/eda";
import { useEdaStore } from "@/lib/stores/eda-store";
import { useEda, useEdaSkuList } from "./hooks/use-eda";
import {
  EdaAcfChart,
  EdaDecompositionPanel,
  EdaHistogramChart,
  EdaHolidayChart,
  EdaMonthlyBoxChart,
  EdaPacfChart,
  EdaSeasonalityChart,
  EdaTrendChart,
} from "./eda-charts";
import { EdaAnomalyEditor } from "./eda-anomaly-editor";

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="text-base font-semibold tracking-tight text-foreground">{children}</h2>;
}

function QualityTile({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Rows3;
  label: string;
  value: string;
}) {
  return (
    <Card className="group relative overflow-hidden p-4 transition-all duration-200 hover:border-brand/40 hover:shadow-[var(--shadow-md)]">
      <div className="brand-rail pointer-events-none absolute inset-x-0 top-0 h-0.5 opacity-70" aria-hidden />
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-md border border-border bg-primary/10 text-primary">
          <Icon className="size-3.5" />
        </span>
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <p className="mt-2 text-xl font-semibold tabular-nums text-foreground">{value}</p>
    </Card>
  );
}

/**
 * EDA — replicates the Streamlit "Step 2 · EDA" tab: hero, Analysis Scope radio,
 * status banner, Run EDA action, then Data Quality → Trend → Seasonality →
 * Decomposition → Autocorrelation → Outliers. Gated on an uploaded dataset;
 * running EDA marks the stage complete (unlocking Profile & Route).
 */
export function EdaView() {
  const workflow = useWorkflowStatus();
  const skuList = useEdaSkuList();

  // Persisted EDA state (F.12 #11) — survives navigation / forecast runs / refresh.
  const { scope, selectedSku, ran, setUi, cacheResult, cache } = useEdaStore();
  const setScope = useCallback((v: "portfolio" | "sku") => setUi({ scope: v }), [setUi]);
  const setSelectedSku = useCallback((v: string | null) => setUi({ selectedSku: v }), [setUi]);
  const setRan = useCallback((v: boolean) => setUi({ ran: v }), [setUi]);
  const [completing, setCompleting] = useState(false);

  const activeSku = scope === "sku" ? selectedSku : null;
  // F.19 §1 — manual: EDA never auto-runs on mount/route change. Only the
  // "Run EDA" click triggers eda.refetch().
  const eda = useEda(activeSku, false);
  const skus = useMemo(() => skuList.data ?? [], [skuList.data]);

  // Cache each loaded result by scope/SKU + show the cached one instantly on
  // return (no loading flash, no re-click of "Run EDA").
  const edaKey = scope === "sku" ? (selectedSku ?? "__none__") : "portfolio";
  useEffect(() => {
    if (eda.data) cacheResult(edaKey, eda.data);
  }, [eda.data, edaKey, cacheResult]);
  const displayData = eda.data ?? cache[edaKey] ?? null;

  // Changing scope/SKU requires re-running EDA (mirrors Streamlit) — but NOT on
  // the initial mount, so a persisted "ran" survives navigation.
  const firstScopeRun = useRef(true);
  useEffect(() => {
    if (firstScopeRun.current) {
      firstScopeRun.current = false;
      return;
    }
    setRan(false);
  }, [scope, selectedSku, setRan]);

  // Streamlit parity: EDA is "done" once the analysis has been computed — it does
  // not require an explicit Run-EDA click to advance. Auto-mark complete when the
  // portfolio EDA has loaded so Profile & Route unlocks.
  const autoMarked = useRef(false);
  useEffect(() => {
    if (
      !autoMarked.current &&
      eda.data &&
      workflow.data &&
      !workflow.data.edaCompleted
    ) {
      autoMarked.current = true;
      void workflowService
        .complete("eda")
        .then(() => workflow.refetch())
        .catch(() => {});
    }
  }, [eda.data, workflow.data, workflow]);

  // Display the *configured* frequency (D/W/MS/QS/YS → label), not the
  // auto-detected raw granularity, so Weekly EDA reads as "Weekly".
  const freqLabel = displayData ? formatFrequency(displayData.dataQuality.frequency) : "";
  const portfolioSkus = displayData?.dataQuality.skuCount ?? skus.length;
  const scopeLabel =
    scope === "sku"
      ? selectedSku
        ? `SKU = ${selectedSku}`
        : "a single SKU"
      : `Portfolio aggregate (${formatNumber(portfolioSkus)} SKUs)`;

  const runEda = useCallback(async () => {
    setRan(true);
    setCompleting(true);
    try {
      // Explicit user-triggered execution (the only place EDA runs).
      await eda.refetch();
      await workflowService.complete("eda").catch(() => {});
    } catch {
      /* error surfaced via eda.isError */
    } finally {
      setCompleting(false);
    }
  }, [eda, setRan]);

  // Busy = the explicit run is in flight (drives the Run-EDA button spinner).
  const edaRunning = completing || eda.isLoading;

  const gated = !workflow.isLoading && workflow.data && !workflow.data.datasetUploaded;
  const needsSku = scope === "sku" && !selectedSku;

  return (
    <PageShell title="Exploratory Data Analysis">
      <WorkflowHero
        step="Step 2 · EDA"
        title="Exploratory Time-Series Analysis"
        subtitle="Trend, seasonality, decomposition, anomalies, autocorrelation — portfolio or per-SKU"
        icon={LineChart}
        variant="curve"
      />

      {gated ? (
        <WorkflowLock
          title="No dataset available"
          message="Please upload a dataset first."
          href={routes.data}
          ctaLabel="Go to Data Upload"
        />
      ) : (
        <>
          {/* Analysis scope */}
          <Card>
            <CardContent className="space-y-4 pt-6">
              <div>
                <p className="text-sm font-medium text-foreground">Analysis scope</p>
                <p className="text-xs text-muted-foreground">
                  Portfolio = sum across all SKUs. Single SKU = deep-dive on one product.
                </p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="inline-flex rounded-md border border-border p-0.5">
                  {([
                    ["portfolio", "Portfolio aggregate"],
                    ["sku", "Single SKU (drill-down)"],
                  ] as const).map(([m, lbl]) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setScope(m)}
                      className={cn(
                        "rounded px-3 py-1.5 text-sm transition-colors",
                        scope === m
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
                {scope === "sku" ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="justify-between gap-2 sm:w-56">
                        <span className="truncate font-mono text-xs">
                          {selectedSku ?? "Pick a SKU (top by volume)…"}
                        </span>
                        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
                      {skus.map((code) => (
                        <DropdownMenuItem
                          key={code}
                          onSelect={() => setSelectedSku(code)}
                          className="font-mono text-xs"
                        >
                          {code}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>

              {/* Status banner */}
              {!needsSku ? (
                <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2.5 text-sm text-foreground">
                  Running EDA on <span className="font-semibold">{scopeLabel}</span>
                  {freqLabel ? (
                    <>
                      {" "}at <span className="font-semibold">{freqLabel}</span> frequency.
                    </>
                  ) : (
                    "."
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Select a SKU above to drill into its demand history.
                </p>
              )}

              <Button
                onClick={runEda}
                disabled={needsSku || edaRunning}
                className="w-full disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto"
              >
                {edaRunning ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> Running EDA…
                  </>
                ) : (
                  <>
                    <Play className="size-4" /> Run EDA
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          {/* F.17B §2 — once EDA has been computed it is cached (persisted) and
              ALWAYS renders, independent of the `ran` flag or any later forecast
              run. Only show the empty prompt when there is genuinely no result. */}
          {!ran && !displayData ? (
            <EmptyState
              icon={Gauge}
              title="Ready to analyze"
              description="Choose a scope and click “Run EDA” to explore trend, seasonality, decomposition, autocorrelation, and anomalies."
            />
          ) : eda.isError && !displayData ? (
            <ErrorState
              title="Couldn’t load EDA"
              message={eda.error?.message}
              onRetry={() => void eda.refetch().catch(() => {})}
            />
          ) : !displayData ? (
            <>
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Card key={i} className="p-4">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="mt-3 h-5 w-16" />
                  </Card>
                ))}
              </div>
              <Skeleton className="h-72 w-full" />
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Showing EDA for:{" "}
                <span className="font-medium text-foreground">{scopeLabel}</span>
              </p>
              <EdaSections eda={displayData} />
              <div className="flex justify-end">
                <ContinueButton
                  href={routes.profile}
                  label="Continue to Profile & Route"
                  loadingLabel="Loading Profile…"
                  disabled={completing}
                />
              </div>
            </>
          )}
        </>
      )}
    </PageShell>
  );
}

function EdaSections({ eda }: { eda: EdaResult }) {
  const dq = eda.dataQuality;
  const holiday = eda.holiday;
  return (
    <div className="space-y-6">
      {/* Data Quality & Summary */}
      <section id="summary" className="scroll-mt-24 space-y-3">
        <SectionHeading>Data Quality &amp; Summary</SectionHeading>
        {/* Part 10 — Missing Values & Outliers KPI cards removed. */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <QualityTile icon={Rows3} label="Total Records" value={formatNumber(dq.totalRecords)} />
          {dq.totalRevenue != null ? (
            <QualityTile icon={IndianRupee} label="Total Revenue" value={formatIndianCurrency(dq.totalRevenue)} />
          ) : (
            <QualityTile icon={IndianRupee} label="Total Sales (Units)" value={formatNumber(Math.round(dq.totalSalesUnits ?? 0))} />
          )}
          <QualityTile icon={CalendarRange} label="Min Date" value={dq.minDate ? formatDate(dq.minDate) : "—"} />
          <QualityTile icon={CalendarRange} label="Max Date" value={dq.maxDate ? formatDate(dq.maxDate) : "—"} />
          <QualityTile icon={Gauge} label="Frequency" value={formatFrequency(dq.frequency)} />
        </div>
      </section>

      {/* Target Variable Distribution — Streamlit stacks Overall over Monthly
          (make_subplots rows=2); the monthly box-plots are the larger panel. */}
      <section id="distribution" className="scroll-mt-24 space-y-3">
        <SectionHeading>Target Variable Distribution</SectionHeading>
        <div className="grid grid-cols-1 gap-4">
          <Card>
            <CardContent className="pt-6">
              <p className="mb-2 text-sm text-muted-foreground">Overall Distribution</p>
              {eda.distribution.histogram.length ? (
                <EdaHistogramChart data={eda.distribution.histogram} height={240} />
              ) : (
                <EmptyState title="Distribution unavailable" description="No values to bin." />
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="mb-2 text-sm text-muted-foreground">Distribution by Month</p>
              {eda.distribution.monthlyBox.length ? (
                <EdaMonthlyBoxChart data={eda.distribution.monthlyBox} height={400} />
              ) : (
                <EmptyState title="Monthly box-plot unavailable" description="Not enough monthly data." />
              )}
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Trend */}
      <section id="time-series" className="scroll-mt-24 space-y-3">
        <SectionHeading>Trend</SectionHeading>
        <Card>
          <CardContent className="pt-6">
            <EdaTrendChart series={eda.series} mean={eda.trend.mean} />
          </CardContent>
        </Card>
      </section>

      {/* Seasonality */}
      <section className="space-y-3">
        <SectionHeading>Seasonality</SectionHeading>
        <Card>
          <CardContent className="pt-6">
            {eda.peakMonth ? (
              <p className="mb-2 text-sm text-muted-foreground">Peak month: {eda.peakMonth}.</p>
            ) : null}
            <EdaSeasonalityChart data={eda.seasonality} />
          </CardContent>
        </Card>
      </section>

      {/* Seasonal Decomposition */}
      <section id="seasonal-decomposition" className="scroll-mt-24 space-y-3">
        <SectionHeading>Seasonal Decomposition</SectionHeading>
        <Card>
          <CardContent className="pt-6">
            {eda.decomposition && eda.decomposition.length ? (
              <EdaDecompositionPanel data={eda.decomposition} series={eda.series} />
            ) : (
              <EmptyState
                icon={Gauge}
                title="Decomposition unavailable"
                description={eda.decompositionReason || "Not enough history to decompose."}
              />
            )}
          </CardContent>
        </Card>
      </section>

      {/* Anomaly Detection — editable correction table */}
      <section id="anomaly" className="scroll-mt-24 space-y-3">
        <SectionHeading>Anomaly Detection</SectionHeading>
        <EdaAnomalyEditor
          datasetId={eda.datasetId}
          sku={eda.sku}
          outliers={eda.outliers}
          initialSeries={eda.series}
        />
      </section>

      {/* ACF & PACF */}
      <section id="correlation" className="scroll-mt-24 space-y-3">
        <SectionHeading>ACF &amp; PACF</SectionHeading>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardContent className="pt-6">
              <p className="mb-2 text-sm text-muted-foreground">ACF</p>
              {eda.autocorrelation.length ? (
                <EdaAcfChart data={eda.autocorrelation} />
              ) : (
                <EmptyState
                  title="ACF unavailable"
                  description={eda.acfPacfReason || "Not enough data for 20-lag ACF/PACF."}
                />
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="mb-2 text-sm text-muted-foreground">PACF</p>
              {eda.partialAutocorrelation.length ? (
                <EdaPacfChart data={eda.partialAutocorrelation} />
              ) : (
                <EmptyState
                  title="PACF unavailable"
                  description={eda.acfPacfReason || "Not enough data for 20-lag ACF/PACF."}
                />
              )}
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Holiday Analysis */}
      <section id="holiday" className="scroll-mt-24 space-y-3">
        <SectionHeading>Holiday Analysis</SectionHeading>
        <Card>
          <CardContent className="pt-6">
            {holiday.available ? (
              <>
                <div className="mb-4 grid grid-cols-2 gap-4 sm:max-w-md">
                  <div className="rounded-md border border-border bg-secondary/30 px-3 py-2.5">
                    <p className="text-xs text-muted-foreground">Avg demand (Holidays)</p>
                    <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                      {holiday.avgHoliday != null
                        ? formatNumber(holiday.avgHoliday, { maximumFractionDigits: 2 })
                        : "—"}
                    </p>
                  </div>
                  <div className="rounded-md border border-border bg-secondary/30 px-3 py-2.5">
                    <p className="text-xs text-muted-foreground">Avg demand (Non-Holidays)</p>
                    <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                      {holiday.avgNonHoliday != null
                        ? formatNumber(holiday.avgNonHoliday, { maximumFractionDigits: 2 })
                        : "—"}
                    </p>
                  </div>
                </div>
                <EdaHolidayChart series={eda.series} holiday={holiday} />
                <p className="mt-2 text-xs text-muted-foreground">
                  {formatNumber(holiday.holidayCount)} holiday period(s) highlighted ({holiday.country ?? "IN"} calendar).
                </p>
              </>
            ) : (
              <EmptyState
                title="Holiday analysis unavailable"
                description={`No holidays found for the data range (${holiday.country ?? "IN"} calendar).`}
              />
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
