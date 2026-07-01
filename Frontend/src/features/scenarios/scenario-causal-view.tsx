"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EChartsOption } from "echarts";
import { Loader2, Play, Trophy, Download, GitBranch, ChevronDown, Check, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/feedback/empty-state";
import { EChartBase } from "@/components/charts/echart-base";
import { useThemeMode } from "@/lib/theme/use-theme-mode";
import { chartColors } from "@/lib/charts/colors";
import { useAsync } from "@/lib/hooks";
import { forecastService, whatifService } from "@/lib/api/services";
import { formatNumber } from "@/lib/utils/format";
import { downloadFile } from "@/lib/utils/download";
import { useScenarioPlanningStore } from "@/lib/stores/scenario-planning-store";
import type { ForecastJob } from "@/types/forecast";
import type { CausalRunResult, DriversResult } from "@/types/whatif";
import { CausalGraph } from "./causal-graph";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const POLL_MS = 2500;
const MAX_WAIT_MS = 12 * 60 * 1000;

const REFUTERS: { id: string; label: string }[] = [
  { id: "random_common_cause", label: "Add random common cause" },
  { id: "placebo_treatment_refuter", label: "Placebo treatment" },
  { id: "data_subset_refuter", label: "Random subset (80%)" },
  { id: "add_unobserved_common_cause", label: "Unobserved confounder" },
];

// Estimator catalog (parity with scenario_engine.causal_estimator_catalog). The
// first selected method is the headline number.
const METHODS: { id: string; label: string }[] = [
  { id: "backdoor.linear_regression", label: "Linear regression" },
  { id: "backdoor.generalized_linear_model", label: "Generalized linear model (GLM)" },
  { id: "backdoor.propensity_score_matching", label: "Propensity score matching (binary)" },
  { id: "backdoor.propensity_score_stratification", label: "Propensity score stratification (binary)" },
  { id: "backdoor.propensity_score_weighting", label: "Propensity score weighting / IPW (binary)" },
  { id: "backdoor.distance_matching", label: "Distance matching (binary)" },
];

function fmt(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? "—" : formatNumber(v, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

/**
 * Searchable multi-select dropdown (Phase Y.4 · Task 3). Replaces the long chip
 * lists in Scenario → Advanced Settings (Confounders / Instruments / Effect
 * Modifiers) so dozens of feature columns no longer force endless scrolling.
 * Searchable, keyboard-navigable (↑/↓/Enter/Esc), with a scrollable option list
 * and the current selections shown as removable chips below the trigger. The
 * selection is the SAME `string[]` the chips used, so persisted Zustand state and
 * the causal run payload are unchanged.
 */
function SearchableMultiSelect({
  label,
  options,
  value,
  onChange,
  exclude = [],
  placeholder = "Select…",
}: {
  label: string;
  options: string[];
  value: string[];
  onChange: (v: string[]) => void;
  exclude?: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const pool = options.filter((o) => !exclude.includes(o));
  const filtered = pool.filter((o) =>
    o.toLowerCase().includes(query.trim().toLowerCase()),
  );

  // Close on outside click / Escape so the dropdown never traps focus.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query, open]);

  const toggle = (o: string) =>
    onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = filtered[activeIdx];
      if (o) toggle(o);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="space-y-1.5" ref={containerRef}>
      <p className="text-xs font-medium text-foreground">{label}</p>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={pool.length === 0}
          className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-xs text-muted-foreground transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className="truncate">
            {pool.length === 0
              ? "No columns available"
              : value.length
                ? `${value.length} selected`
                : placeholder}
          </span>
          <ChevronDown className="size-4 shrink-0 opacity-60" />
        </button>
        {open && pool.length > 0 ? (
          <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover shadow-md">
            <div className="border-b border-border/60 p-2">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Search…"
                aria-label={`Search ${label}`}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <div role="listbox" aria-multiselectable className="max-h-56 overflow-auto p-1">
              {filtered.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">No matches.</p>
              ) : (
                filtered.map((o, i) => {
                  const selected = value.includes(o);
                  return (
                    <button
                      key={o}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onMouseEnter={() => setActiveIdx(i)}
                      onClick={() => toggle(o)}
                      className={
                        "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors " +
                        (i === activeIdx ? "bg-secondary/70 " : "") +
                        (selected ? "font-medium text-primary" : "text-foreground")
                      }
                    >
                      <span className="truncate">{o}</span>
                      {selected ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        ) : null}
      </div>
      {/* Selected values as removable chips, below the dropdown. */}
      {value.length ? (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {value.map((o) => (
            <span
              key={o}
              className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs text-primary"
            >
              {o}
              <button
                type="button"
                onClick={() => toggle(o)}
                aria-label={`Remove ${o}`}
                className="rounded-full p-0.5 hover:bg-primary/20"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function reliabilityClasses(level: string): string {
  if (level === "success") return "border-success/30 bg-success/10 text-success";
  if (level === "warning") return "border-warning/40 bg-warning/10 text-foreground";
  return "border-border bg-secondary/40 text-foreground";
}

/** Drivers ranking bar chart (parity with px.bar horizontal "which levers move demand most"). */
function DriversChart({ data }: { data: DriversResult }) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const c = chartColors();
    const rows = [...data.ranked].slice(0, 15).reverse(); // total ascending
    return {
      animationDuration: 500,
      grid: { left: 4, right: 40, top: 8, bottom: 4, containLabel: true },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      xAxis: { type: "value", name: "Impact on demand" },
      yAxis: { type: "category", data: rows.map((r) => r.Lever), axisTick: { show: false } },
      series: [
        {
          type: "bar",
          barWidth: "60%",
          data: rows.map((r) => ({
            value: r["Impact on demand"],
            itemStyle: { color: (r["Impact on demand"] ?? 0) >= 0 ? c.positive : c.negative },
          })),
          label: { show: true, position: "right", formatter: (p) => fmt(p.value as number) },
          itemStyle: { borderRadius: [0, 4, 4, 0] },
        },
      ],
    };
  }, [data, resolvedMode]);
  return <EChartBase option={option} height={Math.max(220, Math.min(15, data.ranked.length) * 26 + 40)} />;
}

/** Causal effect per treatment (per +1 unit) — clear bar chart with units,
 *  legend-free, green positive / red negative (Phase X.ZZ.2 · Task 4). */
function CausalEffectsChart({ estimates }: { estimates: CausalRunResult["estimates"] }) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const c = chartColors();
    const rows = estimates
      .filter((e) => e["Causal Effect (per +1 unit)"] != null)
      .map((e) => ({ name: e.Treatment, value: e["Causal Effect (per +1 unit)"] as number }))
      .sort((a, b) => Math.abs(a.value) - Math.abs(b.value)); // ascending → biggest on top
    return {
      animationDuration: 500,
      grid: { left: 4, right: 56, top: 8, bottom: 4, containLabel: true },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        valueFormatter: (v) => `${fmt(v as number, 2)} units / +1 unit`,
      },
      xAxis: { type: "value", name: "Effect on demand (units per +1 unit of lever)" },
      yAxis: { type: "category", data: rows.map((r) => r.name), axisTick: { show: false } },
      series: [
        {
          type: "bar",
          barWidth: "60%",
          data: rows.map((r) => ({ value: r.value, itemStyle: { color: r.value >= 0 ? c.positive : c.negative } })),
          label: { show: true, position: "right", formatter: (p) => fmt(p.value as number, 2) },
          itemStyle: { borderRadius: [0, 4, 4, 0] },
        },
      ],
    };
  }, [estimates, resolvedMode]);
  return <EChartBase option={option} height={Math.max(180, Math.min(estimates.length, 12) * 30 + 40)} />;
}

/** One-line plain-language summary of the dominant causal driver (Task 4). */
function primaryContributorLine(estimates: CausalRunResult["estimates"]): string | null {
  const valid = estimates.filter((e) => e["Causal Effect (per +1 unit)"] != null);
  if (!valid.length) return null;
  const top = valid.reduce((a, b) =>
    Math.abs(b["Causal Effect (per +1 unit)"]!) > Math.abs(a["Causal Effect (per +1 unit)"]!) ? b : a);
  const v = top["Causal Effect (per +1 unit)"]!;
  const dir = v >= 0 ? "increase" : "decrease";
  const word = v >= 0 ? "uplift" : "reduction";
  return `${top.Treatment} ${word} is the primary contributor to the projected ${dir} in demand.`;
}

/**
 * Causal Effect Estimation (DoWhy) — parity with render_causal_tab. Two tasks:
 *   • Impact ("How much does a lever move demand?") — estimate effects + elasticity
 *     + reliability cross-checks + cross-method comparison + assumed causal DAG.
 *   • Drivers ("Which levers matter most?") — rank every lever by |impact|.
 * Read-only: never alters forecasts.
 */
export function ScenarioCausalView({ sku }: { sku: string }) {
  const {
    treatments, confounders, instruments, effectModifiers, methods, refuters,
    computeCi, causalTask, setCausal, setCausalGraph,
  } = useScenarioPlanningStore();

  const featuresQuery = useAsync(
    () => (sku ? whatifService.causalFeatures(sku) : Promise.resolve(null)),
    [sku],
  );
  const columns = featuresQuery.data?.columns ?? [];
  const dowhyAvailable = featuresQuery.data?.available !== false;
  const exogAccounted = featuresQuery.data?.exogAccountedFor ?? [];

  const [phase, setPhase] = useState<"idle" | "running" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState<CausalRunResult | null>(null);
  const [drivers, setDrivers] = useState<DriversResult | null>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => { cancelled.current = true; };
  }, []);

  const poll = useCallback(async (start: ForecastJob): Promise<ForecastJob> => {
    let job = start;
    let waited = 0;
    while (job.status !== "completed" && job.status !== "failed") {
      await wait(POLL_MS);
      if (cancelled.current) return job;
      waited += POLL_MS;
      if (waited > MAX_WAIT_MS) break;
      try { job = await forecastService.getJob(job.id); } catch { /* transient */ }
      setProgress(job.progress ?? 0);
    }
    return job;
  }, []);

  const runImpact = useCallback(async () => {
    if (!sku || treatments.length === 0) return;
    setPhase("running"); setProgress(0); setError(null);
    try {
      const job = await poll(await whatifService.causalRun({
        skuId: sku, treatments, confounders, instruments, effectModifiers,
        methods, refuters, computeCi,
      }));
      if (cancelled.current) return;
      // Phase Y.17 · Task 9 — friendly, jargon-free fallback (no stack traces).
      if (job.status === "failed") {
        if (job.error) console.error("CAUSAL RUN ERROR:", job.error);
        setError("Causal estimation unavailable for the selected variables.");
        setPhase("error");
        return;
      }
      const res = (job.result as CausalRunResult) ?? null;
      setImpact(res);
      // TASK 1 — the DoWhy causal graph becomes the graph the What-If Feature
      // Simulation consumes. Cache it in scenario state, keyed to this SKU, so the
      // What-If section unlocks and reuses this exact structure (no second graph).
      if (res && res.dotGraph && res.variables) {
        setCausalGraph({
          sku,
          dotGraph: res.dotGraph,
          variables: res.variables,
          generatedAt: res.generatedAt,
        });
      }
      setPhase("idle");
    } catch (e) {
      if (!cancelled.current) {
        console.error("CAUSAL RUN ERROR:", e);
        setError("Causal estimation unavailable for the selected variables.");
        setPhase("error");
      }
    }
  }, [sku, treatments, confounders, instruments, effectModifiers, methods, refuters, computeCi, poll, setCausalGraph]);

  const runDrivers = useCallback(async () => {
    if (!sku) return;
    setPhase("running"); setProgress(0); setError(null);
    try {
      const job = await poll(await whatifService.causalDrivers({ skuId: sku, useAllConfounders: true }));
      if (cancelled.current) return;
      if (job.status === "failed") { setError(job.error ?? "Driver ranking failed."); setPhase("error"); return; }
      setDrivers((job.result as DriversResult) ?? null);
      setPhase("idle");
    } catch (e) {
      if (!cancelled.current) { setError((e as { message?: string })?.message ?? "Driver ranking failed."); setPhase("error"); }
    }
  }, [sku, poll]);

  const exportEstimatesCsv = useCallback(() => {
    if (!impact) return;
    const head = ["Lever", "Causal effect per +1 unit", "Elasticity % per +1%", "Robustness", "Interpretation"];
    const rows = impact.estimates.map((e) => [
      e.Treatment,
      e["Causal Effect (per +1 unit)"] ?? "",
      e["Elasticity (% per +1%)"] ?? "",
      e.Robustness,
      `"${(e.Interpretation || "").replace(/"/g, '""').replace(/\*/g, "")}"`,
    ].join(","));
    downloadFile(`causal-estimates-${sku}.csv`, [head.join(","), ...rows].join("\r\n"));
  }, [impact, sku]);

  const running = phase === "running";

  // Phase Y.11 — do NOT blank the whole causal tab when DoWhy is missing. The
  // candidate variables + the structural causal graph + the plain-language
  // explanation need NO DoWhy, so they always render; only the numeric effect
  // ESTIMATION needs DoWhy (the run buttons gate on `dowhyAvailable` and a banner
  // explains it). `featuresQuery.data` present + available === false ⇒ no DoWhy.
  const estimationUnavailable = featuresQuery.data != null && !dowhyAvailable;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Causal Effect Estimation (DoWhy)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {estimationUnavailable ? (
            <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-foreground">
              <span className="font-medium">Causal estimation unavailable for this scenario.</span>{" "}
              {featuresQuery.data?.message ||
                "Install dowhy + graphviz on the server to compute effect values."}{" "}
              You can still build and view the causal structure below.
            </div>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Most charts show what <em>moves together</em> with demand. Causal AI answers: <strong>if I
            change this lever, how much will demand actually move?</strong> — adjusting for your other drivers.
          </p>
          {exogAccounted.length ? (
            <p className="text-xs text-success">
              ✅ Accounting for {exogAccounted.length} configured driver(s): {exogAccounted.join(", ")}
            </p>
          ) : null}

          {/* Task selector (parity with the causal task selectbox) */}
          <div className="flex flex-wrap gap-2">
            {([["impact", "📈 How much does a lever move demand?"], ["drivers", "🏆 Which levers matter most?"]] as const).map(
              ([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setCausal({ causalTask: id })}
                  className={
                    "rounded-md border px-3 py-1.5 text-sm transition-colors " +
                    (causalTask === id
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-secondary/50")
                  }
                >
                  {label}
                </button>
              ),
            )}
          </div>

          {featuresQuery.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : causalTask === "impact" ? (
            <div className="space-y-3">
              {/* TASK 8 — searchable multi-select (scales to hundreds of columns:
                  search-as-you-type, scrollable list, keyboard nav). The selection
                  is the SAME `treatments: string[]` → backend payload unchanged. */}
              <SearchableMultiSelect
                label="Lever(s) to test (treatments)"
                placeholder="Search levers to test…"
                options={columns}
                value={treatments}
                onChange={(v) => setCausal({ treatments: v })}
              />
              <details className="rounded-md border border-border/60 p-3">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                  ⚙️ Advanced settings (defaults work for most cases)
                </summary>
                <div className="mt-3 space-y-3">
                  <SearchableMultiSelect
                    label="Other factors to adjust for (confounders)"
                    placeholder="Select confounders…"
                    options={columns}
                    value={confounders}
                    onChange={(v) => setCausal({ confounders: v })}
                    exclude={treatments}
                  />
                  <SearchableMultiSelect
                    label="Instruments (a nudge that moves the lever but not demand directly)"
                    placeholder="Select instruments…"
                    options={columns}
                    value={instruments}
                    onChange={(v) => setCausal({ instruments: v })}
                    exclude={[...treatments, ...confounders]}
                  />
                  <SearchableMultiSelect
                    label="Segments the effect may differ across (effect modifiers)"
                    placeholder="Select effect modifiers…"
                    options={columns}
                    value={effectModifiers}
                    onChange={(v) => setCausal({ effectModifiers: v })}
                    exclude={treatments}
                  />
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-foreground">Calculation method(s) — the first is the headline number</p>
                    <div className="flex flex-wrap gap-1.5">
                      {METHODS.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() =>
                            setCausal({
                              methods: methods.includes(m.id)
                                ? methods.filter((x) => x !== m.id)
                                : [...methods, m.id],
                            })
                          }
                          className={
                            "rounded-full border px-2.5 py-1 text-xs transition-colors " +
                            (methods.includes(m.id)
                              ? "border-primary bg-primary/15 text-primary"
                              : "border-border text-muted-foreground hover:bg-secondary/50")
                          }
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-foreground">Reliability cross-checks</p>
                    <div className="flex flex-wrap gap-1.5">
                      {REFUTERS.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() =>
                            setCausal({
                              refuters: refuters.includes(r.id)
                                ? refuters.filter((x) => x !== r.id)
                                : [...refuters, r.id],
                            })
                          }
                          className={
                            "rounded-full border px-2.5 py-1 text-xs transition-colors " +
                            (refuters.includes(r.id)
                              ? "border-primary bg-primary/15 text-primary"
                              : "border-border text-muted-foreground hover:bg-secondary/50")
                          }
                        >
                          {r.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-foreground">
                    <input
                      type="checkbox"
                      checked={computeCi}
                      onChange={(e) => setCausal({ computeCi: e.target.checked })}
                    />
                    Show the plausible range (confidence interval)
                  </label>
                </div>
              </details>
              <Button
                onClick={() => void runImpact()}
                disabled={running || treatments.length === 0 || !dowhyAvailable}
                title={!dowhyAvailable ? "Causal estimation unavailable (DoWhy not installed on the server)." : undefined}
              >
                {running ? <><Loader2 className="size-4 animate-spin" /> {`Measuring… ${progress}%`}</> : <><Play className="size-4" /> Measure impact on demand</>}
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Ranks <strong>every</strong> factor by how much it actually moves demand, so you know where to focus first.
              </p>
              <Button
                onClick={() => void runDrivers()}
                disabled={running || !dowhyAvailable}
                title={!dowhyAvailable ? "Causal estimation unavailable (DoWhy not installed on the server)." : undefined}
              >
                {running ? <><Loader2 className="size-4 animate-spin" /> {`Ranking… ${progress}%`}</> : <><Trophy className="size-4" /> Rank the levers</>}
              </Button>
            </div>
          )}
          {phase === "error" ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
          ) : null}
        </CardContent>
      </Card>

      {/* Phase Y.6 — live causal structure (DAG) for the current selection. It
          appears as soon as a treatment is chosen, independent of running the
          estimation; read-only structure only (no DoWhy math). */}
      {causalTask === "impact" ? (
        <CausalGraph
          sku={sku}
          treatments={treatments}
          confounders={confounders}
          instruments={instruments}
          effectModifiers={effectModifiers}
        />
      ) : null}

      {/* Impact results — "What We Found" (Task 6 sub-nav anchor target). */}
      {causalTask === "impact" && impact ? (
        <>
          <div id="results" className="flex scroll-mt-24 items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">What we found</h3>
            <Button variant="outline" size="sm" onClick={exportEstimatesCsv}>
              <Download className="size-3.5" /> CSV
            </Button>
          </div>
          {/* One-line plain-language summary of the dominant driver (Task 4). */}
          {primaryContributorLine(impact.estimates) ? (
            <div className="rounded-md border border-primary/25 bg-primary/5 px-4 py-2.5 text-sm font-medium text-foreground">
              {primaryContributorLine(impact.estimates)}
            </div>
          ) : null}
          {/* Causal effect bar chart — clear axis/units/tooltip (Task 4). */}
          {impact.estimates.some((e) => e["Causal Effect (per +1 unit)"] != null) ? (
            <Card>
              <CardContent className="space-y-2 pt-6">
                <p className="text-sm font-medium text-foreground">Causal effect on demand (per +1 unit of each lever)</p>
                <CausalEffectsChart estimates={impact.estimates} />
              </CardContent>
            </Card>
          ) : null}
          {impact.estimates.map((e) => {
            const theta = e["Causal Effect (per +1 unit)"];
            const elas = e["Elasticity (% per +1%)"];
            return (
              <Card key={e.Treatment}>
                <CardContent className="space-y-3 pt-6">
                  <p className="text-sm font-semibold text-foreground">{e.Treatment}</p>
                  {theta == null ? (
                    <p className="text-sm text-muted-foreground">{e.Interpretation}</p>
                  ) : (
                    <>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="rounded-md border border-border bg-secondary/30 p-3">
                          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Impact of +1 unit</p>
                          <p className="text-2xl font-semibold tabular-nums text-foreground">{fmt(theta)} units</p>
                        </div>
                        {elas != null ? (
                          <div className="rounded-md border border-border bg-secondary/30 p-3">
                            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Sensitivity</p>
                            <p className="text-2xl font-semibold tabular-nums text-foreground">{fmt(elas)}% per 1%</p>
                          </div>
                        ) : null}
                      </div>
                      <p className="text-sm text-foreground">{e.Interpretation.replace(/\*\*/g, "")}</p>
                      <div className={"rounded-md border px-3 py-2 text-sm " + reliabilityClasses(e.reliabilityLevel)}>
                        <strong>{e.reliabilityHead}</strong> — {e.reliabilityExpl}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })}

          {/* Technical detail */}
          <Card>
            <CardContent className="space-y-4 pt-6">
              <details>
                <summary className="cursor-pointer text-sm font-medium text-foreground">🔬 Technical details (for analysts)</summary>
                <div className="mt-3 space-y-5">
                  {impact.methodComparison.length ? (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Cross-method comparison — same effect, several ways. Close agreement = trustworthy.</p>
                      <div className="overflow-auto rounded-md border border-border">
                        <table className="w-full text-sm">
                          <thead className="bg-secondary/40 text-xs uppercase tracking-wide text-muted-foreground">
                            <tr><th className="px-3 py-1.5 text-left">Lever</th><th className="px-3 py-1.5 text-left">Method</th><th className="px-3 py-1.5 text-right">Effect</th><th className="px-3 py-1.5 text-right">CI low</th><th className="px-3 py-1.5 text-right">CI high</th><th className="px-3 py-1.5 text-right">p-value</th></tr>
                          </thead>
                          <tbody>
                            {impact.methodComparison.map((m, i) => (
                              <tr key={i} className="border-t border-border/60">
                                <td className="px-3 py-1.5">{m.Treatment}</td>
                                <td className="px-3 py-1.5">{m.Method}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{fmt(m["Causal Effect"], 3)}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{fmt(m["CI low"], 3)}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{fmt(m["CI high"], 3)}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{fmt(m["p-value"], 3)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}
                  {impact.refutation.length ? (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">Reliability cross-checks — a robust effect barely moves (placebo should fall to ~0).</p>
                      <div className="overflow-auto rounded-md border border-border">
                        <table className="w-full text-sm">
                          <thead className="bg-secondary/40 text-xs uppercase tracking-wide text-muted-foreground">
                            <tr><th className="px-3 py-1.5 text-left">Lever</th><th className="px-3 py-1.5 text-left">Refuter</th><th className="px-3 py-1.5 text-right">Refuted effect</th><th className="px-3 py-1.5 text-left">Verdict</th><th className="px-3 py-1.5 text-right">p-value</th></tr>
                          </thead>
                          <tbody>
                            {impact.refutation.map((r, i) => (
                              <tr key={i} className="border-t border-border/60">
                                <td className="px-3 py-1.5">{r.Treatment}</td>
                                <td className="px-3 py-1.5">{r.Refuter}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{fmt(r["Refuted effect"], 3)}</td>
                                <td className="px-3 py-1.5"><Badge variant="outline">{r.Verdict}</Badge></td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{fmt(r["p-value"], 3)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}
                  {impact.dotGraph ? (
                    <div className="space-y-1">
                      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><GitBranch className="size-3.5" /> Assumed causal map (DOT)</p>
                      <pre className="max-h-48 overflow-auto rounded-md border border-border bg-secondary/30 p-3 text-[11px] text-muted-foreground">{impact.dotGraph}</pre>
                    </div>
                  ) : null}
                </div>
              </details>
            </CardContent>
          </Card>
        </>
      ) : null}

      {/* Drivers results */}
      {causalTask === "drivers" && drivers ? (
        drivers.ranked.length ? (
          <Card>
            <CardContent className="space-y-3 pt-6">
              <h3 className="text-sm font-medium text-foreground">Which levers move demand the most</h3>
              <DriversChart data={drivers} />
            </CardContent>
          </Card>
        ) : (
          <EmptyState title="No rankable levers" description="This forecast level has no varying numeric levers to rank." />
        )
      ) : null}
    </>
  );
}
