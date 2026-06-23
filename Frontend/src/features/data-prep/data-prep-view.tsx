"use client";

import {
  AlertTriangle,
  CalendarRange,
  CopyX,
  Database,
  FileWarning,
  Gauge,
  Layers,
  ListChecks,
  Boxes,
  Rows3,
  ShieldAlert,
} from "lucide-react";
import { PageShell } from "@/components/layout/page-shell";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatDate, formatNumber } from "@/lib/utils/format";
import { useForecastLevel } from "@/lib/stores/forecast-level-store";
import type { Dataset } from "@/types/dataset";
import { useActiveDataset, useDatasetCategories } from "./hooks/use-active-dataset";
import { PrepTile, PrepTilesSkeleton, type TileTone } from "./prep-tiles";
import { ColumnMapping } from "./column-mapping";

function countTone(n: number | undefined): TileTone {
  return (n ?? 0) > 0 ? "warning" : "success";
}

function ValidationSection({ dataset }: { dataset: Dataset }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Dataset validation</CardTitle>
        <CardDescription>
          Data-quality checks computed on the uploaded file.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <PrepTile
            icon={Rows3}
            label="Total rows"
            value={formatNumber(dataset.rowCount ?? 0)}
            meta="Valid records ingested"
          />
          <PrepTile
            icon={ShieldAlert}
            label="Missing values"
            value={formatNumber(dataset.missingValues ?? 0)}
            meta="Empty cells across columns"
            tone={countTone(dataset.missingValues)}
          />
          <PrepTile
            icon={CopyX}
            label="Duplicate rows"
            value={formatNumber(dataset.duplicateRows ?? 0)}
            tone={countTone(dataset.duplicateRows)}
          />
          <PrepTile
            icon={FileWarning}
            label="Invalid dates"
            value={formatNumber(dataset.invalidDates ?? 0)}
            meta="Unparseable date values"
            tone={countTone(dataset.invalidDates)}
          />
          <PrepTile
            icon={AlertTriangle}
            label="Outliers"
            value={formatNumber(dataset.outlierCount ?? 0)}
            meta="IQR outliers in sales"
            tone={countTone(dataset.outlierCount)}
          />
          <PrepTile
            icon={Gauge}
            label="Frequency"
            value={dataset.frequencyLabel ?? dataset.frequency ?? "—"}
            meta="Detected cadence"
          />
        </div>
      </CardContent>
    </Card>
  );
}

function SummarySection({
  dataset,
  categories,
}: {
  dataset: Dataset;
  categories: number | null;
}) {
  const { label: levelLabel } = useForecastLevel();
  const range = dataset.dateRange
    ? `${formatDate(dataset.dateRange.start)} – ${formatDate(dataset.dateRange.end)}`
    : "—";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Dataset summary</CardTitle>
        <CardDescription>Coverage of the active dataset.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <PrepTile icon={CalendarRange} label="Date range" value={range} />
          <PrepTile
            icon={Boxes}
            label={`${levelLabel} count`}
            value={formatNumber(dataset.skuCount ?? 0)}
          />
          <PrepTile
            icon={Layers}
            label="Categories"
            value={categories != null ? formatNumber(categories) : "—"}
          />
          <PrepTile
            icon={ListChecks}
            label="Records"
            value={formatNumber(dataset.rowCount ?? 0)}
          />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Data Preparation — mirrors the Streamlit "Data" stage: validation checks,
 * column mapping (auto-detected + overridable), and a dataset summary, all for
 * the most recently uploaded dataset.
 */
export function DataPrepView() {
  const dataset = useActiveDataset();
  const categories = useDatasetCategories();

  return (
    <PageShell
      title="Data Preparation"
      description="Validate, map, and summarize the uploaded dataset before forecasting."
    >

      {dataset.isLoading ? (
        <>
          <PrepTilesSkeleton count={6} />
          <PrepTilesSkeleton count={4} />
        </>
      ) : dataset.isError ? (
        <ErrorState
          title="Couldn’t load dataset"
          message={dataset.error?.message}
          onRetry={() => void dataset.refetch().catch(() => {})}
        />
      ) : !dataset.data ? (
        <EmptyState
          icon={Database}
          title="No dataset uploaded"
          description="Upload a sales file to validate and prepare it for forecasting."
        />
      ) : (
        <>
          <ValidationSection dataset={dataset.data} />
          <SummarySection
            dataset={dataset.data}
            categories={categories.isError ? null : (categories.data?.length ?? null)}
          />
          <ColumnMapping dataset={dataset.data} />
        </>
      )}
    </PageShell>
  );
}
