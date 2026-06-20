"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Boxes, CheckCircle2, Database, Download } from "lucide-react";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ErrorState } from "@/components/feedback/error-state";
import { formatNumber } from "@/lib/utils/format";
import { routes } from "@/lib/constants/routes";
import { useUploadStore } from "@/lib/stores";
import { dataService } from "@/lib/api/services";
import { useDatasets } from "./hooks/use-datasets";
import { UploadHero, UploadHeroSkeleton } from "./upload-hero";
import { UploadDropzone } from "./upload-dropzone";
import { ValidationPanel } from "./validation-panel";
import {
  UploadHistoryTable,
  UploadHistoryTableSkeleton,
} from "./upload-history-table";
import { getFileTypeError } from "./mock-upload";
import type { UploadPhase, UploadSummary } from "./types";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Headline metrics shown after a dataset is registered. */
interface UploadMetrics {
  datasetRows: number;
  skuCount: number;
}

/** Compact metric tile for the post-upload summary. */
function MetricTile({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Database;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="size-4 text-primary" />
        {label}
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">
        {formatNumber(value)}
      </p>
    </div>
  );
}

/**
 * Data ingestion page — Step 1 of the forecasting workflow.
 *
 * Upload ONLY registers the dataset (POST /datasets/upload). No forecasting is
 * triggered here — that happens later, on the Forecast Configuration page. After
 * a successful upload we show a summary and point the user to the next step
 * (Data Preparation).
 */
export function DataUploadView() {
  const datasets = useDatasets();

  const file = useUploadStore((s) => s.file);
  const setFile = useUploadStore((s) => s.setFile);
  const setProcessing = useUploadStore((s) => s.setProcessing);
  const reset = useUploadStore((s) => s.reset);

  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadSummary | null>(null);
  const [metrics, setMetrics] = useState<UploadMetrics | null>(null);

  // Guard against setState after unmount during the async flow.
  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const handleFile = useCallback(
    async (selected: File) => {
      setResult(null);
      setMetrics(null);
      setFile(selected);

      const typeError = getFileTypeError(selected);
      if (typeError) {
        setError(typeError);
        setPhase("error");
        return;
      }
      setError(null);

      // ── Phase: Uploading ──────────────────────────────────────────────
      setPhase("uploading");
      setProgress(0);
      for (let p = 10; p <= 100; p += 10) {
        await wait(80);
        if (cancelled.current) return;
        setProgress(p);
      }

      // ── Phase: Processing dataset (parse + register via the bridge) ────
      // NOTE: this is the ONLY network call on upload. Forecasting is NOT
      // started here — the user runs it later from Forecast Configuration.
      setPhase("processing");
      setProcessing(true);
      try {
        const dataset = await dataService.uploadDataset(selected);
        if (cancelled.current) return;
        const datasetRows = dataset.rowCount ?? 0;
        const datasetSkus = dataset.skuCount ?? 0;
        setResult({
          rowsProcessed: datasetRows,
          rowsRejected: 0,
          missingValues: 0,
          duplicateSkus: 0,
          issues: [],
        });
        setMetrics({ datasetRows, skuCount: datasetSkus });
        setProcessing(false);
        setPhase("success");
        // Surface the new dataset in hero/history immediately.
        void datasets.refetch().catch(() => {});
      } catch (err) {
        if (cancelled.current) return;
        setProcessing(false);
        setError(
          (err as { message?: string })?.message ??
            "Upload failed. Please try again.",
        );
        setPhase("error");
      }
    },
    [setFile, setProcessing, datasets],
  );

  const handleReset = useCallback(() => {
    reset();
    setPhase("idle");
    setProgress(0);
    setError(null);
    setResult(null);
    setMetrics(null);
  }, [reset]);

  return (
    <PageShell
      title="Data Upload"
      description="Step 1 — ingest sales history. Validation, profiling, and forecasting follow as separate steps."
      actions={
        <Button variant="outline" asChild>
          <a href="#" download>
            <Download className="size-4" /> Download template
          </a>
        </Button>
      }
    >

      {/* Hero */}
      {datasets.isLoading ? (
        <UploadHeroSkeleton />
      ) : datasets.isError ? (
        <ErrorState
          title="Couldn’t load upload stats"
          message={datasets.error?.message}
          onRetry={() => void datasets.refetch().catch(() => {})}
        />
      ) : (
        <UploadHero datasets={datasets.data ?? []} />
      )}

      {/* Upload area */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload data file</CardTitle>
          <CardDescription>
            CSV or XLSX with date, SKU, and quantity columns.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UploadDropzone
            phase={phase}
            progress={progress}
            file={file}
            error={error}
            onFile={handleFile}
            onReset={handleReset}
          />
        </CardContent>
      </Card>

      {/* Upload success summary + next-step CTA */}
      {phase === "success" && metrics ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className="size-4 text-success" /> Dataset uploaded
              successfully
            </CardTitle>
            <CardDescription>
              Your sales history is registered. No forecasts have been generated
              yet — continue through the workflow to validate, profile, and run
              forecasts.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <MetricTile
                icon={Database}
                label="Dataset rows"
                value={metrics.datasetRows}
              />
              <MetricTile
                icon={Boxes}
                label="SKUs detected"
                value={metrics.skuCount}
              />
            </div>
            <div className="flex justify-end">
              <Button asChild>
                <Link href={routes.dataPrepare}>
                  Continue to data preparation <ArrowRight className="size-4" />
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Validation results */}
      {result ? <ValidationPanel summary={result} /> : null}

      {/* History */}
      {datasets.isLoading ? (
        <UploadHistoryTableSkeleton />
      ) : datasets.isError ? null : (
        <UploadHistoryTable datasets={datasets.data ?? []} />
      )}
    </PageShell>
  );
}
