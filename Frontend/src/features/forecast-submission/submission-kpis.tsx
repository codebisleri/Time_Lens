"use client";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils/format";
import { useForecastLevel } from "@/lib/stores/forecast-level-store";
import type { SubmissionKpis } from "@/types/submission";

function signedPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function Tile({
  label,
  value,
  delta,
  deltaTone,
  sub,
}: {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: "up" | "down" | "neutral";
  sub?: string;
}) {
  return (
    <Card className="p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <div className="mt-2 flex items-end justify-between gap-2">
        <span className="text-2xl font-semibold tracking-tight tabular-nums text-foreground">
          {value}
        </span>
        {delta ? (
          <span
            className={cn(
              "text-xs font-medium tabular-nums",
              deltaTone === "up"
                ? "text-success"
                : deltaTone === "down"
                  ? "text-destructive"
                  : "text-muted-foreground",
            )}
          >
            {delta}
          </span>
        ) : null}
      </div>
      {sub ? (
        <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
      ) : null}
    </Card>
  );
}

/** The 5-tile Submission KPI strip — units, Δ%, MoM/YoY trend, overrides. */
export function SubmissionKpiStrip({ kpis }: { kpis: SubmissionKpis }) {
  const { label: levelLabel } = useForecastLevel();
  const deltaTone =
    kpis.deltaPct > 0 ? "up" : kpis.deltaPct < 0 ? "down" : "neutral";

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
      <Tile
        label="Model forecast units"
        value={formatNumber(Math.round(kpis.modelUnits))}
      />
      <Tile
        label="Submitted units"
        value={formatNumber(Math.round(kpis.submittedUnits))}
        delta={signedPct(kpis.deltaPct)}
        deltaTone={deltaTone}
      />
      <Tile label="Avg MoM trend" value={signedPct(kpis.avgMomPct)} />
      <Tile label="Avg YoY trend" value={signedPct(kpis.avgYoyPct)} />
      <Tile
        label="Overrides"
        value={formatNumber(kpis.overrideCells)}
        sub={`${formatNumber(kpis.overrideSkus)} ${levelLabel}(s) · ${formatNumber(kpis.skuCount)} in view`}
      />
    </div>
  );
}
