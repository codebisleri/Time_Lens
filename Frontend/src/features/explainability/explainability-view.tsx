"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { ECharts } from "echarts";
import {
  PieChart,
  TrendingUp,
  TrendingDown,
  Minus,
  Layers,
  BarChart3,
  Boxes,
  Table2,
  Download,
  FileImage,
  ArrowRight,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { PageShell } from "@/components/layout/page-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/feedback/empty-state";
import { WorkflowHero } from "@/features/workflow/workflow-hero";
import { useAsync } from "@/lib/hooks";
import { explainabilityService, forecastService } from "@/lib/api/services";
import { useForecastLevel } from "@/lib/stores/forecast-level-store";
import { useExplainabilityFilterStore } from "@/lib/stores/explainability-filter-store";
import { useScenarioPlanningStore } from "@/lib/stores/scenario-planning-store";
import { routes } from "@/lib/constants/routes";
import { useThemeMode } from "@/lib/theme/use-theme-mode";
import { formatNumber } from "@/lib/utils/format";
import { downloadDataUrl, downloadFile } from "@/lib/utils/download";
import {
  DIRECTION_GLYPH,
  driverTableRows,
  driversToCsv,
  horizonToCsv,
  monthlyWaterfall,
  seasonalityStrengthLabel,
  trendDirectionLabel,
  waterfallToCsv,
  type DriverTableRow,
} from "./explainability-helpers";
import type { DriverContributions, HorizonPeriod } from "@/types/explainability";
import type { ForecastMetricRow, ForecastRunMetrics } from "@/types/forecast";

// Charts are lazy-loaded so the heavy echarts bundle is code-split (Task 13).
// NOTE: Next's next/dynamic SWC transform requires the options ({ ssr:false })
// to be an INLINE object literal per call — do not hoist it to a variable.
const ChartSkeleton = () => <Skeleton className="h-64 w-full rounded-md" />;
const WaterfallChart = dynamic(() => import("./explainability-charts").then((m) => m.WaterfallChart), { ssr: false, loading: ChartSkeleton });
const HorizonStacked = dynamic(() => import("./explainability-charts").then((m) => m.HorizonStacked), { ssr: false, loading: ChartSkeleton });

// Native <select> degrades badly past a few hundred <option> nodes; cap the
// rendered list (search narrows it) so 1000+/5000+/10000+ levels stay responsive.
const MAX_OPTIONS = 300;

function SectionHeading({ icon: Icon, children }: { icon: typeof PieChart; children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight text-foreground">
      <Icon className="size-4 text-primary" /> {children}
    </h2>
  );
}

/** Month / horizon selector (Tasks 6 & 7) — picks which forecast period the
 *  monthly Driver Contribution and Forecast Bridge decompose. */
function MonthSelect({
  periods,
  value,
  onChange,
}: {
  periods: HorizonPeriod[];
  value: number;
  onChange: (i: number) => void;
}) {
  if (periods.length <= 1) return null;
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="font-medium text-muted-foreground">Month</span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Select month / horizon"
        className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&>option]:bg-popover [&>option]:text-popover-foreground"
      >
        {periods.map((p, i) => (
          <option key={p.label} value={i}>
            {p.index ? `${p.index} · ${p.label}` : p.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Capture an ECharts instance (via EChartBase.onReady) for read-only PNG export. */
function useChartPng() {
  const ref = useRef<ECharts | null>(null);
  const { resolvedMode } = useThemeMode();
  const onReady = useCallback((c: ECharts | null) => {
    ref.current = c;
  }, []);
  const exportPng = useCallback(
    (filename: string) => {
      const c = ref.current;
      if (!c) return;
      const url = c.getDataURL({
        type: "png",
        pixelRatio: 2,
        backgroundColor: resolvedMode === "dark" ? "#0b1220" : "#ffffff",
      });
      downloadDataUrl(filename, url);
    },
    [resolvedMode],
  );
  return { onReady, exportPng };
}

/** Inline PNG + CSV export controls for a section (export feature). */
function ExportBar({ onPng, onCsv }: { onPng?: () => void; onCsv: () => void }) {
  return (
    <div className="flex items-center gap-2">
      {onPng ? (
        <Button variant="outline" size="sm" onClick={onPng} title="Download chart as PNG">
          <FileImage className="size-3.5" /> PNG
        </Button>
      ) : null}
      <Button variant="outline" size="sm" onClick={onCsv} title="Download data as CSV">
        <Download className="size-3.5" /> CSV
      </Button>
    </div>
  );
}

/** Driver Contribution table — Driver / Contribution % / Direction / Impact (Task 7). */
function DriverTable({ rows }: { rows: DriverTableRow[] }) {
  if (!rows.length) {
    return <p className="text-sm text-muted-foreground">No contributing drivers were detected.</p>;
  }
  const maxPct = Math.max(1, ...rows.map((r) => r.pct));
  const impactBadge = (impact: DriverTableRow["impact"]) =>
    impact === "High" ? "default" : impact === "Medium" ? "secondary" : "outline";
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <table className="w-full text-sm">
        <thead className="bg-secondary/40 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Driver</th>
            <th className="px-3 py-2 text-left font-medium">Contribution</th>
            <th className="px-3 py-2 text-center font-medium">Direction</th>
            <th className="px-3 py-2 text-right font-medium">Impact</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.driver} className="border-t border-border/60">
              <td className="px-3 py-2 font-medium text-foreground">{r.driver}</td>
              {/* Task 4 — inline mini contribution bar next to the % */}
              <td className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="w-11 shrink-0 text-right text-xs tabular-nums text-foreground">{r.pct}%</span>
                  <div className="h-2 min-w-[40px] flex-1 overflow-hidden rounded-full bg-secondary/70">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(2, Math.min(100, (r.pct / maxPct) * 100))}%`,
                        background:
                          // Theme-bound (Issue 4): up = orange, down = navy, flat = grey.
                          r.direction === "down"
                            ? "hsl(var(--chart-1))"
                            : r.direction === "up"
                              ? "hsl(var(--chart-2))"
                              : "hsl(var(--muted-foreground))",
                      }}
                    />
                  </div>
                </div>
              </td>
              <td className="px-3 py-2 text-center">
                <span
                  className={
                    r.direction === "up"
                      ? "text-success"
                      : r.direction === "down"
                        ? "text-destructive"
                        : "text-muted-foreground"
                  }
                  aria-label={r.direction}
                >
                  {DIRECTION_GLYPH[r.direction]}
                </span>
              </td>
              <td className="px-3 py-2 text-right">
                <Badge variant={impactBadge(r.impact)}>{r.impact}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A single labelled field in the summary card (Task 5). */
function SummaryField({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    // min-w-0 lets the cell shrink in the grid; break-words wraps long champion
    // labels (e.g. "Blend[median]:moe+prophet+…") instead of bleeding into the
    // neighbouring Segment cell.
    <div className="min-w-0 space-y-0.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`break-words text-sm font-semibold ${accent ?? "text-foreground"}`}>{value}</p>
    </div>
  );
}

/** Forecast-level summary card (Task 5): id, champion, segment, forecast, WMAPE,
 *  trend direction, seasonality strength. */
function SummaryCard({
  entity,
  levelLabel,
  row,
  contributions,
}: {
  entity: string;
  levelLabel: string;
  row: ForecastMetricRow | null;
  contributions: DriverContributions | null;
}) {
  const trend = contributions ? trendDirectionLabel(contributions) : "—";
  const TrendIcon = trend === "Increasing" ? TrendingUp : trend === "Decreasing" ? TrendingDown : Minus;
  const trendAccent =
    trend === "Increasing" ? "text-success" : trend === "Decreasing" ? "text-destructive" : "text-muted-foreground";
  const seasonality = contributions ? seasonalityStrengthLabel(contributions) : "—";
  const wmape = row?.testWmape ?? row?.trainWmape;
  return (
    <Card className="border-primary/20 bg-gradient-to-br from-primary/[0.04] to-transparent">
      <CardContent className="grid grid-cols-2 gap-x-6 gap-y-4 pt-6 sm:grid-cols-3 lg:grid-cols-4">
        <SummaryField label={levelLabel} value={entity || "—"} accent="text-primary" />
        <SummaryField label="Champion model" value={row?.strategyLabel || "—"} />
        <SummaryField label="Segment" value={row?.segment || "—"} />
        <SummaryField label="Forecast" value={row?.forecastTotal != null ? formatNumber(Math.round(row.forecastTotal)) : "—"} />
        <SummaryField label="WMAPE" value={wmape != null ? `${wmape.toFixed(1)}%` : "—"} />
        <SummaryField
          label="Trend direction"
          value={
            <span className={`inline-flex items-center gap-1 ${trendAccent}`}>
              <TrendIcon className="size-4" /> {trend}
            </span>
          }
        />
        <SummaryField label="Seasonality" value={seasonality} />
      </CardContent>
    </Card>
  );
}

/**
 * Forecast Explainability (Phase X.U → forecast-level only in X.W) — a READ-ONLY
 * interpretation layer between Forecast and Scenario. Everything is scoped to a
 * single selected Forecast Level: summary, drivers, model-specific explanation,
 * waterfall, and per-horizon breakdown. All derived from already-computed data;
 * no forecast is rerun or changed. Portfolio / global / segment views removed.
 */
export function ExplainabilityView() {
  const router = useRouter();
  const setScenarioSku = useScenarioPlanningStore((s) => s.setSku);
  const { label: levelLabel, plural: levelPlural } = useForecastLevel();
  const metrics = useAsync<ForecastRunMetrics>(() => forecastService.metrics(), []);

  const entities = useMemo(() => (metrics.data?.skus ?? []).map((s) => s.sku), [metrics.data]);
  const [entity, setEntity] = useState<string>("");

  // Brand + Segment filters (Task 3) — replace the free-text SKU search. Brand /
  // segment come from the run metrics rows; selections are persisted.
  const { brands: selBrands, segments: selSegments, setBrands, setSegments } =
    useExplainabilityFilterStore();
  const metricBySku = useMemo(() => {
    const m = new Map<string, { brand: string | null; segment: string | null }>();
    for (const s of metrics.data?.skus ?? []) m.set(s.sku, { brand: s.brand, segment: s.segment });
    return m;
  }, [metrics.data]);
  const brandOptions = useMemo(
    () => Array.from(new Set((metrics.data?.skus ?? []).map((s) => s.brand).filter((b): b is string => !!b))).sort(),
    [metrics.data],
  );
  const segmentOptions = useMemo(
    () => Array.from(new Set((metrics.data?.skus ?? []).map((s) => s.segment).filter((s): s is string => !!s))).sort(),
    [metrics.data],
  );
  const matched = useMemo(
    () =>
      entities.filter((e) => {
        const row = metricBySku.get(e);
        const brandOk = selBrands.length === 0 || (row?.brand != null && selBrands.includes(row.brand));
        const segOk = selSegments.length === 0 || (row?.segment != null && selSegments.includes(row.segment));
        return brandOk && segOk;
      }),
    [entities, metricBySku, selBrands, selSegments],
  );
  const filtered = useMemo(() => matched.slice(0, MAX_OPTIONS), [matched]);
  const activeEntity =
    entity && matched.includes(entity) ? entity : matched[0] ?? entities[0] ?? "";

  const local = useAsync(
    () => (activeEntity ? explainabilityService.local(activeEntity) : Promise.resolve(null)),
    [activeEntity],
  );
  const horizon = useAsync(
    () => (activeEntity ? explainabilityService.horizon(activeEntity) : Promise.resolve(null)),
    [activeEntity],
  );
  const championRow = useMemo(
    () => metrics.data?.skus.find((s) => s.sku === activeEntity) ?? null,
    [metrics.data, activeEntity],
  );

  const localContrib = local.data?.contributions ?? null;
  const driverRows = useMemo(
    () => (localContrib ? driverTableRows(localContrib) : []),
    [localContrib],
  );

  // Monthly / horizon selector (Tasks 6 & 7) — drives the actual-value Driver
  // Contribution and the month-wise Forecast Bridge.
  const periods = useMemo(() => horizon.data?.periods ?? [], [horizon.data]);
  const [monthIdx, setMonthIdx] = useState(0);
  useEffect(() => { setMonthIdx(0); }, [activeEntity]);
  const safeIdx = periods.length ? Math.min(monthIdx, periods.length - 1) : 0;
  const selectedPeriod = periods[safeIdx] ?? null;
  const selectedDrivers = selectedPeriod?.drivers ?? null;
  // Month-wise Forecast Bridge (Task 6) — falls back to the aggregate local
  // waterfall when no per-month breakdown is available.
  const bridgeSteps = useMemo(
    () =>
      selectedPeriod && selectedDrivers
        ? monthlyWaterfall(selectedPeriod.base, selectedDrivers)
        : local.data?.waterfall ?? [],
    [selectedPeriod, selectedDrivers, local.data],
  );

  const waterfallPng = useChartPng();
  const horizonPng = useChartPng();

  const fileSafe = (s: string) => (s || "level").replace(/[^a-z0-9_-]+/gi, "_");
  const localReady = local.data?.available && localContrib;

  return (
    <PageShell
      title="Explainability"
      description="Understand what drives a single forecast level — its drivers, champion model, forecast bridge, and per-horizon breakdown. Read-only; forecasts are never changed."
    >
      <WorkflowHero
        step="Step 5 · Explainability"
        title="Why this forecast?"
        subtitle="Pick a forecast level to see exactly what drives its demand — trend, seasonality, promotion, price and more"
        icon={PieChart}
        variant="network"
      />

      {/* ── Brand + Segment filters → matching forecast levels (Task 3) ─────── */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          {brandOptions.length ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-foreground">Brand</p>
              <div className="flex flex-wrap gap-1.5">
                {brandOptions.map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => setBrands(selBrands.includes(b) ? selBrands.filter((x) => x !== b) : [...selBrands, b])}
                    className={
                      "rounded-full border px-2.5 py-1 text-xs transition-colors " +
                      (selBrands.includes(b) ? "border-primary bg-primary/15 text-primary" : "border-border text-muted-foreground hover:bg-secondary/50")
                    }
                  >
                    {b}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {segmentOptions.length ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-foreground">Segment</p>
              <div className="flex flex-wrap gap-1.5">
                {segmentOptions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSegments(selSegments.includes(s) ? selSegments.filter((x) => x !== s) : [...selSegments, s])}
                    className={
                      "rounded-full border px-2.5 py-1 text-xs transition-colors " +
                      (selSegments.includes(s) ? "border-primary bg-primary/15 text-primary" : "border-border text-muted-foreground hover:bg-secondary/50")
                    }
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-foreground">
              {matched.length.toLocaleString()} matching {matched.length === 1 ? levelLabel : levelPlural}
            </label>
            {entities.length ? (
              <select
                value={activeEntity}
                onChange={(e) => setEntity(e.target.value)}
                aria-label="Select Forecast Level"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&>option]:bg-popover [&>option]:text-popover-foreground"
              >
                {filtered.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-muted-foreground">No forecasted {levelPlural.toLowerCase()} yet.</p>
            )}
            {matched.length > MAX_OPTIONS ? (
              <p className="text-xs text-muted-foreground">
                Showing the first {MAX_OPTIONS.toLocaleString()} of {matched.length.toLocaleString()} — refine with the filters above.
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* ── Summary card (Task 5) ──────────────────────────────────────────── */}
      <section id="summary" className="scroll-mt-24 space-y-3">
        <SectionHeading icon={Boxes}>{levelLabel} Summary</SectionHeading>
        {local.isLoading ? (
          <Skeleton className="h-28 w-full" />
        ) : (
          <SummaryCard entity={activeEntity} levelLabel={levelLabel} row={championRow} contributions={localContrib} />
        )}
      </section>

      {/* ── Global Driver Contributions (Phase Y.12 · Task A1) — the aggregate
          contribution over the whole horizon. Single heading (the duplicate
          "Driver Contribution" subheading was removed); PNG/CSV exports + the
          chart are unchanged. ─────────────────────────────────────────────────── */}
      <section id="drivers" className="scroll-mt-24 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionHeading icon={BarChart3}>Global Driver Contributions</SectionHeading>
          {localReady ? (
            <ExportBar
              onCsv={() => downloadFile(`explainability-drivers-${fileSafe(activeEntity)}.csv`, driversToCsv(localContrib!, `Global drivers — ${activeEntity}`))}
            />
          ) : null}
        </div>
        {local.isLoading ? (
          <Skeleton className="h-72 w-full" />
        ) : localReady ? (
          // Task 4 — the standalone "Overall contribution" bar chart was removed;
          // the contribution bars now render INLINE inside the Driver Importance
          // table (compact, no duplicate chart).
          <Card>
            <CardContent className="space-y-3 pt-6">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Table2 className="size-4 text-primary" /> Driver Importance
              </h3>
              <DriverTable rows={driverRows} />
            </CardContent>
          </Card>
        ) : activeEntity ? (
          <EmptyState
            title="Estimated forecast drivers based on historical decomposition"
            description="Not enough history yet to decompose this forecast level into individual drivers."
          />
        ) : (
          <EmptyState title="No explainability information available" description="Select a forecast level to explain." />
        )}
      </section>

      {/* ── Local Driver Contributions (Phase Y.12 · Task A2) — its own section
          heading above the Forecast Bridge (which stays the smaller chart title,
          with the month selector + PNG/CSV exports). ────────────────────────── */}
      <section id="local" className="scroll-mt-24 space-y-3">
        <SectionHeading icon={BarChart3}>Local Driver Contributions</SectionHeading>
        <Card>
          <CardContent className="space-y-3 pt-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Layers className="size-4 text-primary" /> Forecast Bridge — {activeEntity || levelLabel}
              </h3>
              <div className="flex items-center gap-3">
                <MonthSelect periods={periods} value={safeIdx} onChange={setMonthIdx} />
                {bridgeSteps.length ? (
                  <ExportBar
                    onPng={() => waterfallPng.exportPng(`explainability-bridge-${fileSafe(activeEntity)}.png`)}
                    onCsv={() => downloadFile(`explainability-bridge-${fileSafe(activeEntity)}.csv`, waterfallToCsv(bridgeSteps, activeEntity))}
                  />
                ) : null}
              </div>
            </div>
            {local.isLoading ? (
              <Skeleton className="h-72 w-full" />
            ) : bridgeSteps.length ? (
              <>
                <p className="mb-2 text-sm font-medium text-foreground">
                  Base demand → drivers → final forecast
                  {selectedPeriod ? ` · ${selectedPeriod.index ? `${selectedPeriod.index} ` : ""}${selectedPeriod.label}` : ""}
                </p>
                <WaterfallChart steps={bridgeSteps} onReady={waterfallPng.onReady} />
              </>
            ) : activeEntity ? (
              <EmptyState
                title="Estimated forecast drivers based on historical decomposition"
                description="Not enough history yet to build a forecast bridge for this level."
              />
            ) : (
              <EmptyState title="No explainability information available" description="Select a forecast level to explain." />
            )}
          </CardContent>
        </Card>
      </section>

      {/* ── Horizon (Task 10) ──────────────────────────────────────────────── */}
      <section id="horizon" className="scroll-mt-24 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <SectionHeading icon={TrendingUp}>By Horizon — {activeEntity || levelLabel}</SectionHeading>
          {horizon.data?.available && horizon.data.periods.length ? (
            <ExportBar
              onPng={() => horizonPng.exportPng(`explainability-horizon-${fileSafe(activeEntity)}.png`)}
              onCsv={() => downloadFile(`explainability-horizon-${fileSafe(activeEntity)}.csv`, horizonToCsv(horizon.data!.periods, activeEntity))}
            />
          ) : null}
        </div>
        <Card>
          <CardContent className="space-y-3 pt-6">
            {horizon.isLoading ? (
              <Skeleton className="h-72 w-full" />
            ) : horizon.data?.available && horizon.data.periods.length ? (
              <>
                <HorizonStacked periods={horizon.data.periods} onReady={horizonPng.onReady} />
                <div className="max-h-72 overflow-auto rounded-md border border-border">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-secondary/40 text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-1.5 text-left font-medium">Horizon</th>
                        <th className="px-3 py-1.5 text-left font-medium">Period</th>
                        <th className="px-3 py-1.5 text-right font-medium">Trend %</th>
                        <th className="px-3 py-1.5 text-right font-medium">Seasonality %</th>
                        <th className="px-3 py-1.5 text-right font-medium">Exogenous %</th>
                        <th className="px-3 py-1.5 text-right font-medium">Residual %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {horizon.data.periods.map((p) => (
                        <tr key={p.label} className="border-t border-border/60">
                          <td className="px-3 py-1.5 font-medium text-foreground">{p.index ?? "—"}</td>
                          <td className="px-3 py-1.5">{p.label}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{p.trendPct ?? 0}%</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{p.seasonalityPct ?? 0}%</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{p.exogenousPct ?? 0}%</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{p.residualPct ?? 0}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : activeEntity ? (
              <EmptyState title="No horizon breakdown available" description="Select a forecast level with sufficient history." />
            ) : (
              <EmptyState title="No explainability information available" description="Select a forecast level to explain." />
            )}
          </CardContent>
        </Card>
      </section>

      {/* Continue to Scenario — carries the selected forecast level into Scenario
          Planning so the planner doesn't lose context. The selected SKU is saved
          to the scenario store; the forecast/champion model + forecast data are
          re-resolved on the Scenario page for that same SKU. */}
      <section className="flex flex-col items-stretch gap-3 border-t border-border/60 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-muted-foreground">
          {activeEntity ? (
            <>
              Next: estimate causal effects and run What-If simulations for{" "}
              <span className="font-medium text-foreground">{activeEntity}</span>.
            </>
          ) : (
            <>Select a {levelLabel.toLowerCase()} to continue to Scenario Planning.</>
          )}
        </div>
        <Button
          onClick={() => {
            if (activeEntity) setScenarioSku(activeEntity);
            router.push(routes.scenarios);
          }}
          disabled={!activeEntity}
          className="sm:w-60"
        >
          Continue to Scenario <ArrowRight className="size-4" />
        </Button>
      </section>
    </PageShell>
  );
}
