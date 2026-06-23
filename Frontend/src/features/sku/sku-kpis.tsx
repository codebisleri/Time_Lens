import {
  Boxes,
  CheckCircle2,
  Clock,
  Layers,
  type LucideIcon,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime, formatNumber } from "@/lib/utils/format";
import { useForecastLevel } from "@/lib/stores/forecast-level-store";
import type { SkuRow } from "./derive";

const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4";

/**
 * Premium stat tile for the SKU header: icon, label, value, and a line of
 * trend / metadata text. Mirrors the Dashboard KPI card system so the catalog
 * feels part of the same product.
 */
function SkuKpiCard({
  icon: Icon,
  label,
  value,
  meta,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  meta: string;
}) {
  return (
    <Card className="group relative overflow-hidden p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-[var(--shadow-md)]">
      <div className="brand-rail pointer-events-none absolute inset-x-0 top-0 h-0.5 opacity-70" aria-hidden />
      <div className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100 [background:radial-gradient(80%_60%_at_100%_0%,hsl(var(--primary)/0.14),transparent_70%)]" />

      <div className="relative flex items-start justify-between">
        <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
          <Icon className="size-4" />
        </span>
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

export function SkuKpiSection({
  skus,
  refreshedAt,
}: {
  skus: SkuRow[];
  refreshedAt: string | null;
}) {
  const { plural: levelPlural } = useForecastLevel();
  const total = skus.length;
  const active = skus.filter((s) => s.status === "active").length;
  const categories = new Set(skus.map((s) => s.category)).size;
  const withForecast = skus.filter((s) => s.hasForecast).length;
  const activePct = total ? Math.round((active / total) * 100) : 0;

  return (
    <section className={GRID}>
      <SkuKpiCard
        icon={Boxes}
        label={`Total ${levelPlural}`}
        value={formatNumber(total)}
        meta={`${formatNumber(withForecast)} with forecasts`}
      />
      <SkuKpiCard
        icon={CheckCircle2}
        label={`Active ${levelPlural}`}
        value={formatNumber(active)}
        meta={`${activePct}% of catalog active`}
      />
      <SkuKpiCard
        icon={Layers}
        label="Categories"
        value={formatNumber(categories)}
        meta="Across the master catalog"
      />
      <SkuKpiCard
        icon={Clock}
        label="Last Refresh"
        value={refreshedAt ? formatDateTime(refreshedAt) : "—"}
        meta="Catalog data synced"
      />
    </section>
  );
}

export function SkuKpiSectionSkeleton() {
  return (
    <section className={GRID}>
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i} className="p-5">
          <Skeleton className="size-9 rounded-lg" />
          <div className="mt-4 space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-7 w-20" />
          </div>
          <Skeleton className="mt-3 h-3 w-28" />
        </Card>
      ))}
    </section>
  );
}
