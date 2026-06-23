"use client";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils/format";
import type { ForecastRunMetrics } from "@/types/forecast";
import { useForecastLevel } from "@/lib/stores/forecast-level-store";
import { wmapeTone, type Tone } from "./derive";

const TONE_TEXT: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  muted: "text-foreground",
};

function Tile({
  label,
  value,
  tone = "muted",
  meta,
}: {
  label: string;
  value: string;
  tone?: Tone;
  meta?: string;
}) {
  return (
    <Card className="group relative overflow-hidden p-5 transition-all duration-200 hover:border-brand/40 hover:shadow-[var(--shadow-md)]">
      <div className="brand-rail pointer-events-none absolute inset-x-0 top-0 h-0.5 opacity-70" aria-hidden />
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-2 text-3xl font-semibold tracking-tight tabular-nums",
          TONE_TEXT[tone],
        )}
      >
        {value}
      </p>
      {meta ? <p className="mt-1 text-xs text-muted-foreground">{meta}</p> : null}
    </Card>
  );
}

function pct(v: number | null): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`;
}
function signedPct(v: number | null): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/**
 * Headline accuracy strip — pooled WMAPE (traffic-light) · SMAPE · bias ·
 * backtest coverage. Mirrors the Streamlit Performance KPI strip.
 */
export function PerformanceKpiStrip({ data }: { data: ForecastRunMetrics }) {
  const { plural: levelPlural } = useForecastLevel();
  // Pooled overall metrics from the server (Streamlit _aggregate_metrics parity):
  // Σ|resid|/Σactual, pooled SMAPE, pooled bias — NOT averages of per-SKU values.
  const o = data.groups.overall;
  const wmape = o.weightedWmape;
  const total = data.skus.length;

  // Streamlit's headline strip: Weighted WMAPE · SMAPE · Bias · Coverage.
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Tile
        label="Weighted WMAPE"
        value={pct(wmape)}
        tone={wmapeTone(wmape)}
        meta="Pooled · lower is better"
      />
      <Tile label="SMAPE" value={pct(o.smape)} meta="Pooled symmetric error" />
      <Tile
        label="Bias"
        value={signedPct(o.weightedBias)}
        meta="Pooled · + over / − under"
      />
      <Tile
        label="Backtest coverage"
        value={pct(o.coveragePct)}
        meta={`${formatNumber(o.skuCount)} of ${formatNumber(total)} ${levelPlural} evaluated`}
      />
    </div>
  );
}
