"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Boxes,
  ChevronDown,
  Download,
  Layers,
  PackageSearch,
  RefreshCw,
  Search,
  Snowflake,
  Tags,
  Waves,
  Clock,
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
import { formatDateTime, formatNumber, formatPercent } from "@/lib/utils/format";
import { routes } from "@/lib/constants/routes";
import { forecastService, segmentationService, workflowService } from "@/lib/api/services";
import { AlgorithmPortfolio } from "./algorithm-portfolio";
import type {
  RoutingSummary,
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
import { SegmentGrid, SegmentGridSkeleton } from "./segment-grid";
import { SegmentTable } from "./segment-table";
import { SegmentTraceDrawer } from "./segment-trace-drawer";
import { TraceSteps } from "./trace-steps";
import { SegmentThresholds } from "./segment-thresholds";
import { SegmentArchitecture } from "./segment-architecture";
import { BrandSegmentMatrixTable } from "./brand-segment-matrix";
import {
  IntermittencyDistributionChart,
  StrategyDistributionChart,
} from "./routing-distributions";

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
      await segmentationService.run(thresholds);
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
  }, [seg, runs, thresholds, workflow]);

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
            <Button onClick={resegment} disabled={resegmenting || seg.isLoading}>
              <RefreshCw className={cn("size-4", resegmenting && "animate-spin")} /> Re-Segment
            </Button>
          </>
        ) : undefined
      }
    >
      <WorkflowHero
        step="Step 3 · Profile & Route"
        title="SKU Classification & Forecasting Strategy"
        subtitle="Intermittency-aware routing — every SKU gets the best-fit model family"
        icon={Layers}
        variant="network"
      />

      {gated ? (
        <WorkflowLock
          title="Profiling locked"
          message="Complete EDA before profiling SKUs."
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

  // Demand Pattern → Model Routing KPIs — rendered verbatim from the server-side
  // routing summary (computed over ALL profiled SKUs, Streamlit parity). The UI
  // does NOT re-aggregate over a paginated/capped SKU list.
  //
  // Default to zeroed counts when the backend omits `routing` — an older/stale
  // backend build returns a segmentation response without this key, which would
  // otherwise crash the page on `routing.skusProfiled` (undefined access).
  const routing: RoutingSummary = data.routing ?? {
    skusProfiled: 0,
    coldStart: 0,
    shortHistory: 0,
    intermittentLumpy: 0,
    brands: 0,
  };

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
        <KpiTile icon={PackageSearch} label="Profiled SKUs" value={formatNumber(data.totalSkus)} />
        <KpiTile icon={Layers} label="Segments" value={formatNumber(data.segments.length)} />
        <KpiTile
          icon={Tags}
          label="Top segment"
          value={topSegment ? topSegment.segment : "—"}
          meta={topSegment?.revenueSharePct != null ? `${formatPercent(topSegment.revenueSharePct / 100)} of revenue` : undefined}
        />
        <KpiTile icon={Tags} label="Brands" value={formatNumber(data.brands.length)} />
      </div>

      {/* Full segmentation matrix */}
      <span id="segmentation" className="block scroll-mt-24" aria-hidden />
      <SegmentGrid segments={data.segments} revenueBasis={data.revenueBasis} />

      {/* Trace a SKU accordion */}
      <Disclosure title="🔍 Trace a SKU — show the exact arithmetic">
        <p className="mb-3 text-sm text-muted-foreground">
          Pick any SKU to see the step-by-step derivation of its segment label, with real numbers.
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="justify-between gap-2 sm:w-64">
              <span className="truncate font-mono text-xs">{traceSku ?? "Select a SKU…"}</span>
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
            SKU counts per brand per segment (top {data.brandSegmentMatrix.brands.length} brands by SKU count).
          </p>
          <BrandSegmentMatrixTable matrix={data.brandSegmentMatrix} />
        </Disclosure>
      ) : null}

      {/* SKU table */}
      <span id="sku-profiles" className="block scroll-mt-24" aria-hidden />
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search SKU or brand…"
                value={search}
                onChange={(e) => onSearch(e.target.value)}
                className="pl-9"
                aria-label="Search SKUs"
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
            <EmptyState title="No matching SKUs" description="Adjust your search or segment filter." />
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
                <span className="text-muted-foreground">{formatNumber(r.nSkus)} SKUs</span>
                <span className="text-muted-foreground">{r.validatedBy ?? "—"}</span>
                <span className="text-xs text-muted-foreground">{formatDateTime(r.runAt)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No runs yet — click “Re-Segment” to persist a validated run.</p>
        )}
      </Disclosure>

      <Separator />

      {/* Demand Pattern → Model Routing */}
      <div id="routing" className="scroll-mt-24 space-y-1">
        <h2 className="text-base font-semibold tracking-tight text-foreground">
          Demand Pattern → Model Routing
        </h2>
        <p className="text-sm text-muted-foreground">
          Same single classification as the segment above — the SBC demand pattern (Smooth / Erratic /
          Intermittent / Lumpy) defines Stable vs Volatile, and routes each SKU to the matching model
          family. Stable SKUs are smooth by definition, so the two views can never disagree.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <KpiTile icon={PackageSearch} label="SKUs Profiled" value={formatNumber(routing.skusProfiled || data.totalSkus)} />
        <KpiTile icon={Snowflake} label="Cold-start" value={formatNumber(routing.coldStart)} meta="→ Chronos zero-shot" />
        <KpiTile icon={Clock} label="Short history" value={formatNumber(routing.shortHistory)} meta="→ global LightGBM" />
        <KpiTile icon={Waves} label="Intermittent / Lumpy" value={formatNumber(routing.intermittentLumpy)} meta="→ Croston / SBA" />
        <KpiTile icon={Boxes} label="Brands" value={formatNumber(routing.brands)} />
      </div>

      {/* Strategy + intermittency distributions */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="space-y-2 pt-6">
            <h3 className="text-sm font-semibold text-foreground">Recommended forecasting strategy</h3>
            {data.strategyDistribution.length ? (
              <StrategyDistributionChart data={data.strategyDistribution} />
            ) : (
              <EmptyState title="No strategy data" description="Re-segment to populate routing." />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2 pt-6">
            <h3 className="text-sm font-semibold text-foreground">Demand pattern (intermittency)</h3>
            {data.intermittencyDistribution.length ? (
              <IntermittencyDistributionChart data={data.intermittencyDistribution} />
            ) : (
              <EmptyState title="No pattern data" description="Re-segment to populate routing." />
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-sm text-muted-foreground">
        Intermittency-aware routing: cold-start SKUs use Chronos zero-shot (with DTW analogue proxy),
        short-history SKUs borrow strength via the global pooled LightGBM, intermittent/lumpy SKUs use
        the Croston/SBA family, and the rest follow their segment recipe (Prophet / SARIMAX / Global
        LightGBM ensembles). Every SKU is guaranteed a best-fit model family.
      </p>

      {/* Per-Segment Model Architecture */}
      <div className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-base font-semibold tracking-tight text-foreground">
            Per-Segment Model Architecture
          </h3>
          <p className="text-sm text-muted-foreground">
            Each segment runs a curated stack — primary model + blend members + residual booster +
            features + confidence-interval method + reconciliation level.
          </p>
        </div>
        <SegmentArchitecture segments={data.segments} />
      </div>

      <Separator />

      {/* Final Algorithm Selection — auto-routed cards, distribution, portfolio */}
      <div id="algorithm-portfolio" className="scroll-mt-24">
        <AlgorithmPortfolio
          strategyDistribution={data.strategyDistribution}
          algorithms={algorithms.data ?? null}
        />
      </div>

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
