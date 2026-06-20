"use client";

import { useMemo } from "react";
import { Trophy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ForecastTrendBandChart } from "@/features/forecast/forecast-trend-band-chart";
import type { ForecastBandPoint } from "@/features/forecast/hooks/use-forecast-trend";
import type { SingleSkuResult } from "@/types/forecast";

const pct = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)}%`);
const num = (v: number | null) => (v == null ? "—" : v.toFixed(2));

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </Card>
  );
}

/**
 * Single-SKU Multi-Model Competition results — mirrors the Streamlit single-series
 * tab: champion + metrics, the actual-vs-forecast chart with 95% CI band, the
 * model competition/ranking table, and the narrative summary.
 */
export function SingleSkuResultsPanel({ result }: { result: SingleSkuResult }) {
  const band: ForecastBandPoint[] = useMemo(
    () =>
      (Array.isArray(result.series) ? result.series : []).map((p) => ({
        date: p.date,
        actual: p.actual ?? null,
        forecast: p.forecast ?? null,
        lower: p.lower ?? null,
        upper: p.upper ?? null,
      })),
    [result.series],
  );

  return (
    <div className="space-y-6">
      {/* Champion + metrics */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card className="p-4">
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Trophy className="size-4 text-primary" /> Champion
          </p>
          <p className="mt-1 text-lg font-semibold">{result.championModel}</p>
          {result.errorCorrectionApplied ? (
            <Badge variant="secondary" className="mt-1">XGBoost error-corrected</Badge>
          ) : null}
        </Card>
        <Kpi label="Train WMAPE" value={pct(result.trainWmape)} hint="in-sample fit" />
        <Kpi label="Test WMAPE" value={pct(result.testWmape)} hint="out-of-sample" />
        <Kpi label="Forecast horizon" value={`${result.periods}`} hint={`SKU ${result.sku}`} />
      </div>

      {/* Forecast chart */}
      <Card>
        <CardContent className="space-y-2 pt-6">
          <h3 className="text-sm font-medium text-foreground">
            Actual vs forecast (95% CI)
          </h3>
          {band.length ? (
            <ForecastTrendBandChart data={band} />
          ) : (
            <p className="text-sm text-muted-foreground">No series available.</p>
          )}
        </CardContent>
      </Card>

      {/* Ranking / competition table */}
      <Card>
        <CardContent className="pt-6">
          <h3 className="mb-3 text-sm font-medium text-foreground">Model competition</h3>
          <div className="overflow-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-secondary/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Model</th>
                  <th className="px-3 py-2 text-right font-medium">Train WMAPE</th>
                  <th className="px-3 py-2 text-right font-medium">Train RMSE</th>
                  <th className="px-3 py-2 text-right font-medium">Test WMAPE</th>
                  <th className="px-3 py-2 text-right font-medium">Test RMSE</th>
                </tr>
              </thead>
              <tbody>
                {result.ranking.map((r) => (
                  <tr
                    key={r.model}
                    className={cn("border-t border-border/60", r.isChampion && "bg-primary/5")}
                  >
                    <td className="px-3 py-1.5">
                      {r.isChampion ? "⭐ " : ""}
                      {r.model}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{pct(r.trainWmape)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{num(r.trainRmse)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{pct(r.testWmape)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{num(r.testRmse)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Narrative */}
      {result.narrative ? (
        <Card>
          <CardContent className="pt-6">
            <p className="whitespace-pre-line text-sm text-muted-foreground">
              {result.narrative}
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
