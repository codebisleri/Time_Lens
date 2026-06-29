"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChevronDown,
  Download,
  Layers,
  PackageSearch,
  RefreshCw,
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
import type {
  SegmentationResult,
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
 * Profile & Route — replicates the Streamlit "Step 3 · Profile & Route" screen:
 * hero, the Volatility × Contribution routing matrix (all segments shown),
 * methodology + trace + brand + audit accordions, re-segmentation + download,
 * and the Demand Pattern → Model Routing summary. Gated on EDA completion.
 */
export function ProfileRouteView() {
  const workflow = useWorkflowStatus();
  const [thresholds, setThresholds] = useState<SegmentationThresholds | undefined>(undefined);
  const seg = useSegmentation(thresholds);
  const runs = useSegmentationRuns();

  const [segmentFilter, setSegmentFilter] = useState<string>(ALL);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState<SegmentedSku | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [resegmenting, setResegmenting] = useState(false);

  const data = seg.data;
  const skus = useMemo(() => data?.skus ?? [], [data]);

  // Task 3 — Performance Metric: numeric columns drive contribution. Fetch the
  // dataset schema and offer ONLY numeric columns (never SKU/Category/Brand/Date).
  const datasetId = data?.datasetId;
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
  // Phase X.K · Task 6 — dynamic forecast-level term ("Items", "Item Nos",
  // "Product IDs"…) derived from the saved dataset config; labels segment-card
  // counts instead of a hardcoded "SKUs".
  const datasetMeta = useAsync(
    () => (datasetId ? dataService.getDataset(datasetId) : Promise.resolve(null)),
    [datasetId],
  );
  // Phase X.O · Tasks 5–6 — singular + plural Forecast-Level labels, and publish
  // them to the global store so the whole app speaks the user's vocabulary.
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

  // Tasks 3-4 — "Use newly generated segmentation for forecasts" toggle. Shown
  // ONLY when an uploaded segment column exists; otherwise the generated
  // segmentation is mandatory and no checkbox appears. Persists
  // config.useGeneratedSegmentation so the forecast worker resolves the source.
  // No forecasting logic changes — segmentation calculations are untouched.
  const config = datasetMeta.data?.config;
  const hasSegmentColumn = !!config?.segmentCol;
  const [useGenerated, setUseGenerated] = useState(false);
  useEffect(() => {
    setUseGenerated(!!config?.useGeneratedSegmentation);
  }, [config?.useGeneratedSegmentation]);
  const toggleUseGenerated = useCallback(
    async (checked: boolean) => {
      setUseGenerated(checked); // optimistic
      if (!datasetId) return;
      try {
        await dataService.updateConfig(datasetId, { useGeneratedSegmentation: checked });
        await datasetMeta.refetch().catch(() => {});
      } catch {
        setUseGenerated(!checked);
        toast.error("Couldn't update the forecast segmentation source");
      }
    },
    [datasetId, datasetMeta],
  );

  const [metric, setMetric] = useState<string>("");
  // Default once the numeric columns load — prefer the backend's contribution
  // Phase X.Q · Task 7 — intelligent default in strict priority order:
  // Revenue → Sales → Amount → Units → Quantity, then the first numeric column.
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

  // Preview = recompute the matrix with the supplied thresholds (no persist).
  const preview = useCallback((t: SegmentationThresholds) => {
    setThresholds(t);
  }, []);

  // Validate & Save = recompute + persist an audit run (validator + notes).
  const validate = useCallback(
    async (t: SegmentationThresholds, validatedBy: string, notes: string) => {
      setThresholds(t);
      setResegmenting(true);
      try {
        await segmentationService.run({ ...t, validatedBy, notes });
        // Mark the Profile & Route stage complete (mirrors EDA's complete("eda"))
        // and refresh workflow state so the next step unlocks immediately.
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
        setResegmenting(false);
      }
    },
    [seg, runs, workflow],
  );

  const resegment = useCallback(async () => {
    setResegmenting(true);
    try {
      // Task 3 — forward the chosen performance metric so the backend can drive
      // contribution off it. (Existing endpoint ignores unknown keys today; this
      // is forward-compatible without an API change.)
      await segmentationService.run({ ...thresholds, metricColumn: metric });
      // Mark the Profile & Route stage complete and refresh workflow state so the
      // "Continue to Forecast Configuration" button appears without a reload.
      await workflowService.complete("profile").catch(() => {});
      await Promise.all([
        seg.refetch().catch(() => {}),
        runs.refetch().catch(() => {}),
        workflow.refetch().catch(() => {}),
      ]);
      toast.success("Re-segmentation complete — profiling marked done");
    } catch {
      toast.error("Re-segmentation failed");
    } finally {
      setResegmenting(false);
    }
  }, [seg, runs, thresholds, workflow, metric]);

  // Task 4 — reload the persisted (saved) segmentation + audit runs.
  const loadSaved = useCallback(() => {
    void seg.refetch().catch(() => {});
    void runs.refetch().catch(() => {});
  }, [seg, runs]);

  // Streamlit parity: Profile & Route is "done" as soon as the routing matrix has
  // been computed — it does NOT require an explicit Re-Segment / Validate & Save.
  // Auto-mark the step complete once segmentation has loaded so Forecast unlocks.
  const autoMarked = useRef(false);
  useEffect(() => {
    if (
      !autoMarked.current &&
      seg.data &&
      workflow.data &&
      !workflow.data.profileCompleted
    ) {
      autoMarked.current = true;
      void workflowService
        .complete("profile")
        .then(() => workflow.refetch())
        .catch(() => {});
    }
  }, [seg.data, workflow.data, workflow]);

  const gated = !workflow.isLoading && workflow.data && !workflow.data.edaCompleted;
  const profileDone = workflow.data?.profileCompleted;

  return (
    <PageShell
      title="Profile & Route"
      actions={
        !gated ? (
          <>
            <Button variant="outline" onClick={() => downloadCsv(skus)} disabled={seg.isLoading || skus.length === 0}>
              <Download className="size-4" /> Download
            </Button>
            <Button variant="outline" onClick={loadSaved} disabled={seg.isLoading || !metric}>
              <FolderOpen className="size-4" /> Load saved segments
            </Button>
            <Button onClick={resegment} disabled={resegmenting || seg.isLoading || !metric}>
              <RefreshCw className={cn("size-4", resegmenting && "animate-spin")} /> Rerun Segmentation
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

      {/* Task 3 — Performance Metric (required): numeric column driving
          contribution classification. Gates Rerun / Load until selected. */}
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

      {/* Tasks 3-4 — forecast segmentation source control. Shown ONLY when an
          uploaded segment column exists; otherwise the generated segmentation is
          used automatically (mandatory) and no checkbox appears. Run Segmentation
          stays available in BOTH cases (the page actions, above). */}
      {!gated && hasSegmentColumn ? (
        <Card>
          <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
                Forecast segmentation source
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                An uploaded{" "}
                <code className="rounded bg-secondary px-1 py-0.5 text-[0.7rem]">{config?.segmentCol}</code>{" "}
                column was detected. Forecasts use it by default — tick the box to use the newly
                generated segmentation instead. You can still rerun segmentation either way.
              </p>
            </div>
            <label className="flex shrink-0 items-center gap-2 text-sm font-medium text-foreground">
              <input
                type="checkbox"
                checked={useGenerated}
                onChange={(e) => void toggleUseGenerated(e.target.checked)}
                aria-label="Use newly generated segmentation for forecasts"
              />
              Use newly generated segmentation for forecasts
            </label>
          </CardContent>
        </Card>
      ) : null}

      {/* Task 4 — segmentation status panel (header). */}
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
      ) : seg.isLoading || !data ? (
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
          busy={resegmenting || seg.isLoading}
          levelPlural={levelPlural}
          levelLabel={levelLabel}
        />
      )}

      <SegmentTraceDrawer
        sku={active}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        thresholds={thresholds}
      />
    </PageShell>
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
  levelPlural,
  levelLabel,
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
  levelPlural: string;
  levelLabel: string;
}) {
  const [traceSku, setTraceSku] = useState<string | null>(null);
  // Algorithm registry (STRATEGY_INFO + additional benchmarks) for the Final
  // Algorithm Selection portfolio (Issue 5 parity).
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

      {/* Segmentation threshold controls + Validate & Save */}
      <SegmentThresholds
        params={data.params}
        onPreview={onPreview}
        onValidate={onValidate}
        busy={busy}
      />

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
          Computed on demand — click <span className="font-semibold">Re-Segment</span> to persist a validated run.
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

      {/* Phase Y.1 · Task 1 — Profile & Route is the main routing-explanation
          screen. Each segment card surfaces its primary / secondary models,
          routing rationale, feature tags, and a footer with the confidence
          method, reconciliation level and residual correction — alongside the
          existing segment colour, count and contribution share. READ-ONLY: all
          values come from the stored segment architecture; no routing changes. */}
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
          <p className="text-sm text-muted-foreground">No runs yet — click “Re-Segment” to persist a validated run.</p>
        )}
      </Disclosure>

      {/* Phase X.O · Tasks 1–2 — the informational routing-display sections
          (Demand Pattern → Model Routing, Per-Segment Model Architecture,
          Auto-Routed Algorithms, and the Final Algorithm Selection portfolio)
          were removed. The routing ENGINE is unchanged — only the read-only
          display is gone. Anchors kept as hidden spans so the section nav still
          resolves. */}
      <span id="routing" className="block scroll-mt-24" aria-hidden />

      <Separator />

      {/* Per-Segment Overrides — optional planner preference: pick a primary or
          add benchmark/extra algorithms per segment (functional control, kept). */}
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
            <EmptyState title="No segments" description="Re-segment to populate the distribution." />
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
  );
}
