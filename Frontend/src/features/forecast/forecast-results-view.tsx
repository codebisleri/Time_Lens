"use client";

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { Activity, BarChart3, Download, LineChart, SearchX } from "lucide-react";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { ChartCard, ChartCardSkeleton } from "@/features/dashboard/chart-card";
import { WorkflowLock } from "@/features/workflow/workflow-lock";
import { useWorkflowStatus } from "@/features/workflow/use-workflow-status";
import { routes } from "@/lib/constants/routes";
import { formatPercent } from "@/lib/utils/format";
import { useForecastLevel } from "@/lib/stores/forecast-level-store";
import { FORECAST_HEALTH_LABELS, type ForecastResultRow } from "./derive";
import { useForecastResults } from "./hooks/use-forecast-results";
import { useForecastTrend } from "./hooks/use-forecast-trend";
import {
  ForecastKpiSection,
  ForecastKpiSectionSkeleton,
} from "./forecast-kpis";
import {
  ALL,
  DEFAULT_FORECAST_FILTERS,
  ForecastFilterBar,
  type ForecastFilters,
} from "./forecast-filter-bar";
import { ForecastTable, ForecastTableSkeleton } from "./forecast-table";
import { ForecastTrendBandChart } from "./forecast-trend-band-chart";
import {
  ForecastCategoryAccuracyChart,
  type CategoryAccuracyDatum,
} from "./forecast-category-accuracy-chart";
import { ForecastDetailDrawer } from "./forecast-detail-drawer";

/** Mock CSV export of the currently filtered forecasts (no backend round-trip). */
function exportForecastsCsv(rows: ForecastResultRow[]) {
  if (typeof document === "undefined") return;
  const header = [
    "SKU",
    "Product Name",
    "Category",
    "Forecast",
    "Actual",
    "Variance",
    "Accuracy",
    "Status",
  ];
  const body = rows.map((r) => [
    r.skuCode,
    r.skuName,
    r.category,
    r.forecastUnits,
    r.actualUnits,
    r.varianceUnits,
    formatPercent(r.accuracy),
    FORECAST_HEALTH_LABELS[r.status],
  ]);
  const csv = [header, ...body]
    .map((cells) =>
      cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","),
    )
    .join("\n");

  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "forecast-results.csv";
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Forecast Results — the core forecasting intelligence page. Composes the KPI
 * header, the hero trend/confidence-band visualization, category accuracy, the
 * TanStack-powered results table, and a read-only detail drawer. The full set
 * loads once (mock services); search / filter / sort / paginate / column
 * visibility / selection run client-side. Each section owns its loading / empty
 * / error state so one slow or failing call never blanks the page.
 */
export function ForecastResultsView() {
  const workflow = useWorkflowStatus();
  const results = useForecastResults();
  const trend = useForecastTrend();
  const { plural: levelPlural } = useForecastLevel();

  const [filters, setFilters] = useState<ForecastFilters>(
    DEFAULT_FORECAST_FILTERS,
  );

  // Drawer state is local to the feature — clicking a row never navigates away.
  const [activeRow, setActiveRow] = useState<ForecastResultRow | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const rows = useMemo<ForecastResultRow[]>(
    () => results.data ?? [],
    [results.data],
  );

  const categories = useMemo(
    () => Array.from(new Set(rows.map((r) => r.category))).sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filters.status !== ALL && r.status !== filters.status) return false;
      if (filters.category !== ALL && r.category !== filters.category)
        return false;
      if (q && !`${r.skuCode} ${r.skuName}`.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [rows, filters]);

  const categoryAccuracy = useMemo<CategoryAccuracyDatum[]>(() => {
    const totals = new Map<string, { sum: number; n: number }>();
    for (const r of rows) {
      const t = totals.get(r.category) ?? { sum: 0, n: 0 };
      t.sum += r.accuracy;
      t.n += 1;
      totals.set(r.category, t);
    }
    return [...totals.entries()]
      .map(([category, { sum, n }]) => ({ category, accuracy: sum / n }))
      .sort((a, b) => b.accuracy - a.accuracy);
  }, [rows]);

  const openRow = useCallback((row: ForecastResultRow) => {
    setActiveRow(row);
    setDrawerOpen(true);
  }, []);

  const handleExport = useCallback((toExport: ForecastResultRow[]) => {
    exportForecastsCsv(toExport);
    toast.success(`Exported ${toExport.length} forecasts to CSV`);
  }, []);

  const isEmptyCatalog =
    !results.isLoading && !results.isError && rows.length === 0;
  const isNoResults = filtered.length === 0 && rows.length > 0;

  const categoryCaption =
    categoryAccuracy.length >= 2
      ? `Top: ${categoryAccuracy[0]!.category} (${formatPercent(
          categoryAccuracy[0]!.accuracy,
        )}) · Lowest: ${
          categoryAccuracy[categoryAccuracy.length - 1]!.category
        } (${formatPercent(
          categoryAccuracy[categoryAccuracy.length - 1]!.accuracy,
        )})`
      : "Mean forecast accuracy per product category.";

  const gated =
    !workflow.isLoading && workflow.data && !workflow.data.forecastCompleted;

  if (gated) {
    return (
      <PageShell
        title="Forecast Results"
        description="Step 5 — review the demand forecasts produced by the engine."
      >
        <WorkflowLock
          title="No forecast results available"
          message="Run a forecast first."
          href={routes.forecast}
          ctaLabel="Go to Forecast"
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Forecast Results"
      description="Model outputs, accuracy metrics, and demand forecasts across the catalog."
      actions={
        <Button
          variant="outline"
          onClick={() => handleExport(filtered)}
          disabled={results.isLoading || rows.length === 0}
        >
          <Download className="size-4" /> Export
        </Button>
      }
    >

      {/* KPI header */}
      {results.isLoading ? (
        <ForecastKpiSectionSkeleton />
      ) : results.isError ? null : (
        <ForecastKpiSection rows={rows} />
      )}

      {/* Hero forecast visualization */}
      {trend.isLoading ? (
        <ChartCardSkeleton height={360} />
      ) : trend.isError ? (
        <ChartCard title="Forecast trend">
          <ErrorState
            title="Couldn’t load trend"
            message={trend.error?.message}
            onRetry={() => void trend.refetch().catch(() => {})}
          />
        </ChartCard>
      ) : trend.data?.length ? (
        <ChartCard
          title="Forecast trend & confidence band"
          description="Portfolio demand — historical actuals, forecast, and the 95% confidence range."
        >
          <ForecastTrendBandChart data={trend.data} />
        </ChartCard>
      ) : (
        <ChartCard title="Forecast trend & confidence band">
          <EmptyState
            icon={LineChart}
            title="No forecast data"
            description="Run a forecast to see demand trends here."
          />
        </ChartCard>
      )}

      {/* Category performance */}
      {results.isLoading ? (
        <ChartCardSkeleton height={300} />
      ) : categoryAccuracy.length ? (
        <ChartCard title="Accuracy by category" description={categoryCaption}>
          <ForecastCategoryAccuracyChart data={categoryAccuracy} />
        </ChartCard>
      ) : (
        <ChartCard title="Accuracy by category">
          <EmptyState
            icon={BarChart3}
            title="No category data"
            description="Category accuracy appears once forecasts are available."
          />
        </ChartCard>
      )}

      {/* Results table */}
      {results.isError ? (
        <ErrorState
          title="Couldn’t load forecasts"
          message={results.error?.message}
          onRetry={() => void results.refetch().catch(() => {})}
        />
      ) : results.isLoading ? (
        <Card>
          <CardContent className="pt-6">
            <ForecastTableSkeleton />
          </CardContent>
        </Card>
      ) : isEmptyCatalog ? (
        <EmptyState
          icon={Activity}
          title="No forecasts yet"
          description={`Run the forecasting engine on your ${levelPlural} to populate results here.`}
        />
      ) : (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <ForecastFilterBar
              filters={filters}
              categories={categories}
              onChange={setFilters}
            />

            {isNoResults ? (
              <EmptyState
                icon={SearchX}
                title="No matching forecasts"
                description="No forecasts match your search and filters. Try adjusting them."
                action={
                  <Button
                    variant="outline"
                    onClick={() => setFilters(DEFAULT_FORECAST_FILTERS)}
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <ForecastTable data={filtered} onRowClick={openRow} />
            )}
          </CardContent>
        </Card>
      )}

      <ForecastDetailDrawer
        row={activeRow}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
      />
    </PageShell>
  );
}
