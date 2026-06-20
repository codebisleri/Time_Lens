"use client";

import { useMemo, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/feedback/error-state";
import { Field, Select } from "@/features/data/controls";
import { cn } from "@/lib/utils";
import { ForecastMiniTrendChart } from "@/features/forecast/forecast-mini-trend-chart";
import { useForecastDetail } from "@/features/forecast/hooks/use-forecast-detail";
import type { ForecastMetricRow } from "@/types/forecast";
import { championSmape, errorContribution, wmapeTone, type Tone } from "./derive";

const TONE_TEXT: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  muted: "text-foreground",
};

function Metric({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: string;
  tone?: Tone;
}) {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 text-lg font-semibold tabular-nums",
          TONE_TEXT[tone],
        )}
      >
        {value}
      </p>
    </div>
  );
}

function pct(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`;
}

/**
 * Per-SKU drill-down — select a SKU (ranked by error contribution) and show its
 * WMAPE / SMAPE / bias / strategy plus the held-out actual-vs-backtest series
 * (lazily fetched from the forecast detail endpoint).
 */
export function SkuDrilldown({ rows }: { rows: ForecastMetricRow[] }) {
  const ranked = useMemo(
    () =>
      [...rows].sort((a, b) => errorContribution(b) - errorContribution(a)),
    [rows],
  );
  const [id, setId] = useState<string>(ranked[0]?.id ?? "");
  const row = ranked.find((r) => r.id === id) ?? ranked[0];
  const detail = useForecastDetail(id || null);

  if (!row) return null;

  const options = ranked.map((r) => ({
    value: r.id,
    label: `${r.sku} · WMAPE ${pct(r.testWmape)}`,
  }));

  return (
    <div className="space-y-4">
      <Field label="Inspect SKU (ranked by error contribution)">
        <Select value={id || row.id} onChange={setId} options={options} ariaLabel="Select SKU" />
      </Field>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="WMAPE" value={pct(row.testWmape)} tone={wmapeTone(row.testWmape)} />
        <Metric label="SMAPE" value={pct(championSmape(row))} />
        <Metric
          label="Bias"
          value={
            detail.data?.metrics.bias != null
              ? `${detail.data.metrics.bias >= 0 ? "+" : ""}${pct(detail.data.metrics.bias)}`
              : "—"
          }
        />
        <Metric label="Strategy" value={row.strategyLabel || row.strategy} />
      </div>

      <div className="space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Held-out actual vs backtest forecast
        </h4>
        {detail.isLoading ? (
          <Skeleton className="h-[200px] w-full" />
        ) : detail.isError ? (
          <ErrorState
            title="Couldn’t load the SKU series"
            message={detail.error?.message}
            onRetry={() => void detail.refetch().catch(() => {})}
          />
        ) : detail.data?.series?.length ? (
          <ForecastMiniTrendChart series={detail.data.series} height={200} />
        ) : (
          <p className="text-sm text-muted-foreground">No series available.</p>
        )}
      </div>
    </div>
  );
}
