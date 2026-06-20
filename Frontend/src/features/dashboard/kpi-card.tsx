import {
  ArrowDownRight,
  ArrowUpRight,
  Boxes,
  PackageOpen,
  Target,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Sparkline } from "@/components/charts/sparkline";
import { cn } from "@/lib/utils";
import {
  formatCompact,
  formatNumber,
  formatPercent,
  formatDelta,
} from "@/lib/utils/format";
import type { KpiMetric } from "@/types/dashboard";

/** Icon per known KPI key; falls back to a generic trend icon. */
const ICONS: Record<string, LucideIcon> = {
  total_skus: Boxes,
  forecast_accuracy: Target,
  revenue_impact: TrendingUp,
  inventory_value: PackageOpen,
};

/** Compact currency ($2.4M) reads cleaner than $2,410,000 on exec tiles. */
function formatCurrencyCompact(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatValue(value: number, format: KpiMetric["format"]) {
  switch (format) {
    case "currency":
      return formatCurrencyCompact(value);
    case "percent":
      return formatPercent(value);
    case "compact":
      return formatCompact(value);
    default:
      return formatNumber(value);
  }
}

/**
 * Premium KPI tile: icon, value, trend delta chip, and a tinted sparkline.
 * Hover lifts the border + shadow for a tactile, Stripe-like feel.
 */
export function KpiCard({ metric }: { metric: KpiMetric }) {
  const Icon = ICONS[metric.key] ?? TrendingUp;
  const delta = metric.deltaPct ?? 0;
  const positive = delta >= 0;

  return (
    <Card className="group relative overflow-hidden p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-[var(--shadow-md)]">
      {/* Forecast-accent top rail — the executive "signature" stripe. */}
      <div className="brand-rail pointer-events-none absolute inset-x-0 top-0 h-0.5 opacity-70" aria-hidden />
      {/* subtle hover glow */}
      <div className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100 [background:radial-gradient(80%_60%_at_100%_0%,hsl(var(--primary)/0.14),transparent_70%)]" />

      <div className="relative flex items-start justify-between">
        <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
          <Icon className="size-4" />
        </span>
        {metric.deltaPct != null ? (
          <span
            className={cn(
              "flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium",
              positive
                ? "bg-success/10 text-success"
                : "bg-destructive/10 text-destructive",
            )}
          >
            {positive ? (
              <ArrowUpRight className="size-3.5" />
            ) : (
              <ArrowDownRight className="size-3.5" />
            )}
            {formatDelta(delta)}
          </span>
        ) : null}
      </div>

      <div className="relative mt-4 space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {metric.label}
        </p>
        <p className="text-3xl font-semibold tracking-tight tabular-nums text-foreground">
          {formatValue(metric.value, metric.format)}
        </p>
      </div>

      {metric.spark?.length ? (
        <div
          className={cn(
            "relative mt-3",
            positive ? "text-success" : "text-destructive",
          )}
        >
          <Sparkline data={metric.spark} id={metric.key} />
        </div>
      ) : null}
    </Card>
  );
}
