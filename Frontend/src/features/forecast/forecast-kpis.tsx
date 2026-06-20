import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarRange,
  Gauge,
  Percent,
  Target,
  type LucideIcon,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatDelta, formatNumber, formatPercent } from "@/lib/utils/format";
import type { ForecastResultRow } from "./derive";

const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4";

/**
 * Premium analytics KPI tile. Mirrors the Dashboard KPI card language (icon,
 * value, signed delta chip, trend metadata). `invertDelta` flips the good/bad
 * coloring for error metrics (MAPE/WAPE) where a decrease is an improvement.
 */
function ForecastKpiCard({
  icon: Icon,
  label,
  value,
  delta,
  invertDelta = false,
  meta,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  delta?: number | null;
  invertDelta?: boolean;
  meta: string;
}) {
  const hasDelta = delta != null;
  const good = hasDelta ? (invertDelta ? delta < 0 : delta >= 0) : true;
  const rising = hasDelta ? delta >= 0 : true;

  return (
    <Card className="group relative overflow-hidden p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-[var(--shadow-md)]">
      <div className="brand-rail pointer-events-none absolute inset-x-0 top-0 h-0.5 opacity-70" aria-hidden />
      <div className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100 [background:radial-gradient(80%_60%_at_100%_0%,hsl(var(--primary)/0.14),transparent_70%)]" />

      <div className="relative flex items-start justify-between">
        <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
          <Icon className="size-4" />
        </span>
        {hasDelta ? (
          <span
            className={cn(
              "flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium",
              good
                ? "bg-success/10 text-success"
                : "bg-destructive/10 text-destructive",
            )}
          >
            {rising ? (
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
          {label}
        </p>
        <p className="text-3xl font-semibold tracking-tight tabular-nums text-foreground">
          {value}
        </p>
      </div>

      <p className="relative mt-2 text-xs text-muted-foreground">{meta}</p>
    </Card>
  );
}

/** Aggregate the headline metrics from the loaded forecast rows. */
function aggregate(rows: ForecastResultRow[]) {
  const total = rows.length;
  const avgAccuracy = total
    ? rows.reduce((s, r) => s + r.accuracy, 0) / total
    : 0;
  const mape = total
    ? rows.reduce((s, r) => s + (1 - r.accuracy), 0) / total
    : 0;
  const sumActual = rows.reduce((s, r) => s + r.actualUnits, 0);
  const sumAbsVar = rows.reduce((s, r) => s + Math.abs(r.varianceUnits), 0);
  const wape = sumActual ? sumAbsVar / sumActual : 0;
  const healthy = rows.filter((r) => r.status === "healthy").length;
  const horizon = rows[0]?.horizon ?? "weekly";
  return { total, avgAccuracy, mape, wape, healthy, horizon };
}

export function ForecastKpiSection({ rows }: { rows: ForecastResultRow[] }) {
  const { total, avgAccuracy, mape, wape, healthy, horizon } = aggregate(rows);
  const horizonLabel = horizon.charAt(0).toUpperCase() + horizon.slice(1);

  return (
    <section className={GRID}>
      <ForecastKpiCard
        icon={Target}
        label="Forecast Accuracy"
        value={formatPercent(avgAccuracy)}
        delta={avgAccuracy - 0.85}
        meta={`${formatNumber(healthy)} of ${formatNumber(total)} SKUs healthy`}
      />
      <ForecastKpiCard
        icon={Percent}
        label="MAPE"
        value={formatPercent(mape)}
        delta={mape - 0.15}
        invertDelta
        meta="Mean absolute % error — lower is better"
      />
      <ForecastKpiCard
        icon={Gauge}
        label="WAPE"
        value={formatPercent(wape)}
        delta={wape - 0.15}
        invertDelta
        meta="Volume-weighted % error"
      />
      <ForecastKpiCard
        icon={CalendarRange}
        label="Forecast Horizon"
        value={horizonLabel}
        meta={`${formatNumber(total)} active forecasts`}
      />
    </section>
  );
}

export function ForecastKpiSectionSkeleton() {
  return (
    <section className={GRID}>
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i} className="p-5">
          <div className="flex items-start justify-between">
            <Skeleton className="size-9 rounded-lg" />
            <Skeleton className="h-5 w-12 rounded-full" />
          </div>
          <div className="mt-4 space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-7 w-20" />
          </div>
          <Skeleton className="mt-3 h-3 w-32" />
        </Card>
      ))}
    </section>
  );
}
