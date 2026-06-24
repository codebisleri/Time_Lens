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

/**
 * Headline accuracy strip — pooled WMAPE (traffic-light) plus the WMAPE quality
 * distribution. Phase Y.3 · Task 3 — the SMAPE / Bias / Backtest-coverage cards
 * were replaced by three forecast-level COUNT cards bucketed by test WMAPE:
 * Excellent (< 20%), Moderate (20–50%), Poor (> 50%). Counts are derived from
 * each forecast-level's testWmape, so they refresh on every run / new dataset /
 * rerun. Pure visualization — no metric is recomputed.
 */
export function PerformanceKpiStrip({ data }: { data: ForecastRunMetrics }) {
  const { plural: levelPlural } = useForecastLevel();
  const wmape = data.groups.overall.weightedWmape;

  // WMAPE distribution over forecast-levels (testWmape is already a percentage,
  // e.g. 14.0 = 14%). Levels with no test metric are excluded from the buckets.
  const scored = data.skus.filter((s) => s.testWmape != null && Number.isFinite(s.testWmape));
  const excellent = scored.filter((s) => (s.testWmape as number) < 20).length;
  const moderate = scored.filter((s) => (s.testWmape as number) >= 20 && (s.testWmape as number) <= 50).length;
  const poor = scored.filter((s) => (s.testWmape as number) > 50).length;

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Tile
        label="Weighted WMAPE"
        value={pct(wmape)}
        tone={wmapeTone(wmape)}
        meta="Pooled · lower is better"
      />
      <Tile
        label="WMAPE < 20%"
        value={formatNumber(excellent)}
        tone="success"
        meta={`Excellent · ${levelPlural}`}
      />
      <Tile
        label="WMAPE 20–50%"
        value={formatNumber(moderate)}
        tone="warning"
        meta={`Moderate · ${levelPlural}`}
      />
      <Tile
        label="WMAPE > 50%"
        value={formatNumber(poor)}
        tone="destructive"
        meta={`Poor · ${levelPlural}`}
      />
    </div>
  );
}
