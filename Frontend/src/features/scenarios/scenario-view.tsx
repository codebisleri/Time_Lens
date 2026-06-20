"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EChartsOption } from "echarts";
import { Loader2, Play, Plus, Save, SlidersHorizontal, Trash2, X } from "lucide-react";
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
import { forecastService, skuService, whatifService } from "@/lib/api/services";
import { formatDate, formatNumber } from "@/lib/utils/format";
import { routes } from "@/lib/constants/routes";
import { WorkflowHero } from "@/features/workflow/workflow-hero";
import { WorkflowLock } from "@/features/workflow/workflow-lock";
import { useWorkflowStatus } from "@/features/workflow/use-workflow-status";
import { Field, NumberInput, Select } from "@/features/data/controls";
import type { ForecastJob } from "@/types/forecast";
import type {
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

/**
 * Scenario Planning (Step 7 · What-If) — faithful to Streamlit's render_whatif_tab:
 * choose a SKU, add exog adjustments (% / constant / set-to) over the horizon, run
 * a re-forecast, and compare scenario vs baseline. Scenarios persist per user/dataset.
 */
export function ScenarioPlanningView() {
  const workflow = useWorkflowStatus();
  const skuQuery = useAsync(() => skuService.list({ page: 1, pageSize: 500 }), []);
  const saved = useAsync(() => whatifService.list(), []);

  const skus = useMemo(
    () => (skuQuery.data?.items ?? []).map((s) => s.code),
    [skuQuery.data],
  );
  const [sku, setSku] = useState("");
  const [periods, setPeriods] = useState(12);
  const [adjustments, setAdjustments] = useState<ScenarioAdjustment[]>([]);
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
  useEffect(() => {
    if (!sku && skus.length) setSku(skus[0]!);
  }, [skus, sku]);

  const activeSku = sku || skus[0] || "";

  const run = useCallback(async () => {
    if (!activeSku) return;
    setPhase("running");
    setProgress(0);
    setError(null);
    try {
      let job: ForecastJob = await whatifService.run({
        skuId: activeSku,
        periods,
        adjustments,
      });
      setJobMessage(job.message ?? "");
      let waited = 0;
      while (job.status !== "completed" && job.status !== "failed") {
        await wait(POLL_MS);
        if (cancelled.current) return;
        waited += POLL_MS;
        if (waited > MAX_WAIT_MS) break;
        try { job = await forecastService.getJob(job.id); } catch { /* transient */ }
        setProgress(job.progress ?? 0);
        setJobMessage(job.message ?? "");
      }
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
  }, [activeSku, periods, adjustments]);

  const addAdjustment = () =>
    setAdjustments((a) => [
      ...a,
      { feature: features[0] ?? "", type: "Percentage Change", value: 10 },
    ]);
  const patchAdjustment = (i: number, patch: Partial<ScenarioAdjustment>) =>
    setAdjustments((a) => a.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const removeAdjustment = (i: number) =>
    setAdjustments((a) => a.filter((_, j) => j !== i));

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
      <WorkflowHero
        step="Planning · Scenarios"
        title="What-If Demand Simulation"
        subtitle="Model price, promotion, and supply assumptions — then re-forecast against the baseline plan."
        icon={SlidersHorizontal}
        variant="network"
      />
      {/* Build scenario */}
      <Card id="build" className="scroll-mt-24">
        <CardHeader>
          <CardTitle className="text-base">Build a what-if scenario</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="SKU">
              <Select
                value={activeSku}
                onChange={setSku}
                options={skus.map((s) => ({ value: s, label: s }))}
                ariaLabel="SKU"
              />
            </Field>
            <Field label="Forecast Horizon">
              <NumberInput
                min={1}
                max={36}
                value={periods}
                onChange={(v) => setPeriods(v)}
                ariaLabel="Forecast horizon"
              />
            </Field>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
                Assumptions
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={addAdjustment}
                disabled={features.length === 0}
              >
                <Plus className="size-4" /> Add adjustment
              </Button>
            </div>
            {features.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Run once to load this SKU’s adjustable features, then add assumptions.
              </p>
            ) : null}
            {adjustments.map((a, i) => (
              <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[2fr_1.5fr_1fr_auto]">
                <Select
                  value={a.feature}
                  onChange={(feature) => patchAdjustment(i, { feature })}
                  options={features.map((f) => ({ value: f, label: f }))}
                  ariaLabel="Feature"
                />
                <Select
                  value={a.type}
                  onChange={(t) => patchAdjustment(i, { type: t as WhatIfChangeType })}
                  options={CHANGE_TYPES.map((t) => ({ value: t, label: t }))}
                  ariaLabel="Change type"
                />
                <Input
                  type="number"
                  value={a.value}
                  onChange={(e) => patchAdjustment(i, { value: Number(e.target.value) || 0 })}
                  aria-label="Value"
                  className="tabular-nums"
                />
                <Button variant="ghost" size="icon" onClick={() => removeAdjustment(i)} aria-label="Remove">
                  <X className="size-4" />
                </Button>
              </div>
            ))}
          </div>

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

          <Card>
            <CardContent className="space-y-3 pt-6">
              <h3 className="text-sm font-medium text-foreground">Baseline vs Scenario</h3>
              <ScenarioChart result={result} />
            </CardContent>
          </Card>

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
                    <th className="px-3 py-2 font-medium">SKU</th>
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
    </PageShell>
  );
}
