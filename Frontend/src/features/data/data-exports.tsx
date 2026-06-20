"use client";

import { useState } from "react";
import { Download, FileJson } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { dataService } from "@/lib/api/services";
import { downloadFile } from "@/lib/utils/download";

interface ExportDef {
  kind: string;
  label: string;
  description: string;
  ext: string;
}

const CSV_EXPORTS: ExportDef[] = [
  { kind: "validation", label: "Validation report", description: "Pass/warn/fail data-quality checks", ext: "csv" },
  { kind: "quality", label: "Data quality report", description: "Rows, SKUs, missing, duplicates, outliers", ext: "csv" },
  { kind: "cleaned", label: "Cleaned dataset", description: "Typed, de-duplicated, missing/outlier handled", ext: "csv" },
  { kind: "prepared", label: "Prepared dataset", description: "Cleaned + resampled to the chosen frequency", ext: "csv" },
];

/**
 * Data exports — real, backend-generated downloads (no placeholder buttons):
 * validation report, data-quality report, cleaned + prepared datasets, the
 * configuration JSON, and the events template.
 */
export function DataExports({ datasetId, fileName }: { datasetId: string; fileName: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const base = (fileName || "dataset").replace(/\.[^.]+$/, "");

  const run = async (kind: string, fn: () => Promise<void>) => {
    setBusy(kind);
    try {
      await fn();
    } catch {
      toast.error(`Couldn’t export ${kind}`);
    } finally {
      setBusy(null);
    }
  };

  const exportCsv = (def: ExportDef) =>
    run(def.kind, async () => {
      const text = await dataService.exportCsv(datasetId, def.kind);
      downloadFile(`${base}_${def.kind}.${def.ext}`, text);
    });

  const exportConfig = () =>
    run("config", async () => {
      const obj = await dataService.exportConfig(datasetId);
      downloadFile(`${base}_config.json`, JSON.stringify(obj, null, 2), "application/json");
    });

  const exportTemplate = () =>
    run("template", async () => {
      const csv = await dataService.eventsTemplate();
      downloadFile("events_calendar_template.csv", csv);
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Exports</CardTitle>
        <CardDescription>Download real outputs generated from this dataset.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CSV_EXPORTS.map((def) => (
            <Button
              key={def.kind}
              variant="outline"
              className="h-auto flex-col items-start gap-1 py-3 text-left"
              disabled={busy !== null}
              onClick={() => exportCsv(def)}
            >
              <span className="flex items-center gap-2 font-medium">
                <Download className="size-4" /> {def.label}
              </span>
              <span className="text-xs font-normal text-muted-foreground">{def.description}</span>
            </Button>
          ))}
          <Button
            variant="outline"
            className="h-auto flex-col items-start gap-1 py-3 text-left"
            disabled={busy !== null}
            onClick={exportConfig}
          >
            <span className="flex items-center gap-2 font-medium">
              <FileJson className="size-4" /> Configuration export
            </span>
            <span className="text-xs font-normal text-muted-foreground">The full Data-page config as JSON</span>
          </Button>
          <Button
            variant="outline"
            className="h-auto flex-col items-start gap-1 py-3 text-left"
            disabled={busy !== null}
            onClick={exportTemplate}
          >
            <span className="flex items-center gap-2 font-medium">
              <Download className="size-4" /> Events template
            </span>
            <span className="text-xs font-normal text-muted-foreground">Blank future-events calendar CSV</span>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
