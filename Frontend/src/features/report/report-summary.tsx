"use client";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils/format";
import { useForecastLevel } from "@/lib/stores/forecast-level-store";
import type { ReportSummary } from "@/types/report";

function Tile({ label, value, meta }: { label: string; value: string; meta?: string }) {
  return (
    <Card className="p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-foreground">
        {value}
      </p>
      {meta ? <p className="mt-1 text-xs text-muted-foreground">{meta}</p> : null}
    </Card>
  );
}

function pct(v: number | null): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`;
}

const BAND_TEXT: Record<string, string> = {
  Good: "text-success",
  Review: "text-warning",
  Poor: "text-destructive",
};

/** Executive summary, forecast headline, segment mix, and top opportunities. */
export function ReportSummaryPanel({ summary }: { summary: ReportSummary }) {
  const { dataset, forecast, segments, topOpportunities } = summary;
  const { label: levelLabel, plural: levelPlural } = useForecastLevel();
  const dateRange =
    dataset.dateStart && dataset.dateEnd
      ? `${dataset.dateStart} → ${dataset.dateEnd}`
      : "—";
  const maxSeg = Math.max(1, ...segments.distribution.map((s) => s.skuCount));

  return (
    <div className="space-y-6">
      {/* Executive summary */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile
          label={`Portfolio ${levelPlural}`}
          value={formatNumber(dataset.skuCount ?? 0)}
          meta={`${formatNumber(dataset.rowCount ?? 0)} rows`}
        />
        <Tile label="History span" value={dateRange} />
        <Tile
          label={`${levelPlural} forecasted`}
          value={formatNumber(forecast.skusForecasted)}
          meta={
            forecast.runId
              ? `${formatNumber(forecast.bands.Good ?? 0)} good · ${formatNumber(
                  forecast.bands.Review ?? 0,
                )} review · ${formatNumber(forecast.bands.Poor ?? 0)} poor`
              : "No forecast run yet"
          }
        />
        <Tile
          label="Median test WMAPE"
          value={pct(forecast.medianTestWmape)}
          meta={`${formatNumber(Math.round(forecast.totalForecastUnits ?? 0))} forecast units`}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Segment summary */}
        <Card>
          <CardContent className="space-y-3 pt-6">
            <h3 className="text-sm font-medium text-foreground">
              Segment summary
            </h3>
            {segments.distribution.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No segmentation available.
              </p>
            ) : (
              <div className="space-y-2">
                {segments.distribution.map((s) => (
                  <div key={s.segment} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-foreground">{s.segment}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {formatNumber(s.skuCount)}
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${(s.skuCount / maxSeg) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top opportunities */}
        <Card>
          <CardContent className="space-y-3 pt-6">
            <h3 className="text-sm font-medium text-foreground">
              Top opportunities
            </h3>
            <p className="text-xs text-muted-foreground">
              Highest-volume {levelPlural} to prioritise in the demand plan.
            </p>
            {topOpportunities.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Run a forecast to surface opportunities.
              </p>
            ) : (
              <div className="max-h-72 overflow-auto rounded-lg border border-border">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-border bg-card">
                      <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                        {levelLabel}
                      </th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">
                        Forecast
                      </th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">
                        WMAPE
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {topOpportunities.map((o) => (
                      <tr
                        key={o.sku}
                        className="border-b border-border/60 last:border-0"
                      >
                        <td className="px-3 py-2 text-sm">
                          <span className="font-mono text-xs font-medium text-foreground">
                            {o.sku}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-sm tabular-nums">
                          {formatNumber(Math.round(o.forecastTotal ?? 0))}
                        </td>
                        <td
                          className={cn(
                            "px-3 py-2 text-right text-sm tabular-nums",
                            BAND_TEXT[o.band] ?? "text-foreground",
                          )}
                        >
                          {pct(o.wmape)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
