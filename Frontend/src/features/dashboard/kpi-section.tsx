import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { KpiCard } from "./kpi-card";
import type { KpiMetric } from "@/types/dashboard";

const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4";

export function KpiSection({ metrics }: { metrics: KpiMetric[] }) {
  return (
    <section className={GRID}>
      {metrics.map((metric) => (
        <KpiCard key={metric.key} metric={metric} />
      ))}
    </section>
  );
}

export function KpiSectionSkeleton() {
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
          <Skeleton className="mt-3 h-9 w-full" />
        </Card>
      ))}
    </section>
  );
}
