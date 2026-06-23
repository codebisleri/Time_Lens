"use client";

import { Fragment, useMemo, useState } from "react";
import { Check, ChevronDown, HelpCircle, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatDate, formatNumber } from "@/lib/utils/format";
import { isRealHoliday } from "@/lib/utils/holidays";
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

  // Task 2 — anomaly confidence score, computed frontend-side from how far each
  // flagged point deviates from the series mean (z-score → 0..1). No backend /
  // API change; complements the backend's IsolationForest detection by scoring
  // spike / drop severity (≈4σ ⇒ ~1.0).
  const stats = useMemo(() => {
    const vals = initialSeries
      .map((p) => p.value)
      .filter((v): v is number => v != null && Number.isFinite(v));
    const n = vals.length;
    const mean = n ? vals.reduce((a, b) => a + b, 0) / n : 0;
    const std = n > 1 ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
    return { mean, std };
  }, [initialSeries]);
  const confidenceOf = (value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value) || stats.std <= 0) return null;
    const z = Math.abs((value - stats.mean) / stats.std);
    return Math.max(0, Math.min(0.99, z / 4));
  };

  // Task 3 — per-row "Why was this flagged?" explanation, assembled ENTIRELY from
  // values already computed above (no re-detection, no new model, no API call).
  // It narrates the existing IsolationForest output, the z-score severity, the
  // deviation from the mean, and the holiday-awareness check.
  const [explained, setExplained] = useState<Set<number>>(new Set());
  const toggleExplain = (i: number) =>
    setExplained((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const explainOf = (r: Row) => {
    const value = r.value;
    const score = confidenceOf(value);
    const holiday = isRealHoliday(r.date, r.isHoliday);
    const reasons: string[] = [];

    // Deviation from the expected (mean) range.
    if (value != null && Number.isFinite(value) && stats.mean) {
      const pct = Math.round(((value - stats.mean) / stats.mean) * 100);
      const dir = pct >= 0 ? "above" : "below";
      reasons.push(
        `Demand was ${Math.abs(pct)}% ${dir} the expected range (typical ≈ ${formatNumber(stats.mean, { maximumFractionDigits: 0 })}).`,
      );
    }

    // IsolationForest is the backend detector that surfaced this row.
    reasons.push("Isolation Forest flagged this point — its anomaly score exceeded the detection threshold.");

    // z-score severity (rolling deviation).
    if (value != null && Number.isFinite(value) && stats.std > 0) {
      const z = Math.abs((value - stats.mean) / stats.std);
      reasons.push(`Rolling demand deviation detected (${z.toFixed(1)}σ from the mean).`);
    }

    // Holiday-aware check (weekends are not holidays — see isRealHoliday).
    if (holiday) {
      reasons.push("A holiday falls on this date — the demand change may be caused by a holiday.");
    } else {
      reasons.push("No holiday impact found — demand deviates from the expected seasonal behaviour.");
    }

    return { reasons, score, recommendation: r.suggestedAction };
  };

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
                      <th className="px-3 py-2 text-left font-medium">Confidence</th>
                      <th className="px-3 py-2 text-left font-medium">Is Holiday</th>
                      <th className="px-3 py-2 text-left font-medium">Suggested Action</th>
                      <th className="px-3 py-2 text-center font-medium">Why?</th>
                      <th className="px-3 py-2 text-center font-medium">Correct Anomaly</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <Fragment key={`${r.date}-${i}`}>
                      <tr className="border-t border-border/60">
                        <td className="px-3 py-2">{r.date ? formatDate(r.date) : "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.value != null ? formatNumber(r.value, { maximumFractionDigits: 0 }) : "—"}
                        </td>
                        <td className="px-3 py-2">
                          {(() => {
                            const score = confidenceOf(r.value);
                            if (score == null) return <span className="text-muted-foreground">—</span>;
                            const level = score >= 0.75 ? "High" : score >= 0.5 ? "Medium" : "Low";
                            const tone =
                              score >= 0.75
                                ? "bg-destructive/10 text-destructive"
                                : score >= 0.5
                                  ? "bg-warning/10 text-warning"
                                  : "bg-secondary text-muted-foreground";
                            return (
                              <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs", tone)}>
                                {level} anomaly
                                <span className="tabular-nums opacity-80">{score.toFixed(2)}</span>
                              </span>
                            );
                          })()}
                        </td>
                        <td className="px-3 py-2">
                          {(() => {
                            // Task 2 — weekends are NOT holidays even if the
                            // backend flagged them.
                            const holiday = isRealHoliday(r.date, r.isHoliday);
                            return (
                              <span
                                className={cn(
                                  "rounded px-1.5 py-0.5 text-xs",
                                  holiday
                                    ? "bg-success/10 text-success"
                                    : "bg-secondary text-muted-foreground",
                                )}
                              >
                                {holiday ? "Yes" : "No"}
                              </span>
                            );
                          })()}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{r.suggestedAction}</td>
                        <td className="px-3 py-2 text-center">
                          <button
                            type="button"
                            onClick={() => toggleExplain(i)}
                            aria-expanded={explained.has(i)}
                            className={cn(
                              "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium transition-colors",
                              explained.has(i)
                                ? "border-primary/40 bg-primary/10 text-primary"
                                : "border-border text-muted-foreground hover:bg-secondary",
                            )}
                          >
                            <HelpCircle className="size-3" />
                            Explain
                            <ChevronDown
                              className={cn(
                                "size-3 transition-transform",
                                explained.has(i) && "rotate-180",
                              )}
                            />
                          </button>
                        </td>
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
                      {explained.has(i) ? (
                        <tr className="border-t border-border/40 bg-secondary/20">
                          <td colSpan={7} className="px-3 py-3">
                            {(() => {
                              const ex = explainOf(r);
                              return (
                                <div className="space-y-2 text-xs">
                                  <p className="font-semibold text-foreground">
                                    This point was flagged because:
                                  </p>
                                  <ul className="space-y-1">
                                    {ex.reasons.map((reason, k) => (
                                      <li key={k} className="flex gap-2 text-muted-foreground">
                                        <span
                                          className="mt-[5px] size-1 shrink-0 rounded-full bg-warning"
                                          aria-hidden
                                        />
                                        <span>{reason}</span>
                                      </li>
                                    ))}
                                  </ul>
                                  <div className="flex flex-wrap gap-x-6 gap-y-1 pt-1 text-muted-foreground">
                                    <span>
                                      <span className="font-semibold text-foreground">Confidence: </span>
                                      {ex.score != null ? ex.score.toFixed(2) : "—"}
                                    </span>
                                    <span>
                                      <span className="font-semibold text-foreground">Recommendation: </span>
                                      {ex.recommendation || "Review manually."}
                                    </span>
                                  </div>
                                </div>
                              );
                            })()}
                          </td>
                        </tr>
                      ) : null}
                      </Fragment>
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
