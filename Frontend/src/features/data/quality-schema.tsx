"use client";

import { CopyX, FileWarning, Gauge, Rows3, Table2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/utils/format";
import type { Dataset, DatasetPreview } from "@/types/dataset";
import { PrepTile, type TileTone } from "@/features/data-prep/prep-tiles";

function tone(n: number | undefined): TileTone {
  return (n ?? 0) > 0 ? "warning" : "success";
}

/**
 * Quality & Schema — replicates the Streamlit Data tab's "Quality & Schema"
 * sub-tab: data-quality checks, a data preview (first rows), and schema details.
 */
export function QualitySchema({
  dataset,
  preview,
  loading,
}: {
  dataset: Dataset;
  preview: DatasetPreview | null;
  loading: boolean;
}) {
  return (
    <div className="space-y-6">
      {/* Data quality checks */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Data quality checks</CardTitle>
        </CardHeader>
        <CardContent>
          {/* F.12 #7 — Missing Values & Outliers tiles removed. */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <PrepTile icon={Rows3} label="Total rows" value={formatNumber(dataset.rowCount ?? 0)} meta="Valid records ingested" />
            <PrepTile icon={CopyX} label="Duplicate rows" value={formatNumber(dataset.duplicateRows ?? 0)} tone={tone(dataset.duplicateRows)} />
            <PrepTile icon={FileWarning} label="Invalid dates" value={formatNumber(dataset.invalidDates ?? 0)} meta="Unparseable date values" tone={tone(dataset.invalidDates)} />
            <PrepTile icon={Gauge} label="Frequency" value={dataset.frequencyLabel ?? dataset.frequency ?? "—"} meta="Detected cadence" />
          </div>
        </CardContent>
      </Card>

      {/* Data preview */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Table2 className="size-4 text-muted-foreground" /> Data preview
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-48 w-full" />
          ) : preview && preview.rows.length ? (
            <div className="overflow-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="bg-secondary/40 text-left text-muted-foreground">
                  <tr>
                    {preview.columns.map((c) => (
                      <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, i) => (
                    <tr key={i} className="border-t border-border/60">
                      {preview.columns.map((c) => (
                        <td key={c} className="whitespace-nowrap px-3 py-1.5 font-mono">{row[c] ?? "—"}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Preview unavailable.</p>
          )}
        </CardContent>
      </Card>

      {/* Schema details */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Schema details</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-40 w-full" />
          ) : preview && preview.schema.length ? (
            <div className="overflow-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="bg-secondary/40 text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Column</th>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 text-right font-medium">Non-null</th>
                    <th className="px-3 py-2 text-right font-medium">Unique</th>
                    <th className="px-3 py-2 font-medium">Sample</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.schema.map((s) => (
                    <tr key={s.column} className="border-t border-border/60">
                      <td className="px-3 py-1.5 font-mono">{s.column}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{s.dtype}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(s.nonNull)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(s.unique)}</td>
                      <td className="px-3 py-1.5 font-mono text-muted-foreground">{s.sample ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Schema unavailable.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
