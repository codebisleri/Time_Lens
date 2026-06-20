"use client";

import { useRouter } from "next/navigation";
import { GitCompareArrows } from "lucide-react";
import Link from "next/link";
import { DataTable } from "@/components/data-table/data-table";
import { EmptyState } from "@/components/feedback/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartCard } from "./chart-card";
import { recentScenarioColumns } from "./recent-scenarios-columns";
import { routes } from "@/lib/constants/routes";
import type { Scenario } from "@/types";

/** Recent Scenario Runs activity panel. Rows navigate to scenario detail. */
export function RecentScenariosTable({ data }: { data: Scenario[] }) {
  const router = useRouter();

  return (
    <ChartCard
      title="Recent scenario runs"
      description="Latest what-if analyses and their projected revenue impact."
      action={
        <Button variant="outline" size="sm" asChild>
          <Link href={routes.scenarios}>View all</Link>
        </Button>
      }
    >
      {data.length ? (
        <DataTable
          columns={recentScenarioColumns}
          data={data}
          onRowClick={(row) => router.push(routes.scenario(row.id))}
        />
      ) : (
        <EmptyState
          icon={GitCompareArrows}
          title="No scenarios yet"
          description="Create a scenario to model price changes, promotions, or supply shifts."
          action={
            <Button asChild size="sm">
              <Link href={routes.scenarioNew}>New scenario</Link>
            </Button>
          }
        />
      )}
    </ChartCard>
  );
}

export function RecentScenariosTableSkeleton() {
  return (
    <ChartCard title="Recent scenario runs">
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </ChartCard>
  );
}
