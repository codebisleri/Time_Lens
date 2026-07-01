"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ChevronDown,
  Download,
  Layers,
  PackageSearch,
  Search,
  Tags,
  Clock,
  FolderOpen,
  CheckCircle2,
} from "lucide-react";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useAsync } from "@/lib/hooks";
import {
  formatDateTime,
  formatForecastLevel,
  formatNumber,
  formatPercent,
  pluralizeLevel,
} from "@/lib/utils/format";
import { routes } from "@/lib/constants/routes";
import { dataService, forecastService, segmentationService, workflowService } from "@/lib/api/services";
import { Select } from "@/features/data/controls";
import { useForecastLevelStore } from "@/lib/stores/forecast-level-store";
import { useSegmentationSourceStore } from "@/lib/stores/segmentation-source-store";
import type {
  SegmentationResult,
  SegmentationSource,
  SegmentationThresholds,
  SegmentedSku,
} from "@/types/segmentation";
import { WorkflowHero } from "@/features/workflow/workflow-hero";
import { ContinueButton } from "@/features/workflow/continue-button";
import { WorkflowLock } from "@/features/workflow/workflow-lock";
import { Disclosure } from "@/features/workflow/disclosure";
import { useWorkflowStatus } from "@/features/workflow/use-workflow-status";
import { useSegmentation, useSegmentationRuns } from "./hooks/use-segmentation";
import { SegmentGridSkeleton } from "./segment-grid";
import { SegmentArchitecture } from "./segment-architecture";
import { SegmentTable } from "./segment-table";
import { SegmentTraceDrawer } from "./segment-trace-drawer";
import { TraceSteps } from "./trace-steps";
import { SegmentThresholds } from "./segment-thresholds";
import { SegmentOverrides } from "./segment-overrides";
import { BrandSegmentMatrixTable } from "./brand-segment-matrix";
import { GeneratedSegmentationDialog } from "./generated-segmentation-dialog";
import { visibleSegments } from "@/lib/utils/routing-summary";
import { SegmentDistributionChart } from "./routing-distributions";

const ALL = "all";

function downloadCsv(skus: SegmentedSku[]) {
  if (typeof document === "undefined") return;
  const header = ["SKU", "Segment", "Volatility", "Contribution", "Pattern", "Revenue Share %", "Periods", "Brand"];
  const body = skus.map((s) => [
    s.sku, s.segment, s.volatility, s.contribution, s.intermittency,
    s.revenueSharePct != null ? s.revenueSharePct.toFixed(2) : "", s.nPeriods, s.brand ?? "",
  ]);
  const csv = [header, ...body]
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "segmented-skus.csv";
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Profile & Route — TWO independent segmentation sources:
 *
 *   • uploadedSegmentation  — the uploaded segment column (immutable).
 *   • generatedSegmentation — computed by "Run Segmentation".
 *   • activeSegmentation    — whichever is selected; the ONLY source consumed
 *     downstream (forecast, explainability, scenario, reports, top-down, …).
 *
 * Flow: the page stays CLEAN (thresholds + actions only) until the planner runs
 * segmentation. When an uploaded column exists they then pick the active source
 * (popup → Proceed); otherwise the generated source auto-activates. Only after
 * that do the routing cards / tables / audit render — entirely from the active
 * source, switchable in place with no re-run or refresh.
 */
export function ProfileRouteView() {
  const workflow = useWorkflowStatus();
  const [thresholds, setThresholds] = useState<SegmentationThresholds | undefined>(undefined);

  // ── Three-state segmentation source ──────────────────────────────────────
  const {
    datasetId: srcDatasetId,
    proceeded,
    activeSource,
    init: initSource,
    setActiveSource,
    markRan,
    proceed,
  } = useSegmentationSourceStore();

  // Before the planner Proceeds we always work against the GENERATED segmentation
  // (the threshold/preview target); afterwards we render the ACTIVE source.
  const displaySource: SegmentationSource = proceeded ? activeSource : "generated";
  const seg = useSegmentation(thresholds, displaySource);
  const runs = useSegmentationRuns();

  const [segmentFilter, setSegmentFilter] = useState<string>(ALL);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState<SegmentedSku | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [popupOpen, setPopupOpen] = useState(false);
  const [running, setRunning] = useState(false);
  // The freshly generated segmentation (Run Segmentation result) — drives the
  // summary popup. Independent of `uploadedSegmentation`, which is never touched.
  const [generatedResult, setGeneratedResult] = useState<SegmentationResult | null>(null);

  const data = seg.data;
  const skus = useMemo(() => data?.skus ?? [], [data]);
  const datasetId = data?.datasetId;

  // Performance metric — numeric columns drive contribution.
  const schemaPreview = useAsync(
    () => (datasetId ? dataService.preview(datasetId) : Promise.resolve(null)),
    [datasetId],
  );
  const numericCols = useMemo(() => {
    const sch = schemaPreview.data?.schema ?? [];
    return sch
      .filter((s) => /int|float|double|decimal|numeric|number|real|long/i.test(s.dtype))
      .map((s) => s.column);
  }, [schemaPreview.data]);

  const datasetMeta = useAsync(
    () => (datasetId ? dataService.getDataset(datasetId) : Promise.resolve(null)),
    [datasetId],
  );
  const config = datasetMeta.data?.config;
  const hasSegmentColumn = !!config?.segmentCol;

  const levelLabel = useMemo(() => {
    const cfg = datasetMeta.data?.config;
    if (!cfg) return "Item";
    if (cfg.forecastLevelMode === "overall") return "Series";
    if (cfg.forecastLevelMode === "custom")
      return formatForecastLevel(cfg.forecastLevelCols?.[0] ?? "Group");
    return formatForecastLevel(cfg.skuCol);
  }, [datasetMeta.data]);
  const levelPlural = useMemo(() => pluralizeLevel(levelLabel), [levelLabel]);
  const setForecastLevelLabel = useForecastLevelStore((s) => s.setForecastLevelLabel);
  useEffect(() => {
    if (datasetMeta.data?.config) setForecastLevelLabel(levelLabel);
  }, [levelLabel, datasetMeta.data, setForecastLevelLabel]);

  // Initialise/repair the source store for this dataset (resets the run/proceed
  // gate when the dataset changes; seeds the active source from config).
  useEffect(() => {
    if (datasetId && config) {
      initSource({
        datasetId,
        hasUploaded: !!config.segmentCol,
        useGenerated: !!config.useGeneratedSegmentation,
      });
    }
  }, [datasetId, config, initSource]);
  // True once the store has synced to THIS dataset (avoids a stale-flag flash when
  // navigating between datasets).
  const sourceSynced = !!datasetId && srcDatasetId === datasetId;

  const [metric, setMetric] = useState<string>("");
  useEffect(() => {
    if (!metric && numericCols.length) {
      const PRIORITY = [/revenue/i, /sales/i, /amount/i, /units?/i, /quantity|qty/i];
      let pick: string | undefined;
      for (const rx of PRIORITY) {
        pick = numericCols.find((c) => rx.test(c));
        if (pick) break;
      }
      setMetric(pick ?? numericCols[0]!);
    }
  }, [numericCols, metric]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return skus.filter((s) => {
      if (segmentFilter !== ALL && s.segment !== segmentFilter) return false;
      if (q && !`${s.sku} ${s.brand ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [skus, segmentFilter, search]);

  const openTrace = useCallback((sku: SegmentedSku) => {
    setActive(sku);
    setDrawerOpen(true);
  }, []);

  // Preview = recompute with the supplied thresholds (no persist).
  const preview = useCallback((t: SegmentationThresholds) => {
    setThresholds(t);
  }, []);

  // Persist the active source to the dataset config so the backend forecast
  // worker resolves the SAME source as the UI (single source of truth).
  const persistSource = useCallback(
    async (source: SegmentationSource) => {
      if (!datasetId) return;
      try {
        await dataService.updateConfig(datasetId, {
          useGeneratedSegmentation: source === "generated",
        });
        await datasetMeta.refetch().catch(() => {});
      } catch {
        /* best-effort — the run still proceeds with the prior config */
      }
    },
    [datasetId, datasetMeta],
  );

  // Run Segmentation — generate the GENERATED segmentation with the tuned
  // thresholds (the uploaded Segments column is NEVER touched), then:
  //   • uploaded Segments exist  → show the summary popup (Workflow B/C).
  //   • no uploaded Segments      → auto-activate generated + proceed (Workflow D).
  const runSegmentation = useCallback(
    async (t: SegmentationThresholds) => {
      setThresholds(t);
      setRunning(true);
      try {
        const result = await segmentationService.run({ ...t, metricColumn: metric });
        setGeneratedResult(result); // independent copy for the summary popup
        markRan();
        await workflowService.complete("profile").catch(() => {});
        await Promise.all([
          runs.refetch().catch(() => {}),
          workflow.refetch().catch(() => {}),
        ]);
        if (hasSegmentColumn) {
          setPopupOpen(true); // Workflow B/C — show summary + choose
        } else {
          // Workflow D — generated is the only (and active) source. No popup.
          setActiveSource("generated");
          await persistSource("generated");
          proceed();
        }
      } catch {
        toast.error("Run Segmentation failed");
      } finally {
        setRunning(false);
      }
    },
    [metric, hasSegmentColumn, markRan, runs, workflow, setActiveSource, persistSource, proceed],
  );

  // Popup Proceed — the checkbox decides the active source. Unticked ⇒ keep the
  // uploaded segmentation (Workflow B); ticked ⇒ use the newly generated one
  // (Workflow C). Either way the rest of the page renders from the active source.
  const onProceed = useCallback(
    async (useGenerated: boolean) => {
      const source: SegmentationSource = useGenerated ? "generated" : "uploaded";
      setActiveSource(source);
      await persistSource(source);
      proceed();
      setPopupOpen(false);
    },
    [setActiveSource, persistSource, proceed],
  );

  // Use Existing Segments — adopt the uploaded segmentation directly (Workflow A):
  // no algorithm run, no popup, render immediately from the uploaded column.
  const useExisting = useCallback(async () => {
    setActiveSource("uploaded");
    await persistSource("uploaded");
    proceed();
  }, [setActiveSource, persistSource, proceed]);

  // Validate & Save = generate + persist a validated audit run (validator + notes).
  const validate = useCallback(
    async (t: SegmentationThresholds, validatedBy: string, notes: string) => {
      setThresholds(t);
      setRunning(true);
      try {
        await segmentationService.run({ ...t, validatedBy, notes, metricColumn: metric });
        await workflowService.complete("profile").catch(() => {});
        await Promise.all([
          seg.refetch().catch(() => {}),
          runs.refetch().catch(() => {}),
          workflow.refetch().catch(() => {}),
        ]);
        toast.success("Validated & saved — profiling marked done");
      } catch {
        toast.error("Validate & Save failed");
      } finally {
        setRunning(false);
      }
    },
    [seg, runs, workflow, metric],
  );

  const loadSaved = useCallback(() => {
    void seg.refetch().catch(() => {});
    void runs.refetch().catch(() => {});
  }, [seg, runs]);

  const gated = !workflow.isLoading && workflow.data && !workflow.data.edaCompleted;
  const profileDone = workflow.data?.profileCompleted;

  return (
    <PageShell
      title="Profile & Route"
      actions={
        !gated && proceeded ? (
          <>
            <Button variant="outline" onClick={() => downloadCsv(skus)} disabled={seg.isLoading || skus.length === 0}>
              <Download className="size-4" /> Download
            </Button>
            <Button variant="outline" onClick={loadSaved} disabled={seg.isLoading || !metric}>
              <FolderOpen className="size-4" /> Load saved segments
            </Button>
          </>
        ) : undefined
      }
    >
      <WorkflowHero
        step="Step 3 · Profile & Route"
        title={`${levelLabel} Classification & Forecasting Strategy`}
        subtitle={`Intermittency-aware routing — every ${levelLabel.toLowerCase()} gets the best-fit model family`}
        icon={Layers}
        variant="network"
      />

      {/* Performance Metric (required): numeric column driving contribution. */}
      {!gated ? (
        <Card>
          <CardContent className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
                Performance Metric <span className="text-brand-accent">*</span>
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Numeric column used for contribution classification (Revenue / Sales / Units…).
              </p>
            </div>
            <div className="sm:w-64">
              {numericCols.length ? (
                <Select
                  ariaLabel="Performance metric"
                  value={metric}
                  onChange={setMetric}
                  options={[
                    { value: "", label: "Select a metric…" },
                    ...numericCols.map((c) => ({ value: c, label: c })),
                  ]}
                />
              ) : (
                <p className="text-xs text-muted-foreground">Detecting numeric columns…</p>
              )}
              {!metric ? (
                <p className="mt-1 text-xs font-medium text-brand-accent">
                  Please select a performance metric.
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Forecast Segmentation Source — informational: shows which of the two
          independent sources is active. The choice is made via the Run
          Segmentation popup / Use Existing Segments buttons below. */}
      {!gated && data ? (
        <SourceCard
          hasUploaded={hasSegmentColumn}
          segmentColumn={config?.segmentCol ?? null}
          proceeded={proceeded}
          activeSource={activeSource}
        />
      ) : null}

      {/* Segmentation Validated — status header. */}
      {!gated && data ? (
        <Card>
          <CardContent className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2
                className={cn("size-4", profileDone ? "text-success" : "text-muted-foreground")}
              />
              <span className="font-semibold text-foreground">
                {profileDone ? "Segmentation validated" : "Segmentation profiled (draft)"}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>{formatNumber(data.segments.length)} segments</span>
              <span>{formatNumber(data.totalSkus)} {levelPlural}</span>
              {runs.data?.[0] ? (
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3" /> Last saved {formatDateTime(runs.data[0].runAt)}
                </span>
              ) : (
                <span>No saved runs yet</span>
              )}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {gated ? (
        <WorkflowLock
          title="Profiling locked"
          message={`Complete EDA before profiling ${levelPlural.toLowerCase()}.`}
          href={routes.eda}
          ctaLabel="Go to EDA"
        />
      ) : seg.isError ? (
        <ErrorState
          title="Couldn’t load segmentation"
          message={seg.error?.message}
          onRetry={() => void seg.refetch().catch(() => {})}
        />
      ) : seg.isLoading || !data || !sourceSynced ? (
        <>
          <Skeleton className="h-10 w-72" />
          <SegmentGridSkeleton />
        </>
      ) : (
        <ProfileContent
          data={data}
          filtered={filtered}
          segmentFilter={segmentFilter}
          onSegmentFilter={setSegmentFilter}
          search={search}
          onSearch={setSearch}
          onRowClick={openTrace}
          runs={runs.data ?? []}
          profileDone={!!profileDone}
          thresholds={thresholds}
          onPreview={preview}
          onValidate={validate}
          busy={running || seg.isLoading}
          running={running}
          levelPlural={levelPlural}
          levelLabel={levelLabel}
          onRunSegmentation={runSegmentation}
          showUseExisting={hasSegmentColumn}
          onUseExisting={useExisting}
          showDetails={proceeded}
        />
      )}

      <SegmentTraceDrawer
        sku={active}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        thresholds={thresholds}
      />

      {/* Workflow B/C — summary of the generated segmentation + the opt-in to use it. */}
      <GeneratedSegmentationDialog
        open={popupOpen}
        segments={generatedResult?.segments ?? []}
        levelPlural={levelPlural}
        onProceed={onProceed}
        onOpenChange={setPopupOpen}
      />
    </PageShell>
  );
}

/** Forecast Segmentation Source — informational status of the ACTIVE source. */
function SourceCard({
  hasUploaded,
  segmentColumn,
  proceeded,
  activeSource,
}: {
  hasUploaded: boolean;
  segmentColumn: string | null;
  proceeded: boolean;
  activeSource: SegmentationSource;
}) {
  const activeLabel =
    activeSource === "uploaded" ? "Uploaded Segments" : "Newly generated segmentation";
  return (
    <Card>
      <CardContent className="space-y-2 py-4">
        <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
          Forecast segmentation source
        </p>
        {!hasUploaded ? (
          <p className="text-xs text-muted-foreground">
            No uploaded Segments column — the generated segmentation is used automatically.
          </p>
        ) : !proceeded ? (
          <p className="text-xs text-muted-foreground">
            An uploaded{" "}
            <code className="rounded bg-secondary px-1 py-0.5 text-[0.7rem]">{segmentColumn}</code>{" "}
            column was detected. Choose <span className="font-medium">Run Segmentation</span> or{" "}
            <span className="font-medium">Use Existing Segments</span> below. The uploaded Segments
            are never overwritten.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Active source: <span className="font-medium text-foreground">{activeLabel}</span>. Both
            sources are kept independently — re-run or use existing Segments below to switch.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

const HOW_IT_WORKS = [
  "Each SKU gets ONE classification — demand pattern × contribution — in a single deterministic pass (no ML, no randomness). Pattern and volatility can never disagree because volatility is derived from the pattern.",
  "1. History check — a SKU must have ≥ min_periods non-null sales observations; below that, segment = CV NULL/0 (cold-start / NPI proxy).",
  "2. Demand pattern (Syntetos-Boylan-Croston) — from the sales series compute ADI (mean interval between non-zero demands) and CV² (squared CV of non-zero demand), classified against the standard cutoffs (ADI 1.32, CV² 0.49): smooth · erratic · intermittent · lumpy · dead.",
  "3. Volatility = the pattern, summarised — smooth ⇒ Stable; erratic / intermittent / lumpy ⇒ Volatile; dead ⇒ CV NULL/0.",
  "4. Contribution (Pareto-ABC) — SKUs are ranked descending by revenue; cumulative share ≤ top cut ⇒ High, ≤ mid cut ⇒ Mid, otherwise Low.",
  "Final segment = (pattern → Stable/Volatile) × Contribution → 6 cells (plus the CV NULL/0 triage bucket). Recomputable, auditable, reproducible from the saved run record.",
];

function KpiTile({
  icon: Icon,
  label,
  value,
  meta,
}: {
  icon: typeof Layers;
  label: string;
  value: string;
  meta?: string;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="size-4 text-primary" />
        {label}
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-foreground">{value}</p>
      {meta ? <p className="mt-1 text-xs text-muted-foreground">{meta}</p> : null}
    </Card>
  );
}

function ProfileContent({
  data,
  filtered,
  segmentFilter,
  onSegmentFilter,
  search,
  onSearch,
  onRowClick,
  runs,
  profileDone,
  thresholds,
  onPreview,
  onValidate,
  busy,
  running,
  levelPlural,
  levelLabel,
  onRunSegmentation,
  showUseExisting,
  onUseExisting,
  showDetails,
}: {
  data: SegmentationResult;
  filtered: SegmentedSku[];
  segmentFilter: string;
  onSegmentFilter: (v: string) => void;
  search: string;
  onSearch: (v: string) => void;
  onRowClick: (sku: SegmentedSku) => void;
  runs: { runId: string; runAt: string; nSkus: number; validatedBy: string | null; notes: string | null }[];
  profileDone: boolean;
  thresholds?: SegmentationThresholds;
  onPreview: (t: SegmentationThresholds) => void;
  onValidate: (t: SegmentationThresholds, validatedBy: string, notes: string) => void;
  busy: boolean;
  running: boolean;
  levelPlural: string;
  levelLabel: string;
  onRunSegmentation: (t: SegmentationThresholds) => void;
  showUseExisting: boolean;
  onUseExisting: () => void;
  /** Render the full routing page (post-Proceed) vs. the clean pre-run controls. */
  showDetails: boolean;
}) {
  const [traceSku, setTraceSku] = useState<string | null>(null);
  const algorithms = useAsync(() => forecastService.algorithms(), []);
  const trace = useAsync(
    async () => (traceSku ? segmentationService.trace(traceSku, thresholds) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [traceSku, JSON.stringify(thresholds ?? {})],
  );

  const topSegment = [...data.segments].sort(
    (a, b) => (b.revenueSharePct ?? 0) - (a.revenueSharePct ?? 0),
  )[0];
  const latestRun = runs[0];

  // Visible (non-empty) segments drive the distribution chart.
  const activeSegments = useMemo(() => visibleSegments(data.segments), [data.segments]);

  return (
    <>
      <h2 id="overview" className="scroll-mt-24 text-base font-semibold tracking-tight text-foreground">
        Routing Segments — Volatility × Contribution
      </h2>

      {/* Methodology accordion */}
      <Disclosure title="How segmentation works · Logic & thresholds">
        <div className="space-y-2 text-sm text-muted-foreground">
          {HOW_IT_WORKS.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      </Disclosure>

      {/* Segmentation thresholds (always expanded) + the segmentation actions
          (Run Segmentation, Use Existing Segments) + Validate & Save. */}
      <SegmentThresholds
        params={data.params}
        onPreview={onPreview}
        onValidate={onValidate}
        busy={busy}
        running={running}
        onRun={onRunSegmentation}
        showUseExisting={showUseExisting}
        onUseExisting={onUseExisting}
      />

      {/* Everything below renders from the ACTIVE segmentation, only once the
          planner has run segmentation and chosen a source (Proceed). */}
      {!showDetails ? null : (
        <>
          {/* Database run banner */}
          {latestRun ? (
            <div className="rounded-md border-l-4 border-primary bg-primary/5 px-4 py-2.5 text-sm">
              <span className="font-semibold text-foreground">Loaded from database.</span>{" "}
              <span className="text-muted-foreground">
                Run <code className="rounded bg-secondary px-1 py-0.5 text-xs">{latestRun.runId}</code> — previously-validated labels reused.
              </span>
            </div>
          ) : (
            <div className="rounded-md border-l-4 border-warning bg-warning/10 px-4 py-2.5 text-sm text-foreground">
              Computed on demand — click <span className="font-semibold">Run Segmentation</span> to persist a validated run.
            </div>
          )}

          {/* KPIs */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiTile icon={PackageSearch} label={`Profiled ${levelPlural}`} value={formatNumber(data.totalSkus)} />
            <KpiTile icon={Layers} label="Segments" value={formatNumber(data.segments.length)} />
            <KpiTile
              icon={Tags}
              label="Top segment"
              value={topSegment ? topSegment.segment : "—"}
              meta={topSegment?.revenueSharePct != null ? `${formatPercent(topSegment.revenueSharePct / 100)} of revenue` : undefined}
            />
            <KpiTile icon={Tags} label="Brands" value={formatNumber(data.brands.length)} />
          </div>

          {/* Segment Routing & Model Architecture */}
          <section id="segmentation" className="scroll-mt-24 space-y-2">
            <h3 className="text-base font-semibold tracking-tight text-foreground">
              Segment Routing & Model Architecture
            </h3>
            <p className="text-sm text-muted-foreground">
              How each segment is forecast — primary &amp; secondary models, engineered drivers,
              confidence-interval method, reconciliation and residual correction.
            </p>
            <SegmentArchitecture
              segments={data.segments}
              levelPlural={levelPlural}
              revenueBasis={data.revenueBasis}
            />
          </section>

          {/* Trace accordion */}
          <Disclosure title={`🔍 Trace a ${levelLabel} — show the exact arithmetic`}>
            <p className="mb-3 text-sm text-muted-foreground">
              Pick any {levelLabel.toLowerCase()} to see the step-by-step derivation of its segment label, with real numbers.
            </p>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="justify-between gap-2 sm:w-64">
                  <span className="truncate font-mono text-xs">{traceSku ?? `Select a ${levelLabel}…`}</span>
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
                {data.skus.map((s) => (
                  <DropdownMenuItem key={s.sku} onSelect={() => setTraceSku(s.sku)} className="font-mono text-xs">
                    {s.sku}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="mt-3">
              {!traceSku ? null : trace.isLoading ? (
                <Skeleton className="h-40 w-full" />
              ) : trace.isError ? (
                <ErrorState title="Couldn’t load trace" message={trace.error?.message} />
              ) : trace.data ? (
                <TraceSteps trace={trace.data} />
              ) : null}
            </div>
          </Disclosure>

          {/* Brand × Segment crosstab accordion */}
          {data.brandSegmentMatrix && data.brandSegmentMatrix.brands.length ? (
            <Disclosure title="Brand × Segment breakdown">
              <p className="mb-3 text-sm text-muted-foreground">
                {levelLabel} counts per brand per segment (top {data.brandSegmentMatrix.brands.length} brands).
              </p>
              <BrandSegmentMatrixTable matrix={data.brandSegmentMatrix} />
            </Disclosure>
          ) : null}

          {/* Forecast-level table */}
          <span id="sku-profiles" className="block scroll-mt-24" aria-hidden />
          <Card>
            <CardContent className="space-y-4 pt-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="relative flex-1 sm:max-w-xs">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="search"
                    placeholder={`Search ${levelLabel.toLowerCase()} or brand…`}
                    value={search}
                    onChange={(e) => onSearch(e.target.value)}
                    className="pl-9"
                    aria-label={`Search ${levelPlural}`}
                  />
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="justify-between gap-2 sm:w-56">
                      <span className="truncate">{segmentFilter === ALL ? "All segments" : segmentFilter}</span>
                      <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
                    <DropdownMenuItem onSelect={() => onSegmentFilter(ALL)}>All segments</DropdownMenuItem>
                    {data.segments.map((s) => (
                      <DropdownMenuItem key={s.segment} onSelect={() => onSegmentFilter(s.segment)}>
                        {s.segment}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {filtered.length ? (
                <SegmentTable data={filtered} onRowClick={onRowClick} />
              ) : (
                <EmptyState title={`No matching ${levelPlural}`} description="Adjust your search or segment filter." />
              )}
            </CardContent>
          </Card>

          {/* Audit trail accordion */}
          <Disclosure title="Audit Trail — persisted segmentation runs">
            {runs.length ? (
              <div className="divide-y divide-border/60">
                {runs.map((r) => (
                  <div key={r.runId} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="font-mono text-xs text-muted-foreground">{r.runId}</span>
                    <span className="text-muted-foreground">{formatNumber(r.nSkus)} {levelPlural}</span>
                    <span className="text-muted-foreground">{r.validatedBy ?? "—"}</span>
                    <span className="text-xs text-muted-foreground">{formatDateTime(r.runAt)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No runs yet — click “Run Segmentation” to persist a validated run.</p>
            )}
          </Disclosure>

          <span id="routing" className="block scroll-mt-24" aria-hidden />

          <Separator />

          {/* Per-Segment Overrides */}
          <SegmentOverrides
            segments={data.segments}
            algorithms={algorithms.data ?? null}
            levelPlural={levelPlural}
          />

          {/* Distribution by Segment */}
          <Card>
            <CardContent className="space-y-2 pt-6">
              <h3 className="text-base font-semibold tracking-tight text-foreground">
                {levelPlural} by Segment
              </h3>
              {activeSegments.length ? (
                <SegmentDistributionChart data={activeSegments} skus={data.skus} levelPlural={levelPlural} />
              ) : (
                <EmptyState title="No segments" description="Run Segmentation to populate the distribution." />
              )}
            </CardContent>
          </Card>

          <span id="algorithm-portfolio" className="block scroll-mt-24" aria-hidden />

          {profileDone ? (
            <div className="flex justify-end">
              <ContinueButton
                href={routes.forecast}
                label="Continue to Forecast"
                loadingLabel="Loading Forecast…"
              />
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
