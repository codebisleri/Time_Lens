"use client";

import { useMemo, useState } from "react";
import { Download, Layers, PackageSearch, Search, Sparkles, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/feedback/empty-state";
import { cn } from "@/lib/utils";
import { formatForecastLevel, formatNumber, pluralizeLevel } from "@/lib/utils/format";
import { downloadFile } from "@/lib/utils/download";
import { routes } from "@/lib/constants/routes";
import { forecastService } from "@/lib/api/services";
import { useForecastDetail } from "@/features/forecast/hooks/use-forecast-detail";
import { ForecastTrendBandChart } from "@/features/forecast/forecast-trend-band-chart";
import { ForecastYoYChart } from "@/features/forecast/forecast-yoy-chart";
import { Select } from "@/features/data/controls";
import type { ForecastBandPoint } from "@/features/forecast/hooks/use-forecast-trend";
import type { ForecastDetail, ForecastMetricRow, ForecastRunMetrics } from "@/types/forecast";
import { ContinueButton } from "@/features/workflow/continue-button";
import { TopDownBadge } from "./top-down-indicator";
import { ForecastExplainPanel } from "@/features/forecast-explain/forecast-explain-panel";
import { useForecastStore } from "@/lib/stores";

const ALL = "__all__";
const pct = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)}%`);

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const ym = (d: string) => ({ y: Number(d.slice(0, 4)), m: Number(d.slice(5, 7)) });
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const deltaPct = (a: number, b: number | null) =>
  b == null || b === 0 ? null : ((a - b) / b) * 100;
const signed = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);

// Phase X.S · Task 8 — compact array preview for the read-only debug mode.
function arr(xs: (number | null | undefined)[] | undefined, max = 24): string {
  if (!xs || !xs.length) return "[]";
  const shown = xs.slice(0, max).map((v) => (v == null ? "·" : Math.round(v)));
  return `[${shown.join(", ")}${xs.length > max ? ", …" : ""}]`;
}
function DebugRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
      <span className="shrink-0 font-sans text-foreground sm:w-56">{label}:</span>
      <span className="break-all">{value}</span>
    </div>
  );
}

/**
 * §5/§6 — Forecast Interpretation cards for the inspected SKU, DERIVED in the
 * frontend from the forecast detail (history actuals + forecast). Mirrors the
 * Streamlit per-SKU interpretation: same-month-last-year, prior period, last-3-
 * month average, plus seasonality + trend read-outs. No fabricated data — every
 * number comes from the engine's own historical + forecast series.
 */
function SkuInterpretation({ detail, model }: { detail: ForecastDetail; model?: string | null }) {
  const series = detail.series ?? [];
  const hist = useMemo(
    () => series.filter((p) => p.actual != null).map((p) => ({ date: p.date, v: p.actual as number })),
    [series],
  );
  const fc = useMemo(
    () => series.filter((p) => p.forecast != null).map((p) => ({ date: p.date, v: p.forecast as number })),
    [series],
  );
  // Task 9 — Forecast Month selector (defaults to the first forecast period).
  const [monthIdx, setMonthIdx] = useState(0);

  const view = useMemo(() => {
    if (!fc.length) return null;
    const first = fc[Math.min(monthIdx, fc.length - 1)]!;
    const fm = ym(first.date);

    // Same month, last year.
    const ly = hist.find((h) => ym(h.date).y === fm.y - 1 && ym(h.date).m === fm.m);
    // Prior period = the most recent historical actual (else previous forecast).
    const prior = hist.length ? hist[hist.length - 1]! : fc[1] ?? null;
    // Last-3-month average of history.
    const l3m = avg(hist.slice(-3).map((h) => h.v));

    // Seasonality — this month's historical average vs the overall average.
    const byMonth = new Map<number, number[]>();
    for (const h of hist) {
      const m = ym(h.date).m;
      const arr = byMonth.get(m) ?? [];
      arr.push(h.v);
      byMonth.set(m, arr);
    }
    const overall = avg(hist.map((h) => h.v));
    const thisMonth = avg(byMonth.get(fm.m) ?? []);
    let season: "HIGH" | "LOW" | "AVERAGE" = "AVERAGE";
    if (thisMonth != null && overall != null && overall > 0) {
      const r = thisMonth / overall;
      season = r >= 1.1 ? "HIGH" : r <= 0.9 ? "LOW" : "AVERAGE";
    }

    // Trend — recent 6-period window vs the prior 6.
    let trend: "rising" | "declining" | "flat" = "flat";
    if (hist.length >= 4) {
      const recent = avg(hist.slice(-6).map((h) => h.v));
      const prev = avg(hist.slice(-12, -6).map((h) => h.v));
      if (recent != null && prev != null && prev > 0) {
        const ch = (recent - prev) / prev;
        trend = ch > 0.05 ? "rising" : ch < -0.05 ? "declining" : "flat";
      }
    }

    return {
      monthName: MONTHS[fm.m - 1] ?? first.date.slice(0, 7),
      forecastVal: first.v,
      ly: ly?.v ?? null,
      lyDelta: ly ? deltaPct(first.v, ly.v) : null,
      prior: prior?.v ?? null,
      priorDelta: prior ? deltaPct(first.v, prior.v) : null,
      l3m,
      l3mDelta: l3m != null ? deltaPct(first.v, l3m) : null,
      season,
      trend,
    };
  }, [fc, hist, monthIdx]);

  if (!view) return null;
  const num = (v: number | null) => (v == null ? "—" : formatNumber(Math.round(v)));
  const modelName = model ? String(model) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm font-semibold text-foreground">
          Forecast Interpretation — Why This Number?
        </p>
        {fc.length > 1 ? (
          <div className="sm:w-48">
            <Select
              ariaLabel="Forecast month"
              value={String(monthIdx)}
              onChange={(v) => setMonthIdx(Number(v))}
              options={fc.map((f, i) => {
                const m = ym(f.date);
                return { value: String(i), label: `${MONTHS[m.m - 1] ?? f.date.slice(0, 7)} ${m.y}` };
              })}
            />
          </div>
        ) : null}
      </div>

      {/* Headline forecast for the selected month + how it was produced. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-semibold tabular-nums text-foreground">
          {num(view.forecastVal)} <span className="text-sm font-normal text-muted-foreground">units</span>
        </span>
        <span className="text-sm text-muted-foreground">forecast for {view.monthName}</span>
        {modelName ? (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-border bg-secondary/40 px-2.5 py-0.5 text-xs">
            Generated by <span className="font-semibold text-foreground">{modelName}</span>
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <InterpCard
          label="Same month last year"
          value={num(view.ly)}
          delta={signed(view.lyDelta)}
          up={(view.lyDelta ?? 0) >= 0}
        />
        <InterpCard
          label="Prior period"
          value={num(view.prior)}
          delta={signed(view.priorDelta)}
          up={(view.priorDelta ?? 0) >= 0}
        />
        <InterpCard
          label="Last 3-month avg"
          value={num(view.l3m)}
          delta={signed(view.l3mDelta)}
          up={(view.l3mDelta ?? 0) >= 0}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-border bg-secondary/20 px-3 py-2.5 text-sm">
          <p className="font-medium text-foreground">Seasonality</p>
          <p className="mt-1 text-muted-foreground">
            {view.monthName} is{" "}
            <span className="font-semibold text-brand-accent">
              {view.season === "AVERAGE" ? "an average-season" : `a ${view.season}-season`}
            </span>{" "}
            month for this item.
          </p>
        </div>
        <div className="rounded-md border border-border bg-secondary/20 px-3 py-2.5 text-sm">
          <p className="font-medium text-foreground">Trend</p>
          <p className="mt-1 text-muted-foreground">
            Underlying demand trend is{" "}
            <span className="font-semibold text-foreground">{view.trend}</span>.
          </p>
        </div>
      </div>

      {/* Holiday / events + the generating pipeline. */}
      <div className="rounded-md border border-border bg-secondary/20 px-3 py-2.5 text-sm">
        <p className="font-medium text-foreground">Holiday &amp; event effects</p>
        <p className="mt-1 text-muted-foreground">
          Festival / holiday and planned-event lift is modeled via the exogenous
          calendar (weekends excluded) and folded into this number.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Pipeline:{" "}
          <span className="font-medium text-foreground">{modelName ?? "champion model"}</span>
          {" → residual correction → confidence intervals"}
        </p>
      </div>

      {/* Phase X.I — Year-over-Year trend view (same detail.series; viz only). */}
      <div className="rounded-md border border-border bg-card px-3 py-3">
        <p className="mb-1 text-sm font-semibold text-foreground">Year-over-Year Trend View</p>
        <p className="mb-2 text-xs text-muted-foreground">
          Each year overlaid Jan→Dec; the forecast continues as a dashed line. Missing months are left blank.
        </p>
        <ForecastYoYChart series={detail.series ?? []} />
      </div>
    </div>
  );
}

function InterpCard({
  label,
  value,
  delta,
  up,
}: {
  label: string;
  value: string;
  delta: string;
  up: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</p>
      <p className={cn("text-xs font-medium tabular-nums", up ? "text-success" : "text-warning")}>
        {delta} vs forecast
      </p>
    </div>
  );
}

const BAND_VARIANT: Record<string, "success" | "warning" | "destructive" | "secondary"> = {
  Good: "success", Review: "warning", Poor: "destructive", "No metric": "secondary",
};

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </Card>
  );
}

const EXPORTS = [
  { kind: "forecasts", label: "Forecasts", needsReconcile: false },
  { kind: "all-models", label: "All-models comparison", needsReconcile: false },
  // Phase Y.2 · Task 4 — "Brand reconciliation" CSV export removed with the
  // brand-level reconciliation chart. The reconciled forecast output export below
  // remains (it is forecast generation, not the removed visualization).
  { kind: "sku-adjusted", label: "Reconciled forecasts", needsReconcile: true },
];

/** Champion drill-down — champion chart + the SKU's all-models comparison. */
function Drilldown({ row }: { row: ForecastMetricRow }) {
  const detail = useForecastDetail(row.id);
  const band: ForecastBandPoint[] = useMemo(() => {
    const series = detail.data?.series ?? [];
    // In-sample fit + hold-out test prediction overlays (already produced by the
    // bridge — build_forecast_detail's `fit`/`testPred`). Merge by date.
    const fitByDate = new Map<string, number | null>();
    for (const p of detail.data?.fit ?? []) fitByDate.set(p.date, p.value);
    const testByDate = new Map<string, number | null>();
    for (const p of detail.data?.testPred ?? []) testByDate.set(p.date, p.value);
    return series.map((p) => ({
      date: p.date,
      actual: p.actual ?? null,
      forecast: p.forecast ?? null,
      lower: p.lowerBound ?? null,
      upper: p.upperBound ?? null,
      fit: fitByDate.get(p.date) ?? null,
      testPred: testByDate.get(p.date) ?? null,
    }));
  }, [detail.data]);

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium">{row.sku}</span>
          <Badge variant="secondary">{row.strategyLabel}</Badge>
          {row.overridden ? <Badge variant="warning">overridden</Badge> : null}
          {row.cvSelected ? <Badge variant="default">CV-selected</Badge> : null}
          <span className="ml-auto text-xs text-muted-foreground">
            Train {pct(row.trainWmape)} · Test {pct(row.testWmape)}
          </span>
        </div>
        {/* Phase X.T · Task 2 — champion ranking metric is always WMAPE. */}
        <p className="text-[0.72rem] text-muted-foreground">
          ✓ Champion selected using <span className="font-medium text-foreground">WMAPE</span> — the
          candidate with the lowest hold-out (test) WMAPE wins.
        </p>
        {detail.isLoading ? (
          <Skeleton className="h-72 w-full" />
        ) : band.length ? (
          <ForecastTrendBandChart data={band} height={420} />
        ) : (
          <p className="text-sm text-muted-foreground">No series available.</p>
        )}

        {/* Phase X.T · Task 3 — business-rule indicators/explanations removed
            from the train / test / test-prediction visualization. Business rules
            still run internally inside forecasting (engine unchanged); they are
            simply no longer surfaced on these charts. */}

        {/* Read-only debug dump of the chart's own arrays (no business-rule
            commentary, no recompute). */}
        <details className="rounded-md border border-border/60 bg-secondary/20 [&_summary]:cursor-pointer [&_summary::-webkit-details-marker]:hidden">
          <summary className="px-3 py-2 text-xs font-medium text-foreground">
            🐞 Forecast Debug Mode <span className="font-normal text-muted-foreground">· read-only</span>
          </summary>
          <div className="space-y-1.5 border-t border-border/60 p-3 font-mono text-[0.7rem] text-muted-foreground">
            <DebugRow label="Champion" value={row.strategyLabel} />
            <DebugRow label="Test WMAPE" value={pct(row.testWmape)} />
            <DebugRow label="Train WMAPE" value={pct(row.trainWmape)} />
            <DebugRow label="Actual (held-out test window)" value={arr((detail.data?.testActual ?? []).map((p) => p.value))} />
            <DebugRow label="Test Prediction" value={arr((detail.data?.testPred ?? []).map((p) => p.value))} />
            <DebugRow label="In-sample fit / train prediction" value={arr((detail.data?.fit ?? []).map((p) => p.value))} />
            <DebugRow label="Forecast" value={arr(band.filter((b) => b.forecast != null).map((b) => b.forecast))} />
            <DebugRow label="Lower band (P10)" value={arr(band.filter((b) => b.lower != null).map((b) => b.lower))} />
            <DebugRow label="Upper band (P90)" value={arr(band.filter((b) => b.upper != null).map((b) => b.upper))} />
          </div>
        </details>

        {row.allModels.length ? (
          <div className="overflow-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-secondary/40 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Algorithm</th>
                  <th className="px-3 py-2 font-medium">Role</th>
                  <th className="px-3 py-2 text-right font-medium">Test WMAPE</th>
                  <th className="px-3 py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {row.allModels.map((m) => (
                  <tr
                    key={m.algorithm}
                    className="border-t border-border/60"
                    // F.17 §12 — champion row: orange wash + orange border + bold.
                    style={
                      m.isChampion
                        ? {
                            background: "rgba(239,118,2,0.08)",
                            boxShadow: "inset 0 0 0 1px rgba(239,118,2,0.2)",
                          }
                        : undefined
                    }
                  >
                    <td className={cn("px-3 py-1.5", m.isChampion && "font-semibold text-foreground")}>
                      {m.isChampion ? (
                        <span className="mr-1" style={{ color: "#F4B400" }} aria-label="Champion">
                          ★
                        </span>
                      ) : null}
                      {m.label}
                    </td>
                    <td className={cn("px-3 py-1.5", m.isChampion ? "font-medium text-brand-accent" : "text-muted-foreground")}>
                      {m.isChampion ? "Champion" : "Candidate"}
                    </td>
                    <td className={cn("px-3 py-1.5 text-right tabular-nums", m.isChampion && "font-semibold")}>{pct(m.testWmape)}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{m.reason || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {/* Champion selection explanation — why this model won (data-driven). */}
        <ChampionExplanation row={row} />

        {/* Forecast interpretation — same-month-LY / prior / L3M / seasonality /
            trend, derived from this SKU's history + forecast. */}
        {detail.data ? <SkuInterpretation detail={detail.data} model={row.strategyLabel} /> : null}
      </CardContent>
    </Card>
  );
}

/** Champion Selection Explanation — mirrors the Streamlit "why this champion"
 *  note, derived from the run's own numbers (no invented narrative). */
function ChampionExplanation({ row }: { row: ForecastMetricRow }) {
  const n = row.allModels.length;
  const champ = row.allModels.find((m) => m.isChampion);
  const competed = n > 1 ? `among ${n} competing models` : "(single candidate)";
  return (
    <div className="rounded-md border border-border bg-secondary/20 px-3 py-2.5 text-sm">
      <p className="font-medium text-foreground">Champion selection</p>
      <p className="mt-1 text-muted-foreground">
        <span className="font-medium text-foreground">{row.strategyLabel}</span> won as the
        lowest hold-out (test) WMAPE{champ?.testWmape != null ? ` of ${pct(champ.testWmape)}` : ""}{" "}
        {competed}
        {row.cvSelected ? ", selected via K-fold cross-validation" : ""}
        {row.overridden ? "; this overrides the auto-routed strategy for this SKU" : ""}. Train
        WMAPE {pct(row.trainWmape)} · Test WMAPE {pct(row.testWmape)} → quality band{" "}
        <span className="font-medium text-foreground">{row.band}</span>.
      </p>
    </div>
  );
}

/** Run summary, quality bands, filters, all-models table, drill-down, exports. */
export function ForecastResultsPanel({
  metrics,
  datasetId,
  levelLabel = "SKU",
}: {
  metrics: ForecastRunMetrics;
  datasetId?: string;
  /** F.17 §6 — display term for the forecast level (e.g. "Item No"). */
  levelLabel?: string;
}) {
  const level = formatForecastLevel(levelLabel);
  const levels = pluralizeLevel(level);
  // Phase Y.2 — surface the Top-Down strategy used for this run (from the store).
  const topDownEnabled = useForecastStore((s) => s.topDownEnabled);
  const [brand, setBrand] = useState(ALL);
  const [segment, setSegment] = useState(ALL);
  const [bandFilter, setBandFilter] = useState(ALL);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("sku-asc");
  // Default the drill-down to the first SKU so it renders inline immediately —
  // no row click required (Streamlit shows the drill-down by default).
  const [active, setActive] = useState<ForecastMetricRow | null>(metrics.skus[0] ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [explainOpen, setExplainOpen] = useState(false);

  const brands = useMemo(() => Array.from(new Set(metrics.skus.map((s) => s.brand).filter(Boolean))) as string[], [metrics.skus]);
  const segments = useMemo(() => Array.from(new Set(metrics.skus.map((s) => s.segment).filter(Boolean))) as string[], [metrics.skus]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return metrics.skus.filter((s) => {
      if (brand !== ALL && s.brand !== brand) return false;
      if (segment !== ALL && s.segment !== segment) return false;
      if (bandFilter !== ALL && s.band !== bandFilter) return false;
      if (q && !s.sku.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [metrics.skus, brand, segment, bandFilter, search]);

  // Task 9 — sort the filtered rows. WMAPE uses test (falls back to train);
  // "Error contribution" = WMAPE × forecast volume (biggest error mass first).
  const sortedRows = useMemo(() => {
    const arr = [...rows];
    const wm = (s: ForecastMetricRow) => s.testWmape ?? s.trainWmape ?? Number.POSITIVE_INFINITY;
    const err = (s: ForecastMetricRow) => (s.testWmape ?? 0) * (s.forecastTotal ?? 0);
    switch (sortBy) {
      case "sku-desc": arr.sort((a, b) => b.sku.localeCompare(a.sku)); break;
      case "wmape-asc": arr.sort((a, b) => wm(a) - wm(b)); break;
      case "wmape-desc": arr.sort((a, b) => wm(b) - wm(a)); break;
      case "error-contrib": arr.sort((a, b) => err(b) - err(a)); break;
      default: arr.sort((a, b) => a.sku.localeCompare(b.sku)); // sku-asc
    }
    return arr;
  }, [rows, sortBy]);

  const k = metrics.kpis;
  const exportCsv = async (kind: string) => {
    setBusy(kind);
    try {
      const text = await forecastService.exportCsv(kind, { datasetId, runId: metrics.runId ?? undefined });
      downloadFile(`${kind.replace(/-/g, "_")}.csv`, text);
    } catch {
      toast.error(`Couldn’t export ${kind}`);
    } finally {
      setBusy(null);
    }
  };

  const opt = (xs: string[]) => [{ value: ALL, label: "All" }, ...xs.map((x) => ({ value: x, label: x }))];

  return (
    <div className="space-y-6">
      {/* Phase Y.2 — Forecast Strategy header (which mode produced these results) */}
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
            Forecast Strategy
          </p>
          <p className="mt-0.5 text-sm font-semibold text-foreground">
            {topDownEnabled ? "Top-Down Distribution" : `Direct ${levelLabel} Forecasting`}
          </p>
        </div>
        <TopDownBadge enabled={topDownEnabled} />
      </div>

      {/* Run summary */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label={`${levels} forecasted`} value={formatNumber(k.skusForecasted)} />
        <Kpi label="Median TRAIN WMAPE" value={pct(k.medianTrainWmape)} hint="in-sample fit" />
        <Kpi label="Median TEST WMAPE" value={pct(k.medianTestWmape)} hint="out-of-sample" />
        <Kpi label="Total forecast units" value={k.totalForecastUnits != null ? formatNumber(k.totalForecastUnits, { maximumFractionDigits: 0 }) : "—"} />
      </div>

      {/* Quality bands */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {(["Good", "Review", "Poor", "No metric"] as const).map((b) => (
          <Card key={b} className="p-4">
            <Badge variant={BAND_VARIANT[b]}>{b === "Good" ? "GOOD (<20%)" : b === "Review" ? "REVIEW (20–50%)" : b === "Poor" ? "POOR (>50%)" : "NO METRIC"}</Badge>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{formatNumber(metrics.bands[b] ?? 0)}</p>
          </Card>
        ))}
      </div>

      {/* Filter bar */}
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-end">
          <div className="relative flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" placeholder={`Search ${level}…`} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" aria-label={`Search ${level}`} />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:w-auto sm:items-end">
            <div className="min-w-28"><Select ariaLabel="Brand" value={brand} onChange={setBrand} options={opt(brands)} /></div>
            <div className="min-w-28"><Select ariaLabel="Segment" value={segment} onChange={setSegment} options={opt(segments)} /></div>
            <div className="min-w-28"><Select ariaLabel="Band" value={bandFilter} onChange={setBandFilter} options={opt(["Good", "Review", "Poor", "No metric"])} /></div>
            <div className="min-w-40">
              <Select
                ariaLabel="Sort by"
                value={sortBy}
                onChange={setSortBy}
                options={[
                  { value: "sku-asc", label: `${level} ↑` },
                  { value: "sku-desc", label: `${level} ↓` },
                  { value: "wmape-asc", label: "WMAPE ↑" },
                  { value: "wmape-desc", label: "WMAPE ↓" },
                  { value: "error-contrib", label: "Error contribution" },
                ]}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* All-models / per-SKU table */}
      <Card>
        <CardContent className="pt-6">
          {sortedRows.length ? (
            <div className="overflow-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-secondary/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">{level}</th>
                    <th className="px-3 py-2 font-medium">Champion</th>
                    <th className="px-3 py-2 font-medium">Brand</th>
                    <th className="px-3 py-2 font-medium">Segment</th>
                    <th className="px-3 py-2 text-right font-medium">Train WMAPE</th>
                    <th className="px-3 py-2 text-right font-medium">Test WMAPE</th>
                    <th className="px-3 py-2 font-medium">Band</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((r) => (
                    <tr key={r.id} className="border-t border-border/60">
                      <td className="px-3 py-1.5 font-mono text-xs">{r.sku}</td>
                      <td className="px-3 py-1.5">{r.strategyLabel}{r.overridden ? " ✱" : ""}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{r.brand ?? "—"}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{r.segment ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{pct(r.trainWmape)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{pct(r.testWmape)}</td>
                      <td className="px-3 py-1.5"><Badge variant={BAND_VARIANT[r.band]}>{r.band}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={PackageSearch} title={`No matching ${levels}`} description="Adjust the filters above." />
          )}
        </CardContent>
      </Card>

      {/* SKU drill-down — selection via the "Inspect SKU" dropdown, exactly like
          Streamlit's `st.selectbox("Inspect SKU", …)` (the table above is a
          read-only display, mirroring st.dataframe). */}
      {active ? (
        <section className="space-y-2">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <TrendingUp className="size-4 text-primary" /> {level} drill-down
          </h3>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex flex-col gap-1 sm:max-w-xs sm:flex-1">
              <label className="text-xs font-medium text-foreground">Inspect {level}</label>
              <Select
                ariaLabel={`Inspect ${level}`}
                value={active.id}
                onChange={(id) => setActive(metrics.skus.find((s) => s.id === id) ?? active)}
                options={metrics.skus.map((s) => ({ value: s.id, label: s.sku }))}
              />
            </div>
            {/* Phase X.R — Explain This Forecast (read-only explainability trace). */}
            <Button variant="outline" size="sm" onClick={() => setExplainOpen(true)}>
              <Sparkles className="size-4" /> Explain Forecast
            </Button>
          </div>
          <Drilldown row={active} />
        </section>
      ) : null}

      <ForecastExplainPanel
        open={explainOpen}
        onOpenChange={setExplainOpen}
        row={active}
        datasetId={datasetId}
        levelLabel={level}
      />

      {/* Forecast interpretation — portfolio-level read of the run (data-driven). */}
      <ForecastInterpretation metrics={metrics} levels={levels} />

      {/* Phase Y.2 · Task 4 — the Brand-level reconciliation chart/section was
          removed (chart, brand selector, legend, table, CSV button). The
          top-down / bottom-up / reconciliation CALCULATIONS are untouched in the
          backend and reconciled forecast generation still runs; only this
          visualization is gone. */}

      {/* Exports */}
      <Card>
        <CardContent className="space-y-3 pt-6">
          {/* div (not p): Badge renders a <div>, which is invalid inside <p>. */}
          <div className="flex items-center gap-2 text-sm font-medium">
            <Layers className="size-4 text-muted-foreground" /> Exports
            {metrics.reconciled ? <Badge variant="secondary">reconciled run</Badge> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {EXPORTS.map((e) => {
              const blocked = e.needsReconcile && !metrics.reconciled;
              return (
                <Button
                  key={e.kind}
                  variant="outline"
                  size="sm"
                  // §12 — orange-accented download actions.
                  className="border-brand-accent/40 text-brand-accent hover:bg-brand-accent/10 hover:text-brand-accent"
                  disabled={busy !== null || blocked}
                  title={blocked ? "Re-run with 'Reconcile to brand totals' enabled" : undefined}
                  onClick={() => exportCsv(e.kind)}
                >
                  <Download className="size-4" /> {e.label}
                </Button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Forward navigation — Phase Y.3 · Task 4: the completed forecast now
          unlocks the Performance stage (Step 5), which precedes Forecast
          Submission. Same "Continue to X" pattern every other workflow step uses. */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            Forecast complete — the Performance stage is now unlocked.
          </p>
          <ContinueButton
            href={routes.performance}
            label="Continue to Performance"
            loadingLabel="Loading Performance…"
          />
        </CardContent>
      </Card>
    </div>
  );
}

/** Forecast Interpretation — portfolio-level read of the run, derived from the
 *  run's own numbers (band split, median WMAPE, champion mix). Data-driven, no
 *  invented narrative. */
function ForecastInterpretation({ metrics, levels = "SKUs" }: { metrics: ForecastRunMetrics; levels?: string }) {
  const k = metrics.kpis;
  const total = metrics.skus.length || 1;
  const good = metrics.bands["Good"] ?? 0;
  const review = metrics.bands["Review"] ?? 0;
  const poor = metrics.bands["Poor"] ?? 0;
  const mix = new Map<string, number>();
  for (const s of metrics.skus) {
    const key = s.strategyLabel || s.strategy;
    mix.set(key, (mix.get(key) ?? 0) + 1);
  }
  const topMix = [...mix.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, c]) => `${key} (${c})`)
    .join(", ");
  return (
    <Card>
      <CardContent className="space-y-1 pt-6">
        <div className="text-sm font-medium text-foreground">Forecast interpretation</div>
        <p className="text-sm text-muted-foreground">
          Across <span className="font-medium text-foreground">{formatNumber(k.skusForecasted)}</span> {levels},
          median test WMAPE is <span className="font-medium text-foreground">{pct(k.medianTestWmape)}</span>{" "}
          (train {pct(k.medianTrainWmape)}). Quality split:{" "}
          <span className="text-success">{good} Good</span> ·{" "}
          <span className="text-warning">{review} Review</span> ·{" "}
          <span className="text-destructive">{poor} Poor</span>{" "}
          ({((good / total) * 100).toFixed(0)}% in the Good band). Total forecast{" "}
          {k.totalForecastUnits != null ? formatNumber(k.totalForecastUnits, { maximumFractionDigits: 0 }) : "—"} units.{" "}
          {metrics.reconciled ? "Reconciled to brand totals. " : "Not reconciled to brand totals. "}
          Champion mix: {topMix || "—"}.
        </p>
      </CardContent>
    </Card>
  );
}
