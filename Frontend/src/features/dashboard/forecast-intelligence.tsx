"use client";

import {
  Activity,
  CheckCircle2,
  CircleDashed,
  Gauge,
  Layers,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils/format";
import { useForecastLevel } from "@/lib/stores/forecast-level-store";
import type { ReportSummary } from "@/types/report";

type Tone = "success" | "warning" | "destructive" | "info" | "muted";

const TONE: Record<
  Tone,
  { text: string; dot: string; chip: string; bar: string }
> = {
  success: {
    text: "text-success",
    dot: "bg-success",
    chip: "bg-success/15 text-success border-success/25",
    bar: "bg-success",
  },
  warning: {
    text: "text-warning",
    dot: "bg-warning",
    chip: "bg-warning/15 text-warning border-warning/30",
    bar: "bg-warning",
  },
  destructive: {
    text: "text-destructive",
    dot: "bg-destructive",
    chip: "bg-destructive/15 text-destructive border-destructive/25",
    bar: "bg-destructive",
  },
  info: {
    text: "text-info",
    dot: "bg-info",
    chip: "bg-info/15 text-info border-info/25",
    bar: "bg-info",
  },
  muted: {
    text: "text-muted-foreground",
    dot: "bg-muted-foreground",
    chip: "bg-secondary text-muted-foreground border-border",
    bar: "bg-muted-foreground",
  },
};

function wmapeTone(v: number | null): Tone {
  if (v == null || !Number.isFinite(v)) return "muted";
  if (v <= 15) return "success";
  if (v <= 30) return "warning";
  return "destructive";
}

function pct(v: number | null): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`;
}

/** Executive status panel — large value, status chip, forecasting context. */
function StatusPanel({
  icon: Icon,
  label,
  value,
  tone,
  chip,
  meta,
  progress,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone: Tone;
  chip: string;
  meta?: string;
  progress?: number;
}) {
  const t = TONE[tone];
  return (
    <Card className="glass group relative overflow-hidden p-5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-lg)]">
      <div className="brand-rail pointer-events-none absolute inset-x-0 top-0 h-0.5 opacity-70" aria-hidden />
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          <span className="flex size-7 items-center justify-center rounded-md border border-border bg-primary/10 text-primary">
            <Icon className="size-3.5" />
          </span>
          {label}
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
            t.chip,
          )}
        >
          <span className={cn("size-1.5 rounded-full", t.dot)} aria-hidden />
          {chip}
        </span>
      </div>
      <p className={cn("mt-3 text-3xl font-semibold tracking-tight tabular-nums", t.text)}>
        {value}
      </p>
      {progress != null ? (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={cn("h-full rounded-full transition-all", t.bar)}
            style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
          />
        </div>
      ) : null}
      {meta ? <p className="mt-2 text-xs text-muted-foreground">{meta}</p> : null}
    </Card>
  );
}

/**
 * Forecast Intelligence Center — executive status band derived entirely from the
 * existing /reports/summary payload (no new data, no logic). Surfaces forecast
 * health, planning status, demand coverage, and model readiness.
 */
export function ForecastIntelligenceStrip({ summary }: { summary: ReportSummary }) {
  const { plural: levelPlural } = useForecastLevel();
  const { dataset, forecast } = summary;
  const skuTotal = dataset.skuCount ?? 0;
  const forecasted = forecast.skusForecasted ?? 0;
  const hasRun = !!forecast.runId;

  const good = forecast.bands.Good ?? 0;
  const review = forecast.bands.Review ?? 0;
  const poor = forecast.bands.Poor ?? 0;
  const banded = good + review + poor;

  const healthTone = wmapeTone(forecast.medianTestWmape);
  const readiness = skuTotal ? Math.round((forecasted / skuTotal) * 100) : 0;
  const readyTone: Tone =
    readiness >= 80 ? "success" : readiness >= 40 ? "warning" : hasRun ? "warning" : "muted";

  return (
    <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatusPanel
        icon={Gauge}
        label="Forecast health"
        value={pct(forecast.medianTestWmape)}
        tone={healthTone}
        chip={
          forecast.medianTestWmape == null
            ? "Awaiting run"
            : healthTone === "success"
              ? "Healthy"
              : healthTone === "warning"
                ? "Review"
                : "At risk"
        }
        meta="Median test WMAPE · lower is better"
      />
      <StatusPanel
        icon={Activity}
        label="Planning status"
        value={hasRun ? "Forecast ready" : "Not started"}
        tone={hasRun ? "info" : "muted"}
        chip={hasRun ? "Active cycle" : "Pending"}
        meta={
          banded
            ? `${formatNumber(good)} good · ${formatNumber(review)} review · ${formatNumber(poor)} poor`
            : "Run a forecast to open the planning cycle"
        }
      />
      <StatusPanel
        icon={TrendingUp}
        label="Demand coverage"
        value={formatNumber(Math.round(forecast.totalForecastUnits ?? 0))}
        tone={hasRun ? "success" : "muted"}
        chip={hasRun ? "Projected" : "—"}
        meta={`${formatNumber(forecasted)} of ${formatNumber(skuTotal)} ${levelPlural} forecast`}
      />
      <StatusPanel
        icon={Layers}
        label="Model readiness"
        value={`${readiness}%`}
        tone={readyTone}
        chip={readiness >= 80 ? "Ready" : hasRun ? "Partial" : "Idle"}
        progress={readiness}
        meta={`${levelPlural} routed & forecast vs portfolio`}
      />
    </section>
  );
}

/** Small inline legend showing what the status colors mean. */
export function IntelligenceLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <CheckCircle2 className="size-3.5 text-success" /> Healthy ≤ 15% WMAPE
      </span>
      <span className="inline-flex items-center gap-1.5">
        <CircleDashed className="size-3.5 text-warning" /> Review 15–30%
      </span>
      <span className="inline-flex items-center gap-1.5">
        <CircleDashed className="size-3.5 text-destructive" /> At risk &gt; 30%
      </span>
    </div>
  );
}
