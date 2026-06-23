"use client";

import { useMemo, useState } from "react";
import { Activity, Download, Gauge } from "lucide-react";
import { PageShell } from "@/components/layout/page-shell";
import { WorkflowHero, HeroStatusPill } from "@/features/workflow/workflow-hero";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { ChartCard } from "@/features/dashboard/chart-card";
import { Field, Select } from "@/features/data/controls";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils/format";
import { downloadFile } from "@/lib/utils/download";
import { useForecastLevel } from "@/lib/stores/forecast-level-store";
import type { ForecastMetricRow, ForecastRunMetrics } from "@/types/forecast";
import { WorkflowLock } from "@/features/workflow/workflow-lock";
import { useWorkflowStatus } from "@/features/workflow/use-workflow-status";
import { routes } from "@/lib/constants/routes";
import { usePerformance } from "./hooks/use-performance";
import { PerformanceKpiStrip } from "./performance-kpis";
import {
  BrandSegmentHeatmap,
  SkuQualityScatter,
  WmapeByGroupChart,
} from "./performance-charts";
import { SkuDrilldown } from "./sku-drilldown";
import {
  brandOf,
  errorContribution,
  segmentOf,
  toGroupPerf,
  vol,
  wmapeTone,
  type GroupPerf,
  type Tone,
} from "./derive";

const TONE_TEXT: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  muted: "text-foreground",
};

function pct(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`;
}
function signed(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/** Per-SKU performance CSV (client-side; mirrors Streamlit's download). */
function downloadPerformanceCsv(rows: ForecastMetricRow[]) {
  const header = [
    "sku", "brand", "segment", "strategy", "train_wmape", "test_wmape",
    "smape", "bias", "band", "forecast_total",
  ];
  const fmt = (v: number | null) => (v == null ? "" : String(v));
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      r.sku, brandOf(r), segmentOf(r), r.strategyLabel || r.strategy,
      fmt(r.trainWmape), fmt(r.testWmape), fmt(r.smape), fmt(r.bias),
      r.band, fmt(r.forecastTotal),
    ].map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","));
  }
  downloadFile("performance_by_sku.csv", lines.join("\n"));
}

function Wmape({ value }: { value: number | null }) {
  return (
    <span className={cn("font-medium tabular-nums", TONE_TEXT[wmapeTone(value)])}>
      {pct(value)}
    </span>
  );
}

const TH = "px-3 py-2 text-left text-xs font-medium text-muted-foreground";
const TD = "whitespace-nowrap px-3 py-2 text-sm tabular-nums text-foreground";

/** GroupPerf table (segment or brand breakdowns). */
function GroupTable({
  label,
  groups,
}: {
  label: string;
  groups: GroupPerf[];
}) {
  const { plural: levelPlural } = useForecastLevel();
  const sorted = [...groups].sort(
    (a, b) => (a.weightedWmape ?? Infinity) - (b.weightedWmape ?? Infinity),
  );
  return (
    <div className="max-h-[380px] overflow-auto rounded-lg border border-border">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border bg-card">
            <th className={TH}>{label}</th>
            <th className={cn(TH, "text-right")}>WMAPE</th>
            <th className={cn(TH, "text-right")}>SMAPE</th>
            <th className={cn(TH, "text-right")}>Bias</th>
            <th className={cn(TH, "text-right")}>{levelPlural}</th>
            <th className={cn(TH, "text-right")}>Volume</th>
            <th className={cn(TH, "text-right")}>Coverage</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((g) => (
            <tr key={g.key} className="border-b border-border/60 last:border-0">
              <td className={TD}>{g.key}</td>
              <td className={cn(TD, "text-right")}>
                <Wmape value={g.weightedWmape} />
              </td>
              <td className={cn(TD, "text-right")}>{pct(g.smape)}</td>
              <td className={cn(TD, "text-right")}>{signed(g.weightedBias)}</td>
              <td className={cn(TD, "text-right")}>{formatNumber(g.skuCount)}</td>
              <td className={cn(TD, "text-right")}>
                {formatNumber(Math.round(g.volume))}
              </td>
              <td className={cn(TD, "text-right")}>{pct(g.coveragePct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TABS = ["Segment", "Brand", "Brand × Segment", "SKU"] as const;
type Tab = (typeof TABS)[number];

function SegmentTab({ data }: { data: ForecastRunMetrics }) {
  const groups = useMemo(() => data.groups.segment.map(toGroupPerf), [data]);
  return (
    <div className="space-y-6">
      <ChartCard
        title="WMAPE by segment"
        description="Pooled over held-out actuals; worst at the bottom."
      >
        <WmapeByGroupChart groups={groups} />
      </ChartCard>
      <GroupTable label="Segment" groups={groups} />
    </div>
  );
}

function BrandTab({ data }: { data: ForecastRunMetrics }) {
  const { plural: levelPlural } = useForecastLevel();
  const groups = useMemo(() => data.groups.brand.map(toGroupPerf), [data]);
  const brands = useMemo(() => groups.map((g) => g.key).sort(), [groups]);
  const [brand, setBrand] = useState(brands[0] ?? "");
  const active = brand || brands[0] || "";
  const segBreakdown = useMemo(
    () =>
      data.groups.brandSegment
        .filter((g) => (g.brand || "—") === active)
        .map((g) => ({ ...toGroupPerf(g), key: g.segment || "—" })),
    [data, active],
  );
  const sel = groups.find((g) => g.key === active);

  return (
    <div className="space-y-6">
      <ChartCard
        title="WMAPE by brand"
        description="Pooled over held-out actuals; worst at the bottom."
      >
        <WmapeByGroupChart groups={groups} height={420} />
      </ChartCard>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <Field label="Brand drill-down">
            <Select
              value={active}
              onChange={setBrand}
              options={brands.map((b) => ({ value: b, label: b }))}
              ariaLabel="Select brand"
            />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg border border-border bg-secondary/30 p-3">
              <p className="text-xs text-muted-foreground">WMAPE</p>
              <p className="mt-1 text-lg font-semibold">
                <Wmape value={sel?.weightedWmape ?? null} />
              </p>
            </div>
            <div className="rounded-lg border border-border bg-secondary/30 p-3">
              <p className="text-xs text-muted-foreground">{levelPlural} evaluated</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {formatNumber(sel?.skuCount ?? 0)}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-secondary/30 p-3">
              <p className="text-xs text-muted-foreground">Held-out volume</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {formatNumber(Math.round(sel?.volume ?? 0))}
              </p>
            </div>
          </div>
          <GroupTable label="Segment within brand" groups={segBreakdown} />
        </CardContent>
      </Card>
    </div>
  );
}

function BrandSegmentTab({ data }: { data: ForecastRunMetrics }) {
  const { plural: levelPlural } = useForecastLevel();
  const worst = useMemo(
    () =>
      [...data.groups.brandSegment]
        .sort((a, b) => b.errorContribution - a.errorContribution)
        .slice(0, 10),
    [data],
  );

  return (
    <div className="space-y-6">
      <ChartCard
        title="WMAPE by brand × segment"
        description="Where the pain is — heaviest brands on top."
      >
        <BrandSegmentHeatmap groups={data.groups.brandSegment} />
      </ChartCard>

      <div className="rounded-lg border border-border">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border bg-card">
              <th className={TH}>Brand</th>
              <th className={TH}>Segment</th>
              <th className={cn(TH, "text-right")}>WMAPE</th>
              <th className={cn(TH, "text-right")}>SMAPE</th>
              <th className={cn(TH, "text-right")}>Bias</th>
              <th className={cn(TH, "text-right")}>{levelPlural}</th>
              <th className={cn(TH, "text-right")}>Volume</th>
              <th className={cn(TH, "text-right")}>Error contribution</th>
            </tr>
          </thead>
          <tbody>
            {worst.map((c) => (
              <tr
                key={`${c.brand ?? "—"}-${c.segment ?? "—"}`}
                className="border-b border-border/60 last:border-0"
              >
                <td className={TD}>{c.brand ?? "—"}</td>
                <td className={TD}>{c.segment ?? "—"}</td>
                <td className={cn(TD, "text-right")}>
                  <Wmape value={c.weightedWmape} />
                </td>
                <td className={cn(TD, "text-right")}>{pct(c.smape)}</td>
                <td className={cn(TD, "text-right")}>{signed(c.weightedBias)}</td>
                <td className={cn(TD, "text-right")}>{formatNumber(c.skuCount)}</td>
                <td className={cn(TD, "text-right")}>
                  {formatNumber(Math.round(c.volume ?? 0))}
                </td>
                <td className={cn(TD, "text-right")}>
                  {formatNumber(Math.round(c.errorContribution))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBox({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: Tone;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-4",
        tone === "success"
          ? "border-success/40 bg-success/10"
          : tone === "warning"
            ? "border-warning/40 bg-warning/10"
            : tone === "destructive"
              ? "border-destructive/40 bg-destructive/10"
              : "border-border bg-secondary/30",
      )}
    >
      <p className={cn("text-2xl font-semibold tabular-nums", TONE_TEXT[tone])}>
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function SkuTab({ rows }: { rows: ForecastMetricRow[] }) {
  const { label: levelLabel } = useForecastLevel();
  const counts = useMemo(() => {
    const total = rows.length || 1;
    const good = rows.filter((r) => r.band === "Good").length;
    const review = rows.filter((r) => r.band === "Review").length;
    const poor = rows.filter((r) => r.band === "Poor").length;
    const totalVol = rows.reduce((s, r) => s + vol(r), 0);
    const goodVol = rows.reduce(
      (s, r) => s + (r.band === "Good" ? vol(r) : 0),
      0,
    );
    return {
      good,
      review,
      poor,
      total,
      volInGood: totalVol > 0 ? (goodVol / totalVol) * 100 : 0,
    };
  }, [rows]);

  const top = useMemo(
    () =>
      [...rows]
        .sort((a, b) => errorContribution(b) - errorContribution(a))
        .slice(0, 50),
    [rows],
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatusBox
          label={`Good (<20%) · ${((counts.good / counts.total) * 100).toFixed(0)}%`}
          value={formatNumber(counts.good)}
          tone="success"
        />
        <StatusBox
          label={`Review (20–50%) · ${((counts.review / counts.total) * 100).toFixed(0)}%`}
          value={formatNumber(counts.review)}
          tone="warning"
        />
        <StatusBox
          label={`Poor (>50%) · ${((counts.poor / counts.total) * 100).toFixed(0)}%`}
          value={formatNumber(counts.poor)}
          tone="destructive"
        />
        <StatusBox
          label="Volume in good band"
          value={`${counts.volInGood.toFixed(0)}%`}
          tone="muted"
        />
      </div>

      <ChartCard
        title={`${levelLabel} portfolio — volume vs forecast quality`}
        description="Bottom-left is ideal: high volume, low WMAPE."
      >
        <SkuQualityScatter rows={rows} />
      </ChartCard>

      <div className="max-h-[420px] overflow-auto rounded-lg border border-border">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border bg-card">
              <th className={TH}>{levelLabel}</th>
              <th className={TH}>Brand</th>
              <th className={TH}>Segment</th>
              <th className={cn(TH, "text-right")}>Volume</th>
              <th className={cn(TH, "text-right")}>WMAPE</th>
              <th className={cn(TH, "text-right")}>Bias</th>
              <th className={TH}>Strategy</th>
              <th className={cn(TH, "text-right")}>Error contribution</th>
            </tr>
          </thead>
          <tbody>
            {top.map((r) => (
              <tr key={r.id} className="border-b border-border/60 last:border-0">
                <td className={cn(TD, "font-mono text-xs font-medium")}>
                  {r.sku}
                </td>
                <td className={TD}>{brandOf(r)}</td>
                <td className={TD}>{segmentOf(r)}</td>
                <td className={cn(TD, "text-right")}>
                  {formatNumber(Math.round(vol(r)))}
                </td>
                <td className={cn(TD, "text-right")}>
                  <Wmape value={r.testWmape} />
                </td>
                <td className={cn(TD, "text-right")}>{signed(r.bias)}</td>
                <td className={cn(TD, "text-xs text-muted-foreground")}>
                  {r.strategyLabel || r.strategy}
                </td>
                <td className={cn(TD, "text-right")}>
                  {formatNumber(Math.round(errorContribution(r)))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Card>
        <CardContent className="pt-6">
          <SkuDrilldown rows={rows} />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Performance Analytics (Step 7) — pooled forecast-accuracy diagnostics over the
 * latest run. Mirrors the Streamlit Performance tab: a traffic-light KPI strip
 * plus Segment / Brand / Brand×Segment / SKU breakdowns, all from the live
 * /forecasts/metrics endpoint (per-SKU series fetched lazily in the drill-down).
 */
export function PerformanceView() {
  const workflow = useWorkflowStatus();
  const perf = usePerformance();
  const { label: levelLabel } = useForecastLevel();
  const [tab, setTab] = useState<Tab>("Segment");

  const rows = useMemo<ForecastMetricRow[]>(
    () => perf.data?.skus ?? [],
    [perf.data],
  );
  const empty = !perf.isLoading && !perf.isError && rows.length === 0;
  const gated =
    !workflow.isLoading && workflow.data && !workflow.data.forecastCompleted;

  if (gated) {
    return (
      <PageShell
        title="Performance Analytics"
        description="Step 7 — backtest accuracy diagnostics across the latest forecast run."
      >
        <WorkflowLock
          title="No performance data"
          message="Run a forecast first."
          href={routes.forecast}
          ctaLabel="Go to Forecast"
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Performance Analytics"
      description={`Forecast accuracy diagnostics — WMAPE · SMAPE · bias · coverage by segment, brand and ${levelLabel}.`}
      actions={
        rows.length ? (
          <Button variant="outline" onClick={() => downloadPerformanceCsv(rows)}>
            <Download className="size-4" /> Per-{levelLabel.toLowerCase()} performance (CSV)
          </Button>
        ) : undefined
      }
    >
      <WorkflowHero
        step="Step 7 · Performance"
        title="Forecast Accuracy Diagnostics"
        subtitle={`Backtest accuracy across the latest run — WMAPE, SMAPE, bias, and coverage by segment, brand, and ${levelLabel}.`}
        icon={Gauge}
        variant="grid"
        status={
          <>
            <HeroStatusPill tone="accent">Backtest diagnostics</HeroStatusPill>
            <HeroStatusPill>Pooled WMAPE</HeroStatusPill>
          </>
        }
      />

      {perf.isLoading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i} className="p-5">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="mt-3 h-7 w-20" />
              </Card>
            ))}
          </div>
          <Skeleton className="h-[420px] w-full" />
        </div>
      ) : perf.isError ? (
        <ErrorState
          title="Couldn’t load performance"
          message={perf.error?.message}
          onRetry={() => void perf.refetch().catch(() => {})}
        />
      ) : empty ? (
        <EmptyState
          icon={Activity}
          title="No forecasts to analyze"
          description="Run a forecast to see accuracy diagnostics and breakdowns."
        />
      ) : perf.data ? (
        <div className="space-y-6">
          <PerformanceKpiStrip data={perf.data} />

          <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-card/40 p-1">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  tab === t
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                )}
              >
                {t === "SKU" ? levelLabel : t}
              </button>
            ))}
          </div>

          {tab === "Segment" ? <SegmentTab data={perf.data} /> : null}
          {tab === "Brand" ? <BrandTab data={perf.data} /> : null}
          {tab === "Brand × Segment" ? <BrandSegmentTab data={perf.data} /> : null}
          {tab === "SKU" ? <SkuTab rows={rows} /> : null}
        </div>
      ) : null}
    </PageShell>
  );
}
