"use client";

import { useCallback, useMemo, useState } from "react";
import { Database } from "lucide-react";
import { toast } from "sonner";
import { PageShell } from "@/components/layout/page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { useAsync } from "@/lib/hooks";
import { formatDate, formatFrequency, formatNumber } from "@/lib/utils/format";
import { routes } from "@/lib/constants/routes";
import { dataService } from "@/lib/api/services";
import { useEdaStore } from "@/lib/stores/eda-store";
import { useForecastLevel } from "@/lib/stores/forecast-level-store";
import { WorkflowHero } from "@/features/workflow/workflow-hero";
import { ContinueButton } from "@/features/workflow/continue-button";
import { useDatasets } from "@/features/data-upload/hooks/use-datasets";
import { UploadDropzone } from "@/features/data-upload/upload-dropzone";
import { getFileTypeError } from "@/features/data-upload/mock-upload";
import type { UploadPhase } from "@/features/data-upload/types";
import type { DataConfig, Dataset, DatasetPreview, FutureEvent } from "@/types/dataset";
import { DataConfigForm } from "./data-config-form";
import { FutureEvents } from "./future-events";
import { QualitySchema } from "./quality-schema";
import { DataExports } from "./data-exports";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isNumericDtype(dtype: string): boolean {
  return /int|float|double|decimal/i.test(dtype);
}

/**
 * Data — the single consolidated entry point (upload + validation + preparation
 * + configuration), replicating the Streamlit Data tab and sidebar `cfg`.
 * Upload and Prepare are merged into one page.
 */
export function DataView() {
  const { label: levelLabel, plural: levelPlural } = useForecastLevel();
  const datasets = useDatasets();
  const active = useMemo<Dataset | null>(() => datasets.data?.[0] ?? null, [datasets.data]);

  const preview = useAsync<DatasetPreview | null>(
    async () => (active ? dataService.preview(active.id) : null),
    [active?.id],
  );

  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [savingEvents, setSavingEvents] = useState(false);

  const handleFile = useCallback(
    async (selected: File) => {
      setFile(selected);
      const typeError = getFileTypeError(selected);
      if (typeError) {
        setError(typeError);
        setPhase("error");
        return;
      }
      setError(null);
      setPhase("uploading");
      setProgress(0);
      for (let p = 20; p <= 100; p += 20) {
        await wait(70);
        setProgress(p);
      }
      setPhase("processing");
      try {
        await dataService.uploadDataset(selected);
        // New dataset → clear cached EDA so it re-runs against fresh data (F.12 #11).
        useEdaStore.getState().reset();
        await datasets.refetch().catch(() => {});
        setPhase("success");
        toast.success("Dataset uploaded");
      } catch (err) {
        setError((err as { message?: string })?.message ?? "Upload failed.");
        setPhase("error");
      }
    },
    [datasets],
  );

  const handleReset = useCallback(() => {
    setFile(null);
    setPhase("idle");
    setProgress(0);
    setError(null);
  }, []);

  const saveConfig = useCallback(
    async (cfg: DataConfig) => {
      if (!active) return;
      setSavingConfig(true);
      try {
        // Events are owned by the FutureEvents panel — don't overwrite them here.
        const { futureEvents: _omit, ...rest } = cfg;
        void _omit;
        await dataService.updateConfig(active.id, rest);
        await Promise.all([datasets.refetch().catch(() => {}), preview.refetch().catch(() => {})]);
        toast.success("Configuration saved");
      } catch {
        toast.error("Couldn’t save configuration");
      } finally {
        setSavingConfig(false);
      }
    },
    [active, datasets, preview],
  );

  const saveEvents = useCallback(
    async (events: FutureEvent[]) => {
      if (!active) return;
      setSavingEvents(true);
      try {
        await dataService.updateConfig(active.id, { futureEvents: events });
        await datasets.refetch().catch(() => {});
        toast.success("Events saved");
      } catch {
        toast.error("Couldn’t save events");
      } finally {
        setSavingEvents(false);
      }
    },
    [active, datasets],
  );

  const numericColumns = useMemo(
    () => (preview.data?.schema ?? []).filter((s) => isNumericDtype(s.dtype)).map((s) => s.column),
    [preview.data],
  );
  const categoricalColumns = useMemo(
    () => (preview.data?.schema ?? []).filter((s) => !isNumericDtype(s.dtype)).map((s) => s.column),
    [preview.data],
  );

  return (
    <PageShell
      title="Data"
      description="Upload, validate, prepare, and configure your sales history — one place, the full workflow."
    >
      <WorkflowHero
        step="Step 1 · Data"
        title="Sales History Ingestion"
        subtitle="Upload, validate, and configure demand history — the foundation for every forecast."
        icon={Database}
        variant="signal"
        metrics={
          active
            ? [
                { label: levelPlural, value: formatNumber(active.skuCount ?? 0) },
                { label: "Observations", value: formatNumber(active.rowCount ?? 0) },
                {
                  label: "Frequency",
                  value: formatFrequency(active.frequency),
                },
                {
                  label: "Time span",
                  value: active.dateRange
                    ? `${formatDate(active.dateRange.start)} – ${formatDate(active.dateRange.end)}`
                    : "—",
                },
              ]
            : undefined
        }
      />

      {/* Upload */}
      <div id="upload" className="scroll-mt-24">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Upload</CardTitle>
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
      </div>

      {datasets.isError ? (
        <ErrorState
          title="Couldn’t load datasets"
          message={datasets.error?.message}
          onRetry={() => void datasets.refetch().catch(() => {})}
        />
      ) : !active ? (
        <EmptyState
          icon={Database}
          title="No dataset yet"
          description={`Upload a CSV/XLSX with date, ${levelLabel}, and quantity columns to begin.`}
        />
      ) : (
        <>
          {/* F.18C — the duplicate SKUs/Observations/Time-span/Frequency KPI cards
              were removed; the Sales History Ingestion hero (above) is now the
              single source of dataset statistics. */}
          <div id="input-configuration" className="scroll-mt-24">
            <DataConfigForm
              key={active.id}
              dataset={active}
              numericColumns={numericColumns}
              categoricalColumns={categoricalColumns}
              onSave={saveConfig}
              saving={savingConfig}
            />
          </div>

          <div id="event-calendar" className="scroll-mt-24">
            <FutureEvents
              key={`events-${active.id}`}
              initial={active.config?.futureEvents ?? []}
              onSave={saveEvents}
              saving={savingEvents}
            />
          </div>

          <div id="data-quality" className="scroll-mt-24">
            <QualitySchema dataset={active} preview={preview.data ?? null} loading={preview.isLoading} />
          </div>

          <DataExports datasetId={active.id} fileName={active.fileName} />

          <div className="flex justify-end">
            <ContinueButton href={routes.eda} label="Continue to EDA" loadingLabel="Opening EDA…" />
          </div>
        </>
      )}
    </PageShell>
  );
}
