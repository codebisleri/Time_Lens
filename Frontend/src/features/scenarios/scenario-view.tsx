"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EChartsOption } from "echarts";
import { Download, Loader2, Play, Save, SlidersHorizontal, Trash2 } from "lucide-react";
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
import { NumericInput } from "@/components/ui/numeric-input";
import { useForecastLevel } from "@/lib/stores/forecast-level-store";
import { useScenarioPlanningStore } from "@/lib/stores/scenario-planning-store";
import { ScenarioCausalView } from "./scenario-causal-view";
import { CausalGraph } from "./causal-graph";
import type { ForecastJob } from "@/types/forecast";
import type {
  CausalRunResult,
  ScenarioAdjustment,
  ScenarioRunResult,
  WhatIfChangeType,
} from "@/types/whatif";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const POLL_MS = 2500;
const MAX_WAIT_MS = 12 * 60 * 1000;
const CHANGE_TYPES: WhatIfChangeType[] = [
  "Percentage Change",
  "Constant Change",
  "Set to New Value",
];

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
      formatDate(p.date, { month: "short", year: "numeric", day: undefined }),
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

/** One-line, planner-friendly summary of the scenario impact (Task 6) — e.g.
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
 * Scenario Planning (Step 7 · What-If) — faithful to Streamlit's render_whatif_tab:
 * choose a SKU, add exog adjustments (% / constant / set-to) over the EXISTING
 * forecast horizon, run a re-forecast, and compare scenario vs baseline. A causal
 * relationship graph is shown before running. Scenarios persist per user/dataset.
 */
export function ScenarioPlanningView() {
  const workflow = useWorkflowStatus();
  // Phase Y.16 · Task 4 — the Scenario SKU list is ONLY the forecasted items
  // (the latest forecast run's metrics), NOT the whole SKU catalog.
  const metrics = useAsync(() => forecastService.metrics(), []);
  const saved = useAsync(() => whatifService.list(), []);

  const skus = useMemo(
    () => (metrics.data?.skus ?? []).map((s) => s.sku),
    [metrics.data],
  );
  const { label: levelLabel } = useForecastLevel();
  // Persisted planning state (Task 6 — survives refresh / restart / Electron).
  // Phase Y.11 — no Forecast Horizon input here (parity with Streamlit's
  // render_whatif_tab): the scenario reuses the EXISTING forecast horizon (the
  // backend resolves it from the prior single-SKU run / saved config).
  const { mode, setMode, sku, setSku, adjustments, setAdjustments,
    applyCausal, setApplyCausal, start, end, setWindow } = useScenarioPlanningStore();
  const [features, setFeatures] = useState<string[]>([]);
  const [phase, setPhase] = useState<"idle" | "running" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [jobMessage, setJobMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScenarioRunResult | null>(null);
  const [name, setName] = useState("");
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
    if (!activeSku) return;
    setPhase("running");
    setProgress(0);
    setError(null);
    try {
      // "Apply causal estimate" path (parity with render_whatif_tab): estimate
      // the lever's DoWhy ATE first, then apply it to the baseline. Only when a
      // single adjustment is set (matches the source's single-rule requirement).
      let causalAte: number | undefined;
      if (applyCausal && adjustments.length === 1) {
        setJobMessage("Estimating causal effect…");
        const cjob = await pollJob(
          await whatifService.causalRun({ skuId: activeSku, treatments: [adjustments[0]!.feature] }),
        );
        if (cancelled.current) return;
        const cres = cjob.result as CausalRunResult | null;
        const ate = cres?.estimates?.[0]?.["Causal Estimate"];
        if (ate != null && Number.isFinite(ate)) causalAte = ate;
      }
      const job = await pollJob(
        await whatifService.run({
          skuId: activeSku, adjustments, causalAte,
          start: start || undefined, end: end || undefined,
        }),
      );
      if (cancelled.current) return;
      if (job.status === "failed") {
        setError(job.error ?? "Scenario run failed.");
        setPhase("error");
        return;
      }
      const res = job.result as ScenarioRunResult | null;
      if (res) {
        setResult(res);
        setFeatures(res.availableFeatures ?? []);
      }
      setPhase("idle");
    } catch (err) {
      if (cancelled.current) return;
      setError((err as { message?: string })?.message ?? "Scenario run failed.");
      setPhase("error");
    }
  }, [activeSku, adjustments, applyCausal, start, end, pollJob]);

  // Task 5 — auto-display all available features for the selected item (no manual
  // "add"). Fetch the item's adjustable drivers up front; each is a toggle row.
  const featuresQuery = useAsync(
    () => (activeSku ? whatifService.causalFeatures(activeSku) : Promise.resolve(null)),
    [activeSku],
  );
  const availableFeatures = useMemo(() => {
    // `exogAccountedFor` is absent when the backend can't do causal analysis
    // (e.g. DoWhy not installed) — guard against undefined before reading length.
    const fromApi = featuresQuery.data?.exogAccountedFor ?? [];
    return fromApi.length ? fromApi : features; // fallback to run-derived features
  }, [featuresQuery.data, features]);

  const adjByFeature = useMemo(
    () => new Map(adjustments.map((a) => [a.feature, a])),
    [adjustments],
  );

  // Relationship-graph variables (Task 4): the enabled adjustments are the
  // treatments; the remaining drivers are shown as confounders → demand. Before
  // any feature is enabled, show ALL drivers as the relationship map.
  const enabledFeatures = useMemo(() => adjustments.map((a) => a.feature), [adjustments]);
  const graphTreatments = enabledFeatures.length ? enabledFeatures : availableFeatures;
  const graphConfounders = enabledFeatures.length
    ? availableFeatures.filter((f) => !enabledFeatures.includes(f))
    : [];
  const DEFAULT_ADJ = { type: "Percentage Change" as WhatIfChangeType, value: 10 };
  const toggleFeature = (f: string) =>
    setAdjustments(
      adjByFeature.has(f)
        ? adjustments.filter((a) => a.feature !== f)
        : [...adjustments, { feature: f, ...DEFAULT_ADJ }],
    );
  const patchFeature = (f: string, patch: Partial<ScenarioAdjustment>) =>
    setAdjustments(adjustments.map((a) => (a.feature === f ? { ...a, ...patch } : a)));
  const resetFeature = (f: string) => patchFeature(f, DEFAULT_ADJ);

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
      setAdjustments(d.adjustments ?? []);
      setResult(d.result);
      setFeatures(d.result.availableFeatures ?? []);
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
      {/* Phase X.ZA — shared WorkflowHero (navy hero-gradient), visually identical
          to Step 3 · Profile & Route and Step 4 · Forecast. Only title/subtitle
          differ. variant="network" matches the Profile hero motif. */}
      <WorkflowHero
        step="Step 7 · Scenarios"
        title="What-If & Causal Sensitivity"
        subtitle="Simulate price / promo / festival impact — with causal effect estimation via DoWhy"
        icon={SlidersHorizontal}
        variant="network"
      />

      {/* "How to use this tab" (Streamlit expander 17178-17189). */}
      <details className="rounded-md border border-border/60 bg-secondary/20 p-3">
        <summary className="cursor-pointer text-sm font-medium text-foreground">ℹ️ How to use this tab</summary>
        <div className="mt-2 space-y-1 text-sm text-muted-foreground">
          <p>
            <strong>Causal Effect Estimation</strong> measures how much a lever (price, promo, discount)
            actually moves demand for the selected {levelLabel.toLowerCase()}, adjusting for your other drivers.
          </p>
          <p>
            <strong>What-If Feature Simulation</strong> applies a lever change over a date window and
            re-forecasts against the baseline — or applies the causal estimate directly.
          </p>
          <p className="text-xs">
            Best flow: estimate the causal effect first, then apply it in What-If to see the impact on the forecast.
          </p>
        </div>
      </details>

      {/* Scenario type — Streamlit radio (render_unified_scenarios_tab 17191-17197). */}
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Scenario type</p>
        <div className="flex flex-wrap gap-2">
          {([["causal", "Causal Effect Estimation (DoWhy)"], ["whatif", "What-If Feature Simulation"]] as const).map(
            ([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setMode(id)}
                className={
                  "rounded-md border px-3 py-1.5 text-sm transition-colors " +
                  (mode === id
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-secondary/50")
                }
              >
                {label}
              </button>
            ),
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
      {/* Build scenario */}
      <Card id="build" className="scroll-mt-24">
        <CardHeader>
          <CardTitle className="text-base">Build a what-if scenario</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Phase Y.11 — Forecast Horizon input removed (Streamlit parity): the
              scenario reuses the existing forecast horizon automatically. */}
          <Field label={levelLabel}>
            <Select
              value={activeSku}
              onChange={setSku}
              options={skus.map((s) => ({ value: s, label: s }))}
              ariaLabel={levelLabel}
            />
          </Field>

          {/* Task 5 — all available features for this item, each a toggle row
              (ON/OFF · editable value · reset). Only enabled rows are applied. */}
          <div className="space-y-2">
            <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
              Features
            </p>
            {featuresQuery.isLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : availableFeatures.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No adjustable features detected for this {levelLabel.toLowerCase()}.
              </p>
            ) : (
              availableFeatures.map((f) => {
                const adj = adjByFeature.get(f);
                const on = !!adj;
                return (
                  <div key={f} className="grid grid-cols-1 items-center gap-2 rounded-md border border-border/60 p-2 sm:grid-cols-[1.4fr_1.4fr_1fr_auto]">
                    <label className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <input type="checkbox" checked={on} onChange={() => toggleFeature(f)} aria-label={`Enable ${f}`} />
                      {f}
                    </label>
                    {on ? (
                      <>
                        <Select
                          value={adj!.type}
                          onChange={(t) => patchFeature(f, { type: t as WhatIfChangeType })}
                          options={CHANGE_TYPES.map((t) => ({ value: t, label: t }))}
                          ariaLabel={`${f} change type`}
                        />
                        <NumericInput
                          value={adj!.value}
                          onChange={(value) => patchFeature(f, { value })}
                          allowFloat
                          ariaLabel={`${f} value`}
                          className="tabular-nums"
                        />
                        <Button variant="ghost" size="sm" onClick={() => resetFeature(f)} aria-label={`Reset ${f}`}>
                          Reset
                        </Button>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground sm:col-span-3">Off — original value retained</span>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Run simulation window — Streamlit "#### 3. Run simulation" start/end. */}
          <div className="space-y-2">
            <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
              Apply over (optional date window)
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Start">
                <Input type="date" value={start} onChange={(e) => setWindow({ start: e.target.value })} aria-label="Start date" />
              </Field>
              <Field label="End">
                <Input type="date" value={end} onChange={(e) => setWindow({ end: e.target.value })} aria-label="End date" />
              </Field>
            </div>
          </div>

          {adjustments.length === 1 ? (
            <label className="flex items-center gap-2 text-xs text-foreground">
              <input
                type="checkbox"
                checked={applyCausal}
                onChange={(e) => setApplyCausal(e.target.checked)}
              />
              Apply causal estimate from DoWhy (model-agnostic) instead of re-forecasting
            </label>
          ) : null}

          <div className="flex items-center gap-3 border-t border-border/60 pt-4">
            <Button onClick={() => void run()} disabled={running || !activeSku} className="sm:w-56">
              {running ? (
                <><Loader2 className="size-4 animate-spin" /> {`Running… ${progress}%`}</>
              ) : (
                <><Play className="size-4" /> Run scenario</>
              )}
            </Button>
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

      {/* Task 4 — model / causal relationship graph, shown BEFORE Run Scenario so
          the planner understands how the selected drivers relate to demand. Derived
          from the selected SKU; read-only structure (no DoWhy estimation needed). */}
      {activeSku ? (
        <CausalGraph
          sku={activeSku}
          treatments={graphTreatments}
          confounders={graphConfounders}
          instruments={[]}
          effectModifiers={[]}
        />
      ) : null}

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

          {/* Task 6 — one-line, planner-friendly impact explanation. */}
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

          {/* Task 5 — scenario waterfall: Baseline → per-driver contribution →
              Scenario, derived from the existing forecast (no re-run). */}
          {result.waterfall && result.waterfall.length > 2 ? (
            <Card>
              <CardContent className="space-y-2 pt-6">
                <h3 className="text-sm font-medium text-foreground">Scenario breakdown</h3>
                <div className="divide-y divide-border/60">
                  {result.waterfall.map((step, i) => {
                    const isEdge = step.type !== "delta";
                    const v = Math.round(step.value);
                    const display =
                      isEdge
                        ? formatNumber(v)
                        : `${v > 0 ? "+" : ""}${formatNumber(v)}`;
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
