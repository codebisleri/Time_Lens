import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  formatCompact,
  formatCurrency,
  formatNumber,
  formatPercent,
  formatDelta,
} from "@/lib/utils/format";
import type { KpiMetric } from "@/types/dashboard";

function formatValue(value: number, format: KpiMetric["format"]) {
  switch (format) {
    case "currency":
      return formatCurrency(value);
    case "percent":
      return formatPercent(value);
    case "compact":
      return formatCompact(value);
    default:
      return formatNumber(value);
  }
}

/** KPI tile used across the Dashboard. Pure presentation, driven by a KpiMetric. */
export function StatTile({ metric }: { metric: KpiMetric }) {
  const positive = (metric.deltaPct ?? 0) >= 0;

  return (
    <Card className="group relative overflow-hidden p-5 transition-all duration-200 hover:border-brand/40 hover:shadow-[var(--shadow-md)]">
      {/* Forecast-accent top rail — executive signature stripe. */}
      <div className="brand-rail pointer-events-none absolute inset-x-0 top-0 h-0.5 opacity-70" aria-hidden />
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {metric.label}
      </p>
      <div className="mt-2 flex items-end justify-between gap-2">
        <span className="text-3xl font-semibold tracking-tight tabular-nums text-foreground">
          {formatValue(metric.value, metric.format)}
        </span>
        {metric.deltaPct != null ? (
          <span
            className={cn(
              "flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium",
              positive
                ? "bg-success/15 text-success"
                : "bg-destructive/15 text-destructive",
            )}
          >
            {positive ? (
              <ArrowUpRight className="size-3.5" />
            ) : (
              <ArrowDownRight className="size-3.5" />
            )}
            {formatDelta(metric.deltaPct)}
          </span>
        ) : null}
      </div>
    </Card>
  );
}
