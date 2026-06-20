"use client";

import { useMemo, useState } from "react";
import { Check, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatDate, formatNumber } from "@/lib/utils/format";
import { edaService } from "@/lib/api/services/eda.service";
import type { EdaCorrectedAnomaly, EdaOutlier, EdaSeriesPoint } from "@/types/eda";
import { EdaAnomalyChart } from "./eda-charts";

type Row = EdaOutlier & { correct: boolean };

/**
 * Editable anomaly-correction table — mirrors the Streamlit `st.data_editor`
 * workflow: review IsolationForest anomalies, toggle "Correct Anomaly", then
 * "Apply edits" to recompute the cleaned series (14-period rolling-mean swap).
 * The summary card ("Identified X… Y corrected") is always shown.
 */
export function EdaAnomalyEditor({
  datasetId,
  sku,
  outliers,
  initialSeries,
}: {
  datasetId: string;
  sku: string | null;
  outliers: { count: number; points: EdaOutlier[] };
  initialSeries: EdaSeriesPoint[];
}) {
  const initialRows = useMemo<Row[]>(
    () => outliers.points.map((p) => ({ ...p, correct: p.correctAnomaly })),
    [outliers.points],
  );
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [applying, setApplying] = useState(false);
  const [cleaned, setCleaned] = useState<EdaSeriesPoint[] | null>(null);
  const [corrected, setCorrected] = useState<EdaCorrectedAnomaly[]>([]);
  const [appliedCount, setAppliedCount] = useState<number | null>(null);

  const flaggedCount = rows.filter((r) => r.correct).length;
  const totalPotential = outliers.count;
  // Before any apply, the summary reflects the default decisions; after, the
  // server-confirmed corrected count.
  const summaryCorrected = appliedCount ?? flaggedCount;

  const toggle = (i: number) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, correct: !r.correct } : r)));

  const apply = async () => {
    setApplying(true);
    try {
      const res = await edaService.applyAnomalies({
        datasetId,
        sku,
        corrections: rows
          .filter((r) => r.date)
          .map((r) => ({ date: r.date as string, correct: r.correct })),
      });
      setCleaned(res.series);
      setCorrected(res.correctedAnomalies);
      setAppliedCount(res.summary.correctedCount);
    } catch {
      /* keep the prior view; the table stays editable */
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Anomaly summary card */}
      <div className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm text-foreground">
        <TriangleAlert className="size-4 shrink-0 text-warning" />
        <span>
          Identified <span className="font-semibold">{formatNumber(totalPotential)}</span> potential
          anomalies (IsolationForest, holiday-aware);{" "}
          <span className="font-semibold">{formatNumber(summaryCorrected)}</span> flagged for
          correction.
        </span>
      </div>

      {totalPotential === 0 ? (
        <p className="text-sm text-muted-foreground">No anomalies detected.</p>
      ) : (
        <>
          {/* Editable table */}
          <Card className="p-0">
            <CardContent className="p-0">
              <div className="max-h-80 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-secondary/40 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Date</th>
                      <th className="px-3 py-2 text-right font-medium">Value</th>
                      <th className="px-3 py-2 text-left font-medium">Is Holiday</th>
                      <th className="px-3 py-2 text-left font-medium">Suggested Action</th>
                      <th className="px-3 py-2 text-center font-medium">Correct Anomaly</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={`${r.date}-${i}`} className="border-t border-border/60">
                        <td className="px-3 py-2">{r.date ? formatDate(r.date) : "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.value != null ? formatNumber(r.value, { maximumFractionDigits: 0 }) : "—"}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={cn(
                              "rounded px-1.5 py-0.5 text-xs",
                              r.isHoliday
                                ? "bg-success/10 text-success"
                                : "bg-secondary text-muted-foreground",
                            )}
                          >
                            {r.isHoliday ? "Yes" : "No"}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{r.suggestedAction}</td>
                        <td className="px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={r.correct}
                            onChange={() => toggle(i)}
                            className="size-4 cursor-pointer accent-primary"
                            aria-label={`Correct anomaly on ${r.date ? formatDate(r.date) : "row"}`}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Button onClick={apply} disabled={applying} variant="outline">
            <Check className="size-4" /> Apply edits
          </Button>

          {/* Result: cleaned series + corrected markers */}
          {cleaned ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Applied — <span className="font-medium text-foreground">{formatNumber(appliedCount ?? 0)}</span>{" "}
                anomal{(appliedCount ?? 0) === 1 ? "y" : "ies"} replaced with the 14-period rolling mean.
              </p>
              <Card>
                <CardContent className="pt-6">
                  <EdaAnomalyChart series={cleaned} anomalies={corrected.map((c) => ({ date: c.date, value: c.original }))} />
                </CardContent>
              </Card>
            </div>
          ) : (
            <Card>
              <CardContent className="pt-6">
                <EdaAnomalyChart series={initialSeries} anomalies={outliers.points} />
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
