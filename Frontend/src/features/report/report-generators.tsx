"use client";

import { Download, FileText, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatDateTime } from "@/lib/utils/format";
import { useForecastLevel } from "@/lib/stores/forecast-level-store";
import type {
  GeneratedReport,
  ReportCatalogItem,
  ReportKind,
} from "@/types/report";

function sizeLabel(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Report catalog — one card per report. Single-report mode: each card holds the
 * latest generated report of its type (regenerate replaces it) with a download.
 */
export function ReportGenerators({
  catalog,
  latest,
  generating,
  downloading,
  onGenerate,
  onDownload,
}: {
  catalog: ReportCatalogItem[];
  latest: Partial<Record<ReportKind, GeneratedReport>>;
  generating: ReportKind | null;
  downloading: string | null;
  onGenerate: (type: ReportKind) => void;
  onDownload: (report: GeneratedReport) => void;
}) {
  const { label: levelLabel, plural: levelPlural } = useForecastLevel();
  const descriptions: Record<ReportKind, string> = {
    segmentation: `Six-segment matrix with playbook, portfolio distribution, brand × segment breakdown and hero ${levelPlural}.`,
    routed_forecast: `Routing summary, per-strategy split and the per-${levelLabel.toLowerCase()} routed forecast table.`,
  };
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {catalog.map((item) => {
        const busy = generating === item.type;
        const report = latest[item.type];
        return (
          <Card key={item.type} className="flex flex-col gap-3 p-5">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary/60 text-primary">
                <FileText className="size-4" />
              </span>
              <div className="space-y-1">
                <p className="font-medium text-foreground">{item.title}</p>
                <p className="text-xs text-muted-foreground">
                  {descriptions[item.type]}
                </p>
              </div>
            </div>

            {!item.available && item.reason ? (
              <p className="text-xs text-warning">{item.reason}</p>
            ) : null}

            {report ? (
              <p className="text-xs text-muted-foreground">
                Latest: {formatDateTime(report.generatedAt)}
                {report.sizeBytes ? ` · ${sizeLabel(report.sizeBytes)}` : ""}
              </p>
            ) : null}

            <div className="mt-auto flex gap-2">
              <Button
                variant={report ? "outline" : "default"}
                className="flex-1"
                disabled={!item.available || busy}
                onClick={() => onGenerate(item.type)}
              >
                {busy ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> Generating…
                  </>
                ) : report ? (
                  <>
                    <RefreshCw className="size-4" /> Regenerate
                  </>
                ) : (
                  "Generate report"
                )}
              </Button>
              {report ? (
                <Button
                  className="flex-1"
                  disabled={downloading === report.id}
                  onClick={() => onDownload(report)}
                >
                  {downloading === report.id ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Download className="size-4" />
                  )}
                  Download HTML
                </Button>
              ) : null}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
