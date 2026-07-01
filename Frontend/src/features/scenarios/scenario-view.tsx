"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EChartsOption } from "echarts";
import {
  Download,
  GitBranch,
  Loader2,
  Lock,
  Play,
  Save,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/feedback/empty-state";
import { EChartBase } from "@/components/charts/echart-base";
import { useThemeMode } from "@/lib/theme/use-theme-mode";
import { readCssVar } from "@/lib/theme/theme-config";
import { useAsync } from "@/lib/hooks";
import { forecastService, whatifService } from "@/lib/api/services";
import { formatDate, formatNumber } from "@/lib/utils/format";
import { downloadFile } from "@/lib/utils/download";
import { routes } from "@/lib/constants/routes";
import { WorkflowHero } from "@/features/workflow/workflow-hero";
import { WorkflowLock } from "@/features/workflow/workflow-lock";
import { useWorkflowStatus } from "@/features/workflow/use-workflow-status";
import { Field, Select } from "@/features/data/controls";
import { useForecastLevel } from "@/lib/stores/forecast-level-store";
import { useScenarioPlanningStore } from "@/lib/stores/scenario-planning-store";
import { ScenarioCausalView } from "./scenario-causal-view";
import { CausalGraph } from "./causal-graph";
import { WhatIfGrid, type WhatIfGridState } from "./whatif-grid";
import type { ForecastJob } from "@/types/forecast";
import type { ScenarioRunResult } from "@/types/whatif";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const POLL_MS = 2500;
const MAX_WAIT_MS = 12 * 60 * 1000;

const EMPTY_GRID: WhatIfGridState = { ready: false, valid: false, months: [], values: {} };

function signed(v: number | null): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/** Baseline-vs-scenario line chart (dotted baseline, solid scenario). */
function ScenarioChart({ result }: { result: ScenarioRunResult }) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const muted = readCssVar("--muted-foreground") || "#94a3b8";
    const orange = readCssVar("--warning") || "#ef7602";
    const pts = Array.isArray(result.series) ? result.series : [];
    const labels = pts.map((p) =>
      formatDate(p.date, { month: "short", year: "2-digit", day: undefined }),
    );
    return {
      animationDuration: 500,
      tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "—" : formatNumber(v as number)) },
      legend: { data: ["Baseline", "Scenario"], top: 0, itemWidth: 12 },
      grid: { left: 4, right: 12, top: 28, bottom: 4, containLabel: true },
      xAxis: { type: "category", data: labels, boundaryGap: false },
      yAxis: { type: "value" },
      series: [
        {
          name: "Baseline",
          type: "line",
          data: pts.map((p) => p.baseline),
          lineStyle: { width: 2, type: "dashed", color: muted },
          itemStyle: { color: muted },
          showSymbol: false,
        },
        {
          name: "Scenario",
          type: "line",
          data: pts.map((p) => p.scenario ?? null),
          lineStyle: { width: 3, color: orange },
          itemStyle: { color: orange },
          showSymbol: false,
        },
      ],
    };
  }, [result, resolvedMode]);
  return <EChartBase option={option} height={300} />;
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="glass group relative overflow-hidden p-5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-lg)]">
      <div className="brand-rail pointer-events-none absolute inset-x-0 top-0 h-0.5 opacity-70" aria-hidden />
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1.5 text-3xl font-semibold tabular-nums text-foreground">{value}</p>
      {sub ? <p className="mt-1 text-xs text-muted-foreground">{sub}</p> : null}
    </Card>
  );
}

function humanList(items: string[]): string {
  if (!items.length) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** One-line, planner-friendly summary of the scenario impact — e.g.
 *  "Promotion increases expected demand by 14% (+1,203 units) vs the baseline." */
function whatifExplanation(r: ScenarioRunResult): string {
  if (r.changePct == null || r.scenarioTotal == null) return "";
  const feats = (r.appliedAdjustments ?? []).map((a) => a.feature);
  const subject = feats.length ? humanList(feats) : "This adjustment";
  const dir = r.changePct >= 0 ? "increases" : "reduces";
  const mag = Math.abs(r.changePct).toFixed(1);
  const units =
    r.deltaUnits != null
      ? ` (${r.deltaUnits >= 0 ? "+" : ""}${formatNumber(Math.round(r.deltaUnits))} units)`
      : "";
  return `${subject} ${dir} expected demand by ${mag}%${units} vs the baseline.`;
}

/**
 * Scenario Planning (Step 7). The workflow is now strictly:
 *   Causal Effect Estimation (DoWhy) → causal graph stored → What-If Simulation.
 * The What-If Feature Simulation stays LOCKED until DoWhy has produced a causal
 * graph for the selected level; the What-If simulator then CONSUMES that exact
 * graph (its levers + structure) — no second graph is created. The simulation
 * uses an editable monthly grid (Feature × forecast month).
 */
export function ScenarioPlanningView() {
  const workflow = useWorkflowStatus();
  // The Scenario SKU list is ONLY the forecasted items (the latest run's metrics).
  const metrics = useAsync(() => forecastService.metrics(), []);
  const saved = useAsync(() => whatifService.list(), []);

  const skus = useMemo(
    () => (metrics.data?.skus ?? []).map((s) => s.sku),
    [metrics.data],
  );
  const { label: levelLabel } = useForecastLevel();
  const { mode, setMode, sku, setSku, causalGraph } = useScenarioPlanningStore();

  const [phase, setPhase] = useState<"idle" | "running" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [jobMessage, setJobMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScenarioRunResult | null>(null);
  const [name, setName] = useState("");
  const [grid, setGrid] = useState<WhatIfGridState>(EMPTY_GRID);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => { cancelled.current = true; };
  }, []);
  // Seed / repair the selection: if nothing is chosen — or the persisted SKU is
  // no longer among the forecasted SKUs — fall back to the first forecasted one.
  useEffect(() => {
    if (skus.length && !skus.includes(sku)) setSku(skus[0]!);
  }, [skus, sku]);

  const activeSku = sku && skus.includes(sku) ? sku : (skus[0] ?? "");

  // TASK 1 gate — What-If is unlocked ONLY when a DoWhy causal graph exists for
  // the active level. When the level changes, the stored graph no longer matches
  // and What-If re-locks until DoWhy is run for the new level.
  const graphReady = !!causalGraph && causalGraph.sku === activeSku && causalGraph.variables.treatments.length > 0;

  // TASK 5 — the Scenario page must ALWAYS open on the Causal Effect Estimation
  // (DoWhy) tab. Force it on entry (mount), regardless of any persisted `mode`.
  useEffect(() => {
    setMode("causal");
    // run once on mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // What-If stays LOCKED until a DoWhy causal graph exists for the active level:
  // if the graph is missing (e.g. the level changed), snap back to the causal tab
  // so the locked tab can never remain the active view.
  useEffect(() => {
    if (mode === "whatif" && !graphReady) setMode("causal");
  }, [mode, graphReady, setMode]);
  // The levers the What-If grid edits come straight from the DoWhy graph.
  const graphLevers = useMemo(
    () => (graphReady ? causalGraph!.variables.treatments : []),
    [graphReady, causalGraph],
  );

  const pollJob = useCallback(async (start: ForecastJob): Promise<ForecastJob> => {
    let job = start;
    let waited = 0;
    setJobMessage(job.message ?? "");
    while (job.status !== "completed" && job.status !== "failed") {
      await wait(POLL_MS);
      if (cancelled.current) return job;
      waited += POLL_MS;
      if (waited > MAX_WAIT_MS) break;
      try { job = await forecastService.getJob(job.id); } catch { /* transient */ }
      setProgress(job.progress ?? 0);
      setJobMessage(job.message ?? "");
    }
    return job;
  }, []);

  const run = useCallback(async () => {
    if (!activeSku || !grid.ready || !grid.valid) return;
    setPhase("running");
    setProgress(0);
    setError(null);
    try {
      const job = await pollJob(
        await whatifService.run({
          skuId: activeSku,
          monthlyValues: grid.values,
          months: grid.months,
        }),
      );
      if (cancelled.current) return;
      if (job.status === "failed") {
        setError(job.error ?? "Scenario run failed.");
        setPhase("error");
        return;
      }
      const res = job.result as ScenarioRunResult | null;
      if (res) setResult(res);
      setPhase("idle");
    } catch (err) {
      if (cancelled.current) return;
      setError((err as { message?: string })?.message ?? "Scenario run failed.");
      setPhase("error");
    }
  }, [activeSku, grid, pollJob]);

  const exportSeriesCsv = useCallback(() => {
    if (!result) return;
    const head = ["date", "baseline", "scenario"];
    const rows = result.series.map((p) =>
      [p.date, p.baseline ?? "", p.scenario ?? ""].join(","));
    const summary = [
      `# Scenario ${result.sku} · champion ${result.championModel}`,
      `# baselineTotal,${result.baselineTotal}`,
      `# scenarioTotal,${result.scenarioTotal ?? ""}`,
      `# changePct,${result.changePct ?? ""}`,
    ];
    downloadFile(`scenario-${result.sku}.csv`, [...summary, head.join(","), ...rows].join("\r\n"));
  }, [result]);

  const save = useCallback(async () => {
    if (!result) return;
    try {
      await whatifService.save({
        name: name.trim() || `Scenario · ${result.sku}`,
        sku: result.sku,
        result,
        adjustments: result.appliedAdjustments,
      });
      toast.success("Scenario saved");
      setName("");
      await saved.refetch().catch(() => {});
    } catch {
      toast.error("Couldn’t save scenario");
    }
  }, [result, name, saved]);

  const loadSaved = useCallback(async (id: string) => {
    try {
      const d = await whatifService.getById(id);
      setSku(d.sku);
      setResult(d.result);
    } catch {
      toast.error("Couldn’t load scenario");
    }
  }, []);

  const removeSaved = useCallback(async (id: string) => {
    try {
      await whatifService.remove(id);
      await saved.refetch().catch(() => {});
    } catch {
      toast.error("Couldn’t delete scenario");
    }
  }, [saved]);

  const gated =
    !workflow.isLoading && workflow.data && !workflow.data.forecastCompleted;
  const running = phase === "running";

  if (gated) {
    return (
      <PageShell title="Scenario Planning" description="Step 7 · What-If analysis.">
        <WorkflowLock
          title="Scenario Planning locked"
          message="Run a forecast first."
          href={routes.forecast}
          ctaLabel="Go to Forecast"
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Scenario Planning"
      description="What-If analysis — adjust feature assumptions and re-forecast against the baseline."
    >
      <WorkflowHero
        step="Step 7 · Scenarios"
        title="What-If & Causal Sensitivity"
        subtitle="Estimate causal effects with DoWhy, then simulate price / promo / festival impact on the forecast"
        icon={SlidersHorizontal}
        variant="network"
      />

      <details className="rounded-md border border-border/60 bg-secondary/20 p-3">
        <summary className="cursor-pointer text-sm font-medium text-foreground">ℹ️ How to use this tab</summary>
        <div className="mt-2 space-y-1 text-sm text-muted-foreground">
          <p>
            <strong>1. Causal Effect Estimation (DoWhy)</strong> measures how much a lever (price, promo,
            discount) actually moves demand and generates the causal graph.
          </p>
          <p>
            <strong>2. What-If Feature Simulation</strong> unlocks once that graph exists — edit each
            lever month by month and re-compare against the baseline forecast.
          </p>
        </div>
      </details>

      {/* Scenario type selector. */}
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Scenario type</p>
        <div className="flex flex-wrap gap-2">
          {([["causal", "Causal Effect Estimation (DoWhy)"], ["whatif", "What-If Feature Simulation"]] as const).map(
            ([id, label]) => {
              // TASK 5 — the What-If tab is selectable ONLY after DoWhy has
              // produced a causal graph for this level; until then it is locked.
              const locked = id === "whatif" && !graphReady;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => !locked && setMode(id)}
                  disabled={locked}
                  aria-disabled={locked}
                  title={locked ? "Run Causal Effect Estimation (DoWhy) to unlock What-If." : undefined}
                  className={
                    "rounded-md border px-3 py-1.5 text-sm transition-colors " +
                    (mode === id
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-secondary/50") +
                    (locked ? " cursor-not-allowed opacity-60 hover:bg-transparent" : "")
                  }
                >
                  {label}
                  {locked ? (
                    <Lock className="ml-1.5 inline size-3 align-[-1px] opacity-70" aria-label="Locked" />
                  ) : null}
                </button>
              );
            },
          )}
        </div>
      </div>

      {mode === "causal" ? (
        <>
          <Card>
            <CardContent className="pt-6">
              <Field label={levelLabel}>
                <Select
                  value={activeSku}
                  onChange={setSku}
                  options={skus.map((s) => ({ value: s, label: s }))}
                  ariaLabel={levelLabel}
                />
              </Field>
            </CardContent>
          </Card>
          <ScenarioCausalView sku={activeSku} />
        </>
      ) : null}

      {mode === "whatif" ? (
        <>
          {/* Level selector (shared with the causal step). */}
          <Card>
            <CardContent className="pt-6">
              <Field label={levelLabel}>
                <Select
                  value={activeSku}
                  onChange={setSku}
                  options={skus.map((s) => ({ value: s, label: s }))}
                  ariaLabel={levelLabel}
                />
              </Field>
            </CardContent>
          </Card>

          {!graphReady ? (
            // TASK 1 — locked until a DoWhy causal graph exists for this level.
            <Card className="border-warning/40">
              <CardContent className="flex flex-col items-start gap-3 pt-6">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Lock className="size-4 text-warning" /> What-If Feature Simulation is locked
                </div>
                <p className="text-sm text-muted-foreground">
                  Run Causal Effect Estimation (DoWhy) to generate the causal graph before performing
                  What-If simulations.
                </p>
                <Button onClick={() => setMode("causal")}>
                  <GitBranch className="size-4" /> Run Causal Effect Estimation (DoWhy)
                </Button>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Consume the DoWhy causal graph — the SAME structure the estimation
                  produced (its treatments / confounders), not a separately-built one. */}
              <Card>
                <CardContent className="space-y-2 pt-6">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <GitBranch className="size-4 text-primary" /> Using the causal graph from DoWhy
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Generated {formatDate(causalGraph!.generatedAt, { month: "short", day: "numeric", year: "numeric" })}.
                    The levers below come directly from this graph.
                  </p>
                </CardContent>
              </Card>
              <CausalGraph
                sku={activeSku}
                treatments={causalGraph!.variables.treatments}
                confounders={causalGraph!.variables.confounders}
                instruments={causalGraph!.variables.instruments}
                effectModifiers={causalGraph!.variables.effect_modifiers}
              />

              {/* TASK 2 — editable monthly grid (Feature × forecast month). */}
              <Card id="build" className="scroll-mt-24">
                <CardHeader>
                  <CardTitle className="text-base">What-If feature assumptions</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <WhatIfGrid sku={activeSku} features={graphLevers} onChange={setGrid} />

                  <div className="flex flex-wrap items-center gap-3 border-t border-border/60 pt-4">
                    <Button
                      onClick={() => void run()}
                      disabled={running || !activeSku || !grid.ready || !grid.valid}
                      className="sm:w-56"
                    >
                      {running ? (
                        <><Loader2 className="size-4 animate-spin" /> {`Running… ${progress}%`}</>
                      ) : (
                        <><Play className="size-4" /> Run scenario</>
                      )}
                    </Button>
                    {!grid.valid && grid.ready ? (
                      <span className="text-xs text-destructive">
                        Fix the highlighted cells before running.
                      </span>
                    ) : null}
                    {running && jobMessage ? (
                      <span className="text-xs text-muted-foreground">{jobMessage}</span>
                    ) : null}
                  </div>
                  {phase === "error" ? (
                    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                      {error}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </>
          )}

          {/* Result */}
          <span id="results" className="block scroll-mt-24" aria-hidden />
          {result ? (
            <>
              {result.message ? (
                <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-foreground">
                  {result.message}
                </div>
              ) : null}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Kpi label="Baseline total" value={formatNumber(Math.round(result.baselineTotal))} sub={`Champion: ${result.championModel}`} />
                <Kpi
                  label="Scenario total"
                  value={result.scenarioTotal == null ? "—" : formatNumber(Math.round(result.scenarioTotal))}
                  sub={result.deltaUnits == null ? undefined : `${result.deltaUnits > 0 ? "+" : ""}${formatNumber(Math.round(result.deltaUnits))} vs baseline`}
                />
                <Kpi label="Change %" value={signed(result.changePct)} />
              </div>

              {whatifExplanation(result) ? (
                <div className="rounded-md border border-primary/25 bg-primary/5 px-4 py-2.5 text-sm font-medium text-foreground">
                  {whatifExplanation(result)}
                </div>
              ) : null}

              <Card>
                <CardContent className="space-y-3 pt-6">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-foreground">Baseline vs Scenario</h3>
                    <Button variant="outline" size="sm" onClick={exportSeriesCsv}>
                      <Download className="size-3.5" /> CSV
                    </Button>
                  </div>
                  <ScenarioChart result={result} />
                </CardContent>
              </Card>

              {result.waterfall && result.waterfall.length > 2 ? (
                <Card>
                  <CardContent className="space-y-2 pt-6">
                    <h3 className="text-sm font-medium text-foreground">Scenario breakdown</h3>
                    <div className="divide-y divide-border/60">
                      {result.waterfall.map((step, i) => {
                        const isEdge = step.type !== "delta";
                        const v = Math.round(step.value);
                        const display = isEdge ? formatNumber(v) : `${v > 0 ? "+" : ""}${formatNumber(v)}`;
                        return (
                          <div key={`${step.label}-${i}`} className="flex items-center justify-between py-2 text-sm">
                            <span className={isEdge ? "font-semibold text-foreground" : "text-muted-foreground"}>
                              {step.label}
                            </span>
                            <span
                              className={
                                "tabular-nums " +
                                (isEdge
                                  ? "font-semibold text-foreground"
                                  : v > 0
                                    ? "text-success"
                                    : v < 0
                                      ? "text-destructive"
                                      : "text-muted-foreground")
                              }
                            >
                              {display} units
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              ) : null}

              {result.supported ? (
                <Card>
                  <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-end">
                    <Field label="Scenario name" className="flex-1">
                      <Input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={`Scenario · ${result.sku}`}
                      />
                    </Field>
                    <Button variant="outline" onClick={() => void save()}>
                      <Save className="size-4" /> Save scenario
                    </Button>
                  </CardContent>
                </Card>
              ) : null}
            </>
          ) : null}

          {/* Saved scenarios */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Saved scenarios</CardTitle>
            </CardHeader>
            <CardContent>
              {saved.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : (saved.data ?? []).length === 0 ? (
                <EmptyState title="No saved scenarios" description="Run and save a what-if scenario to keep it here." />
              ) : (
                <div className="overflow-auto rounded-lg border border-border">
                  <table className="w-full border-collapse text-sm">
                    <thead className="bg-card text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-medium">Name</th>
                        <th className="px-3 py-2 font-medium">{levelLabel}</th>
                        <th className="px-3 py-2 font-medium">Model</th>
                        <th className="px-3 py-2 text-right font-medium">Change %</th>
                        <th className="px-3 py-2 text-right font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(saved.data ?? []).map((s) => (
                        <tr key={s.id} className="border-t border-border/60">
                          <td className="px-3 py-2 text-foreground">{s.name}</td>
                          <td className="px-3 py-2 font-mono text-xs">{s.sku}</td>
                          <td className="px-3 py-2 text-muted-foreground">{s.championModel ?? "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{signed(s.changePct)}</td>
                          <td className="px-3 py-2 text-right">
                            <div className="flex justify-end gap-1">
                              <Button variant="ghost" size="sm" onClick={() => void loadSaved(s.id)}>View</Button>
                              <Button variant="ghost" size="icon" onClick={() => void removeSaved(s.id)} aria-label="Delete">
                                <Trash2 className="size-4 text-destructive" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </PageShell>
  );
}
