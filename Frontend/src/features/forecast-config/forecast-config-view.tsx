"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CalendarRange,
  CheckCircle2,
  Gauge,
  Loader2,
  Play,
  Save,
  Sparkles,
} from "lucide-react";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { forecastService, skuService } from "@/lib/api/services";
import { routes } from "@/lib/constants/routes";
import { useForecastLevel } from "@/lib/stores/forecast-level-store";
import { WorkflowLock } from "@/features/workflow/workflow-lock";
import { useWorkflowStatus } from "@/features/workflow/use-workflow-status";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const POLL_MS = 2500;
const MAX_WAIT_MS = 20 * 60 * 1000;
const STORAGE_KEY = "tl-forecast-config";

interface ForecastConfig {
  horizon: number;
  confidence: number;
  skuLimit: number;
  algorithms: string[];
  autoChampion: boolean;
  holidayEffects: boolean;
  promotionEffects: boolean;
}

const DEFAULT_CONFIG: ForecastConfig = {
  horizon: 6,
  confidence: 95,
  skuLimit: 12,
  algorithms: ["auto"],
  autoChampion: true,
  holidayEffects: true,
  promotionEffects: false,
};

const ALGORITHMS = [
  { id: "auto", label: "Auto (route per SKU)" },
  { id: "arima", label: "SARIMAX / ARIMA" },
  { id: "prophet", label: "Prophet" },
  { id: "ets", label: "Holt-Winters / ETS" },
  { id: "croston", label: "Croston / TSB" },
  { id: "ensemble", label: "Ensemble" },
];

type RunPhase = "idle" | "running" | "done" | "error";

function Segmented<T extends number>({
  value,
  options,
  onChange,
  suffix,
}: {
  value: T;
  options: T[];
  onChange: (v: T) => void;
  suffix?: string;
}) {
  return (
    <div className="inline-flex rounded-md border border-border p-0.5">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          className={cn(
            "rounded px-3 py-1.5 text-sm tabular-nums transition-colors",
            value === o
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o}
          {suffix}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card/40 p-4"
    >
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        className="mt-0.5"
      />
      <div className="space-y-0.5">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </label>
  );
}

/**
 * Forecast Configuration — mirrors the Streamlit forecast setup. Captures
 * horizon, confidence, algorithm selection, champion mode, and holiday/promo
 * effects, then kicks off the async run (engine routes per SKU). Config is
 * persisted to localStorage; "Run forecast" polls the job to completion.
 */
export function ForecastConfigView() {
  const router = useRouter();
  const workflow = useWorkflowStatus();
  const { label: levelLabel, plural: levelPlural } = useForecastLevel();
  const algorithms = ALGORITHMS.map((a) =>
    a.id === "auto" ? { ...a, label: `Auto (route per ${levelLabel})` } : a,
  );
  const [config, setConfig] = useState<ForecastConfig>(DEFAULT_CONFIG);
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [jobStatus, setJobStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [producedCount, setProducedCount] = useState(0);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setConfig({ ...DEFAULT_CONFIG, ...JSON.parse(saved) });
    } catch {
      /* ignore malformed config */
    }
    return () => {
      cancelled.current = true;
    };
  }, []);

  const patch = useCallback(
    (p: Partial<ForecastConfig>) => setConfig((c) => ({ ...c, ...p })),
    [],
  );

  const toggleAlgorithm = useCallback((id: string) => {
    setConfig((c) => {
      const has = c.algorithms.includes(id);
      const next = has
        ? c.algorithms.filter((a) => a !== id)
        : [...c.algorithms, id];
      return { ...c, algorithms: next.length ? next : ["auto"] };
    });
  }, []);

  const save = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      toast.success("Configuration saved");
    } catch {
      toast.error("Couldn’t save configuration");
    }
  }, [config]);

  const run = useCallback(async () => {
    setPhase("running");
    setProgress(0);
    setError(null);
    try {
      // The ONLY place a forecast run is started — against the current dataset.
      let job = await forecastService.run({
        skuIds: [],
        horizon: "monthly",
        periods: config.horizon,
        limit: config.skuLimit,
      });
      setJobStatus(job.status);
      let waited = 0;
      while (job.status !== "completed" && job.status !== "failed") {
        await wait(POLL_MS);
        if (cancelled.current) return;
        waited += POLL_MS;
        if (waited > MAX_WAIT_MS) break;
        try {
          job = await forecastService.getJob(job.id);
        } catch {
          /* transient — retry */
        }
        setJobStatus(job.status);
        setProgress(job.progress ?? 0);
      }
      if (cancelled.current) return;
      if (job.status === "failed") {
        setError(job.error ?? "Forecast run failed.");
        setPhase("error");
      } else {
        setProducedCount(job.skuCount ?? job.skuIds?.length ?? 0);
        setPhase("done");
        toast.success("Forecast run complete");
        // Phase 4: refresh results + SKUs, then route the user to the results.
        await Promise.allSettled([
          forecastService.list({ page: 1, pageSize: 500 }),
          skuService.list({ page: 1, pageSize: 500 }),
        ]);
        if (cancelled.current) return;
        router.push(routes.forecasts);
      }
    } catch (err) {
      if (cancelled.current) return;
      setError((err as { message?: string })?.message ?? "Forecast run failed.");
      setPhase("error");
    }
  }, [config, router]);

  const busy = phase === "running";
  const gated = !workflow.isLoading && workflow.data && !workflow.data.profileCompleted;

  if (gated) {
    return (
      <PageShell
        title="Forecast Configuration"
        description={`Step 4 — tune the engine and run forecasts across your routed ${levelPlural}.`}
      >
        <WorkflowLock
          title="Configuration locked"
          message="Complete Profile & Route before configuring forecasts."
          href={routes.profile}
          ctaLabel="Go to Profile & Route"
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Forecast Configuration"
      description={`Step 4 — tune the engine and run forecasts across your routed ${levelPlural}.`}
      actions={
        <Button variant="outline" onClick={save} disabled={busy}>
          <Save className="size-4" /> Save configuration
        </Button>
      }
    >

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarRange className="size-4 text-muted-foreground" /> Horizon &
              confidence
            </CardTitle>
            <CardDescription>How far ahead and how wide the bands.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label>Forecast horizon (periods)</Label>
              <Segmented
                value={config.horizon}
                options={[3, 6, 12]}
                onChange={(horizon) => patch({ horizon })}
              />
            </div>
            <div className="space-y-2">
              <Label>Confidence level</Label>
              <Segmented
                value={config.confidence}
                options={[80, 90, 95]}
                onChange={(confidence) => patch({ confidence })}
                suffix="%"
              />
            </div>
            <div className="space-y-2">
              <Label>{levelPlural} to forecast (top by volume)</Label>
              <Segmented
                value={config.skuLimit}
                options={[6, 12, 24]}
                onChange={(skuLimit) => patch({ skuLimit })}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="size-4 text-muted-foreground" /> Algorithms
            </CardTitle>
            <CardDescription>
              Candidate models — the engine routes & selects per {levelLabel}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {algorithms.map((a) => (
                <label
                  key={a.id}
                  htmlFor={`algo-${a.id}`}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-card/40 px-3 py-2.5"
                >
                  <Checkbox
                    id={`algo-${a.id}`}
                    checked={config.algorithms.includes(a.id)}
                    onCheckedChange={() => toggleAlgorithm(a.id)}
                  />
                  <span className="text-sm text-foreground">{a.label}</span>
                </label>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className="size-4 text-muted-foreground" /> Effects & selection
          </CardTitle>
          <CardDescription>
            Champion selection and exogenous demand drivers.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Toggle
            id="champion"
            label="Champion selection"
            description={`Auto-pick the best model per ${levelLabel} via cross-validation.`}
            checked={config.autoChampion}
            onChange={(v) => patch({ autoChampion: v })}
          />
          <Toggle
            id="holidays"
            label="Holiday effects"
            description="Include the festival/holiday calendar as exogenous signal."
            checked={config.holidayEffects}
            onChange={(v) => patch({ holidayEffects: v })}
          />
          <Toggle
            id="promotions"
            label="Promotion effects"
            description="Model promo windows where present in the data."
            checked={config.promotionEffects}
            onChange={(v) => patch({ promotionEffects: v })}
          />
        </CardContent>
      </Card>

      {/* Run */}
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">Run forecast</p>
            <p className="text-sm text-muted-foreground">
              Generates forecasts for the top {config.skuLimit} {levelPlural} ·{" "}
              {config.horizon}-period horizon.
            </p>
          </div>
          <Button onClick={run} disabled={busy} className="sm:w-44">
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {jobStatus === "queued" ? "Queued…" : `Running… ${progress}%`}
              </>
            ) : (
              <>
                <Play className="size-4" /> Run forecast
              </>
            )}
          </Button>
        </CardContent>

        {busy ? (
          <CardContent className="space-y-1.5 pt-0">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium capitalize text-foreground">
                {jobStatus || "queued"}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {progress}%
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-all duration-150"
                style={{ width: `${progress}%` }}
              />
            </div>
          </CardContent>
        ) : null}

        {phase === "done" ? (
          <CardContent className="pt-0">
            <div className="flex flex-col gap-3 rounded-md border border-success/30 bg-success/10 px-4 py-3 text-sm text-success sm:flex-row sm:items-center sm:justify-between">
              <span className="flex items-center gap-2">
                <CheckCircle2 className="size-4" />
                Generated {producedCount} forecasts.
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" asChild>
                  <Link href={routes.forecasts}>View results</Link>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <Link href={routes.forecastSubmission}>Review</Link>
                </Button>
              </div>
            </div>
          </CardContent>
        ) : null}

        {phase === "error" ? (
          <CardContent className="pt-0">
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          </CardContent>
        ) : null}
      </Card>
    </PageShell>
  );
}
