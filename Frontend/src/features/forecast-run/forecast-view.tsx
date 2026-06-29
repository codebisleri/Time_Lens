"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PageShell } from "@/components/layout/page-shell";
import { ErrorState } from "@/components/feedback/error-state";
import { EmptyState } from "@/components/feedback/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Gauge, TrendingUp } from "lucide-react";
import { useAsync } from "@/lib/hooks";
import { formatForecastLevel, pluralizeLevel } from "@/lib/utils/format";
import { routes } from "@/lib/constants/routes";
import { dataService, forecastService, segmentationService, workflowService } from "@/lib/api/services";
import { WorkflowHero, HeroStatusPill } from "@/features/workflow/workflow-hero";
import { WorkflowLock } from "@/features/workflow/workflow-lock";
import { useWorkflowStatus } from "@/features/workflow/use-workflow-status";
import type {
  ForecastAlgorithms,
  ForecastJob,
  ForecastRunMetrics,
  SingleSkuResult,
} from "@/types/forecast";
import type { SegmentationResult } from "@/types/segmentation";
import {
  ForecastRunConfig,
  SINGLE_SKU_MODELS_DEFAULT,
  type RunConfig,
} from "./forecast-run-config";
import { ForecastResultsPanel } from "./forecast-results-panel";
import { SingleSkuResultsPanel } from "./single-sku-results-panel";
import { TopDownDialog, type TopDownCandidate } from "./top-down-dialog";
import { TopDownBadge } from "./top-down-indicator";
import { useForecastStore } from "@/lib/stores";
import { Card, CardContent } from "@/components/ui/card";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Poll faster than the backend heartbeat cadence (~1.2s) so stage/progress
// updates surface promptly and the run never looks frozen.
const POLL_MS = 1500;
// Phase X.Q · Task 2 — synthetic key for the computed Segment dynamic-filter column.
const SEGMENT_KEY = "__segment__";

// Persist the active run so a page refresh can reconnect to the in-flight job
// (the worker keeps running server-side). No artificial time cap — long runs
// poll until they reach a terminal state.
const ACTIVE_JOB_KEY = "tl_active_forecast_job";
type ActiveJob = { id: string; mode: "portfolio" | "single_sku" };
function saveActiveJob(j: ActiveJob | null) {
  try {
    if (j) window.localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify(j));
    else window.localStorage.removeItem(ACTIVE_JOB_KEY);
  } catch {
    /* ignore storage errors */
  }
}
function loadActiveJob(): ActiveJob | null {
  try {
    const v = window.localStorage.getItem(ACTIVE_JOB_KEY);
    return v ? (JSON.parse(v) as ActiveJob) : null;
  } catch {
    return null;
  }
}

// Defaults: Global LightGBM + reconciliation ON; K-fold CV opt-in (off).
// Out-of-sample backtesting is ON by default — it drives the competition-based
// model selection (the parity validation showed OOS=off changes the chosen
// champion and forecast values). Forecast parity > speed.
const DEFAULT_CONFIG: RunConfig = {
  forecastMode: "portfolio",
  selectionMode: "pick", // Streamlit "What to forecast" defaults to Pick specific SKUs
  brands: [],
  segments: [],
  skuIds: [],
  samplePerStrategy: 3,
  limit: 12,
  periods: 12, // Streamlit sidebar "Periods to forecast" default
  compareAlgos: [],
  cvMode: false,
  reconcile: true,
  useGlobal: true,
  evaluateOos: true,
  singleSkuModels: SINGLE_SKU_MODELS_DEFAULT,
};

/**
 * Forecast — the unified Streamlit Forecast tab: configuration (what to forecast,
 * training options, algorithm competition) → run → results (KPIs, quality bands,
 * filters, all-models table, champion drill-down, exports). Gated on profiling.
 */
export function ForecastView() {
  const workflow = useWorkflowStatus();
  const algorithms = useAsync<ForecastAlgorithms>(() => forecastService.algorithms(), []);
  const seg = useAsync<SegmentationResult>(() => segmentationService.get(), []);
  const metrics = useAsync<ForecastRunMetrics>(() => forecastService.metrics(), []);
  // Forecast horizon's single source of truth = the saved Configuration &
  // Preparation horizon (Issue 6). Fetched read-only; no duplicate control.
  const dataset = useAsync(
    () => (seg.data?.datasetId ? dataService.getDataset(seg.data.datasetId) : Promise.resolve(null)),
    [seg.data?.datasetId],
  );
  const savedHorizon = dataset.data?.config?.horizon ?? 12;
  // Task 5 — forecast segmentation source, derived from the saved config using
  // the SAME priority the backend worker applies: GENERATED when the "use
  // generated" flag is on OR there is no uploaded segment column; UPLOADED
  // otherwise. (Mirrors run.segmentSource; no API change.)
  const segSource: "uploaded" | "generated" | null = dataset.data?.config
    ? dataset.data.config.useGeneratedSegmentation || !dataset.data.config.segmentCol
      ? "generated"
      : "uploaded"
    : null;
  // F.17 §6 — display term for the forecast level (drives "Inspect <level>",
  // "<level>s forecasted", table header, etc.).
  const levelLabel = useMemo(() => {
    const cfg = dataset.data?.config;
    if (!cfg) return "SKU";
    if (cfg.forecastLevelMode === "overall") return "Enterprise";
    if (cfg.forecastLevelMode === "custom")
      return formatForecastLevel(cfg.forecastLevelCols?.[0] ?? "Group");
    return formatForecastLevel(cfg.skuCol);
  }, [dataset.data]);
  const levelPlural = useMemo(() => pluralizeLevel(levelLabel), [levelLabel]);

  // Phase X.Q · Task 2 — per-forecast-level categorical attributes drive the
  // dynamic filters. Read-only; if the endpoint is unavailable (older backend)
  // we fall back to Segment-only filtering so nothing breaks.
  const levelAttrs = useAsync(
    () =>
      seg.data?.datasetId
        ? dataService.levelAttributes(seg.data.datasetId).catch(() => null)
        : Promise.resolve(null),
    [seg.data?.datasetId],
  );
  const attrsBySku = useMemo(() => {
    const m = new Map<string, Record<string, string>>();
    for (const e of levelAttrs.data?.entities ?? []) m.set(e.entity, e.attrs ?? {});
    return m;
  }, [levelAttrs.data]);
  const attrColumns = useMemo(
    () => [
      ...(levelAttrs.data?.columns ?? []),
      { key: SEGMENT_KEY, label: "Segment" },
    ],
    [levelAttrs.data],
  );

  const [config, setConfig] = useState<RunConfig>(DEFAULT_CONFIG);
  const [phase, setPhase] = useState<"idle" | "running" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [jobStatus, setJobStatus] = useState("");
  const [jobMessage, setJobMessage] = useState("");
  const [runError, setRunError] = useState<string | null>(null);
  const [singleSkuResult, setSingleSkuResult] = useState<SingleSkuResult | null>(null);
  // Phase Y.1 / X.J — Top-Down recommendation dialog (only when qualifying items exist).
  const [topDownOpen, setTopDownOpen] = useState(false);
  const [topDownQualifying, setTopDownQualifying] = useState<TopDownCandidate[]>([]);
  const setTopDownEnabled = useForecastStore((s) => s.setTopDownEnabled);
  const topDownEnabled = useForecastStore((s) => s.topDownEnabled);
  // Phase X.Q · Task 3 — the global benchmark algorithm set (persisted).
  const benchmarkAlgos = useForecastStore((s) => s.benchmarkAlgos);
  const setBenchmarkAlgos = useForecastStore((s) => s.setBenchmarkAlgos);
  // Phase X.X.2 · Task 2 — per-segment SECONDARY models (persisted) → sent as
  // extra candidates so they join the WMAPE competition on the next run.
  const segmentOverrides = useForecastStore((s) => s.segmentOverrides);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => { cancelled.current = true; };
  }, []);

  // Seed the global benchmark competition once: from the PERSISTED global set if
  // present, otherwise the backend `recommended` set (Phase X.Q · Task 3).
  useEffect(() => {
    if (!algorithms.data || config.compareAlgos.length > 0) return;
    const seed = benchmarkAlgos && benchmarkAlgos.length
      ? benchmarkAlgos
      : [...algorithms.data.recommended];
    setConfig((c) => ({ ...c, compareAlgos: seed }));
  }, [algorithms.data, config.compareAlgos.length, benchmarkAlgos]);

  // Persist any change to the global benchmark set so it survives refresh/restart.
  useEffect(() => {
    if (config.compareAlgos.length) setBenchmarkAlgos(config.compareAlgos);
  }, [config.compareAlgos, setBenchmarkAlgos]);

  // Streamlit's Pick mode defaults the SKU multiselect to the first 5 SKUs.
  // Seed once on initial load (no filters yet); leaves the brand/segment
  // auto-select behavior untouched thereafter.
  const seededSkus = useRef(false);

  const patch = useCallback((p: Partial<RunConfig>) => setConfig((c) => ({ ...c, ...p })), []);

  // Keep the run's periods in lockstep with the saved Configuration horizon
  // (Issue 6 — single source of truth). The backend also enforces this.
  useEffect(() => {
    const h = dataset.data?.config?.horizon;
    if (h && h > 0) setConfig((c) => (c.periods === h ? c : { ...c, periods: h }));
  }, [dataset.data?.config?.horizon]);

  const skuOptions = useMemo(
    () =>
      (seg.data?.skus ?? []).map((s) => ({
        sku: s.sku,
        brand: s.brand,
        segment: s.segment,
        // Merge dataset categorical attrs with the computed Segment so every
        // dynamic filter column resolves from one place.
        attrs: { ...(attrsBySku.get(s.sku) ?? {}), [SEGMENT_KEY]: s.segment },
      })),
    [seg.data, attrsBySku],
  );
  const brandOptions = useMemo(
    () => Array.from(new Set(skuOptions.map((s) => s.brand).filter(Boolean))) as string[],
    [skuOptions],
  );
  const segmentOptions = useMemo(
    () => Array.from(new Set(skuOptions.map((s) => s.segment).filter(Boolean))),
    [skuOptions],
  );

  useEffect(() => {
    if (
      !seededSkus.current &&
      config.forecastMode === "portfolio" &&
      config.selectionMode === "pick" &&
      config.skuIds.length === 0 &&
      config.brands.length === 0 &&
      config.segments.length === 0 &&
      skuOptions.length > 0
    ) {
      seededSkus.current = true;
      setConfig((c) => ({ ...c, skuIds: skuOptions.slice(0, 5).map((s) => s.sku) }));
    }
  }, [skuOptions, config.forecastMode, config.selectionMode, config.skuIds.length, config.brands.length, config.segments.length]);

  // Poll a job until a terminal state — NO time cap (long runs complete) and NO
  // false completion (only completed/failed exit). Returns the final job, or null
  // if the component unmounted mid-poll.
  const pollUntilDone = useCallback(async (initial: ForecastJob): Promise<ForecastJob | null> => {
    let job = initial;
    setJobStatus(job.status);
    setProgress(job.progress ?? 0);
    setJobMessage(job.message ?? "");
    while (job.status !== "completed" && job.status !== "failed") {
      await wait(POLL_MS);
      if (cancelled.current) return null;
      try {
        job = await forecastService.getJob(job.id);
      } catch {
        continue; // transient network error — keep monitoring, never false-exit
      }
      setJobStatus(job.status);
      setProgress(job.progress ?? 0);
      setJobMessage(job.message ?? "");
    }
    return job;
  }, []);

  // Settle a finished PORTFOLIO job (shared by run() + refresh-resume). Never
  // reports success for an empty/partial run.
  const finishPortfolio = useCallback(async (job: ForecastJob) => {
    saveActiveJob(null);
    if (job.status === "failed") {
      setRunError(job.error ?? "Forecast run failed.");
      setPhase("error");
      return;
    }
    await metrics.refetch().catch(() => {});
    const produced = job.skuCount ?? 0;
    const total = job.total ?? 0;
    if (produced === 0) {
      // Empty-success prevention: a completed run with zero forecasts is a failure.
      setRunError(
        "Run completed but produced 0 forecasts — every forecasting level failed. Check the data and configuration, then retry.",
      );
      setPhase("error");
      return;
    }
    setPhase("idle");
    if (total && produced < total) {
      toast.warning(
        `Forecast complete — ${produced} of ${total} forecast; ${total - produced} skipped (see logs).`,
      );
    } else {
      toast.success("Forecast run complete");
    }
    await workflowService.complete("forecast").catch(() => {});
    await workflow.refetch().catch(() => {});
  }, [metrics, workflow]);

  // Single-SKU Multi-Model Competition — dedicated single-series engine endpoint.
  const runSingleSku = useCallback(async () => {
    if (config.skuIds.length === 0) {
      setRunError(`Select a ${levelLabel.toLowerCase()} to run the competition.`);
      setPhase("error");
      return;
    }
    if (config.singleSkuModels.length === 0) {
      setRunError("Select at least one model to compete.");
      setPhase("error");
      return;
    }
    cancelled.current = false; // fresh run — clear any prior cancel
    setPhase("running");
    setProgress(0);
    setRunError(null);
    setSingleSkuResult(null);
    try {
      const job0 = await forecastService.runSingleSku({
        skuId: config.skuIds[0]!,
        periods: config.periods,
        models: config.singleSkuModels,
      });
      saveActiveJob({ id: job0.id, mode: "single_sku" });
      const job = await pollUntilDone(job0);
      if (!job) return; // unmounted
      saveActiveJob(null);
      if (job.status === "failed") {
        setRunError(job.error ?? "Single-SKU competition failed.");
        setPhase("error");
        return;
      }
      const res = await forecastService.singleSkuResult();
      if (cancelled.current) return;
      if (!res) {
        setRunError("Competition completed but returned no result.");
        setPhase("error");
        return;
      }
      setSingleSkuResult(res);
      toast.success("Single-SKU competition complete");
      setPhase("idle");
      await workflowService.complete("forecast").catch(() => {});
      await workflow.refetch().catch(() => {});
    } catch (err) {
      if (cancelled.current) return;
      saveActiveJob(null);
      setRunError((err as { message?: string })?.message ?? "Single-SKU competition failed.");
      setPhase("error");
    }
  }, [config, workflow, pollUntilDone]);

  const run = useCallback(async () => {
    if (config.forecastMode === "single_sku") {
      void runSingleSku();
      return;
    }
    const effectiveMode = config.selectionMode;
    const effectiveSkuIds = effectiveMode === "pick" ? config.skuIds : [];
    cancelled.current = false; // fresh run — clear any prior cancel
    setPhase("running");
    setProgress(0);
    setJobMessage("");
    setRunError(null);
    // Clear any prior single-SKU result; the portfolio results below are hidden
    // while phase === "running" so a fresh run never shows stale output (the
    // server also supersedes the previous run).
    setSingleSkuResult(null);
    try {
      const job0 = await forecastService.run({
        skuIds: effectiveSkuIds,
        horizon: "monthly",
        periods: config.periods,
        limit: config.limit,
        selectionMode: effectiveMode,
        // Phase X.H — in "pick" mode brand/segment are VISIBLE-LIST filters only;
        // the forecast set is EXACTLY the checked SKUs. Don't send the filters
        // (they'd narrow the backend pool); send them only for sample/all modes.
        brands: effectiveMode === "pick" ? [] : config.brands,
        segments: effectiveMode === "pick" ? [] : config.segments,
        samplePerStrategy: config.samplePerStrategy,
        compareAlgos: config.compareAlgos,
        segmentSecondary: Object.fromEntries(
          Object.entries(segmentOverrides)
            .filter(([, ov]) => ov.extras?.length)
            .map(([seg, ov]) => [seg, ov.extras]),
        ),
        cvMode: config.cvMode,
        reconcile: config.reconcile,
        useGlobal: config.useGlobal,
        evaluateOos: config.evaluateOos,
      });
      saveActiveJob({ id: job0.id, mode: "portfolio" });
      const job = await pollUntilDone(job0);
      if (!job) return; // unmounted
      await finishPortfolio(job);
    } catch (err) {
      if (cancelled.current) return;
      saveActiveJob(null);
      setRunError((err as { message?: string })?.message ?? "Forecast run failed.");
      setPhase("error");
    }
  }, [config, runSingleSku, pollUntilDone, finishPortfolio]);

  // Phase Y.1 — "Run forecasts" opens the Top-Down decision dialog first; the
  // run only starts after the planner chooses. Both choices proceed; the choice
  // is recorded in the forecast store. Modal shows once per click.
  const requestRun = useCallback(() => {
    // Phase X.H/X.J — "Pick Specific Items" requires an explicit selection.
    if (
      config.forecastMode === "portfolio" &&
      config.selectionMode === "pick" &&
      config.skuIds.length === 0
    ) {
      setRunError(`Please select at least one ${levelLabel.toLowerCase()}.`);
      setPhase("error");
      return;
    }
    // Phase X.Q · Task 9 — recommend Top-Down ONLY for entities with HIGH
    // hold-out error (WMAPE > 20%) that are Volatile Low / Intermittent / Short
    // History. WMAPE comes from the latest run's per-entity metrics; with no
    // prior metrics nothing qualifies and the run starts directly (so the dialog
    // is no longer aggressive — it appears only when there is real evidence).
    const wmapeBySku = new Map<string, number>();
    for (const r of metrics.data?.skus ?? []) {
      if (r.testWmape == null) continue;
      // Normalise a fraction (0–1) to a percent; leave an existing percent as-is.
      wmapeBySku.set(r.sku, r.testWmape <= 1 ? r.testWmape * 100 : r.testWmape);
    }
    const intermBySku = new Map<string, string>();
    for (const s of seg.data?.skus ?? []) {
      intermBySku.set(s.sku, (s.intermittency ?? "").toLowerCase());
    }
    const isVolatileTarget = (segment: string, sku: string): boolean => {
      const seg2 = (segment ?? "").toLowerCase();
      const it = intermBySku.get(sku) ?? "";
      return (
        /volatile low/.test(seg2) ||
        /short history/.test(seg2) ||
        it === "intermittent" ||
        it === "lumpy"
      );
    };

    const allSkus = seg.data?.skus ?? [];
    const selecting =
      config.selectionMode === "pick" ? new Set(config.skuIds) : null;
    const candidates = selecting ? allSkus.filter((s) => selecting.has(s.sku)) : allSkus;
    const qualifying: TopDownCandidate[] = [];
    for (const s of candidates) {
      const pct = wmapeBySku.get(s.sku);
      if (pct == null || pct <= 20) continue; // WMAPE ≤ 20% ⇒ do NOT recommend
      if (!isVolatileTarget(s.segment, s.sku)) continue;
      qualifying.push({ sku: s.sku, segment: s.segment, wmape: pct, reason: "High forecast error" });
    }
    if (qualifying.length === 0) {
      void run(); // no qualifying entities → run normally, no popup
      return;
    }
    setTopDownQualifying(qualifying);
    setTopDownOpen(true);
  }, [config.forecastMode, config.selectionMode, config.skuIds, levelLabel, seg.data, metrics.data, run]);

  // Phase Y.3 · Task 6 — Cancel an in-flight run, frontend-side: stop polling
  // (pollUntilDone bails on `cancelled.current`), clear loading state, and return
  // to the Run state. No page refresh; no backend cancel endpoint exists today.
  const cancelRun = useCallback(() => {
    cancelled.current = true;
    saveActiveJob(null);
    setPhase("idle");
    setProgress(0);
    setJobStatus("");
    setJobMessage("");
    toast.message("Forecast cancelled");
  }, []);
  const resolveTopDown = useCallback(
    (enabled: boolean) => {
      setTopDownEnabled(enabled);
      setTopDownOpen(false);
      void run();
    },
    [run, setTopDownEnabled],
  );

  // Reconnect to an in-flight run after a page refresh (Part 3).
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    const active = loadActiveJob();
    if (!active) return;
    void (async () => {
      let job: ForecastJob;
      try {
        job = await forecastService.getJob(active.id);
      } catch {
        saveActiveJob(null); // job gone (server restarted) — clear
        return;
      }
      if (cancelled.current) return;
      setPhase("running");
      const done = job.status === "completed" || job.status === "failed"
        ? job
        : await pollUntilDone(job);
      if (!done) return;
      if (active.mode === "single_sku") {
        saveActiveJob(null);
        if (done.status === "failed") {
          setRunError(done.error ?? "Single-SKU competition failed.");
          setPhase("error");
          return;
        }
        const res = await forecastService.singleSkuResult().catch(() => null);
        if (cancelled.current) return;
        if (res) {
          setSingleSkuResult(res);
          setPhase("idle");
        } else {
          setPhase("idle");
        }
      } else {
        await finishPortfolio(done);
      }
    })();
  }, [pollUntilDone, finishPortfolio]);

  const gated = !workflow.isLoading && workflow.data && !workflow.data.profileCompleted;

  return (
    <PageShell title="Forecast">
      <WorkflowHero
        step="Step 4 · Forecast"
        title="Multi-Model Forecast Engine"
        subtitle={`Route per ${levelLabel.toLowerCase()}, compete algorithms, pick a champion — with train/test diagnostics and exports`}
        icon={TrendingUp}
        variant="horizon"
        status={
          <>
            <HeroStatusPill tone="accent">12-month horizon</HeroStatusPill>
            <HeroStatusPill>Multi-model competition</HeroStatusPill>
          </>
        }
      />

      {gated ? (
        <WorkflowLock
          title="Forecast locked"
          message="Complete Profile & Route before forecasting."
          href={routes.profile}
          ctaLabel="Go to Profile & Route"
        />
      ) : (
        <>
          {/* Phase Y.2 — Forecast Mode summary + badge (above the Run Status area).
              Reflects the planner's Top-Down choice for the whole run. */}
          <Card>
            <CardContent className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
                  Forecast Mode
                </p>
                <p className="mt-0.5 text-sm font-semibold text-foreground">
                  {topDownEnabled ? "Top-Down Distribution" : `Direct ${levelLabel} Forecasting`}
                </p>
              </div>
              <TopDownBadge enabled={topDownEnabled} />
            </CardContent>
          </Card>

          <div id="configuration" className="scroll-mt-24">
            <ForecastRunConfig
              config={config}
              onChange={patch}
              algorithms={algorithms.data ?? null}
              brandOptions={brandOptions}
              segmentOptions={segmentOptions}
              skuOptions={skuOptions}
              onRun={requestRun}
              onCancel={cancelRun}
              levelPlural={levelPlural}
              attrColumns={attrColumns}
              running={phase === "running"}
              progress={progress}
              jobStatus={jobStatus}
              jobMessage={jobMessage}
              savedHorizon={savedHorizon}
            />
          </div>

          <TopDownDialog
            open={topDownOpen}
            qualifying={topDownQualifying}
            levelLabel={levelLabel}
            levelPlural={levelPlural}
            onEnable={() => resolveTopDown(true)}
            onContinueWithout={() => resolveTopDown(false)}
            onOpenChange={setTopDownOpen}
          />

          <span id="execution" className="block scroll-mt-24" aria-hidden />

          {phase === "error" ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {runError}
            </div>
          ) : null}

          <div id="results" className="scroll-mt-24">
          {config.forecastMode === "single_sku" ? (
            singleSkuResult ? (
              <SingleSkuResultsPanel result={singleSkuResult} />
            ) : phase === "running" ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <EmptyState
                icon={Gauge}
                title="No competition yet"
                description={`Pick a ${levelLabel.toLowerCase()} and models above, then click “Run forecasts”.`}
              />
            )
          ) : phase === "running" ? (
            // Hide the previous run's results while a new run executes — never
            // show stale forecast output; the live progress is shown above.
            <Skeleton className="h-64 w-full" />
          ) : metrics.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : metrics.isError ? (
            <ErrorState title="Couldn’t load results" message={metrics.error?.message} onRetry={() => void metrics.refetch().catch(() => {})} />
          ) : metrics.data && metrics.data.skus.length ? (
            <div className="space-y-3">
              {segSource ? (
                <p className="text-xs text-muted-foreground">
                  Forecast segmentation source:{" "}
                  <span className="font-semibold text-foreground">
                    {segSource === "generated" ? "Generated segmentation" : "Uploaded segmentation"}
                  </span>
                </p>
              ) : null}
              <ForecastResultsPanel metrics={metrics.data} datasetId={seg.data?.datasetId} levelLabel={levelLabel} />
            </div>
          ) : (
            <EmptyState icon={Gauge} title="No forecasts yet" description="Configure the run above and click “Run forecasts”." />
          )}
          </div>
        </>
      )}
    </PageShell>
  );
}
