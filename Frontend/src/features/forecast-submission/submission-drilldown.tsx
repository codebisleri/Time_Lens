"use client";

import { useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import { Card, CardContent } from "@/components/ui/card";
import { EChartBase } from "@/components/charts/echart-base";
import { useThemeMode } from "@/lib/theme/use-theme-mode";
import { readCssVar } from "@/lib/theme/theme-config";
import { Field, Select } from "@/features/data/controls";
import { formatDate, formatNumber } from "@/lib/utils/format";
import { useForecastLevel } from "@/lib/stores/forecast-level-store";
import type { SubmissionRow } from "@/types/submission";

function num(v: number | null): string {
  return v == null || !Number.isFinite(v) ? "—" : formatNumber(Math.round(v));
}

/**
 * Per-SKU drill-down — mirrors the Streamlit submission chart: model vs the
 * planner's submitted forecast vs last-year-same-month, across the horizon, with
 * a summary of the override impact for the selected SKU.
 */
export function SubmissionDrilldown({ rows }: { rows: SubmissionRow[] }) {
  const { resolvedMode } = useThemeMode();
  const { label: levelLabel } = useForecastLevel();
  const skus = useMemo(
    () => Array.from(new Set((Array.isArray(rows) ? rows : []).map((r) => r.sku))).sort(),
    [rows],
  );
  const [sku, setSku] = useState(skus[0] ?? "");
  const active = sku || skus[0] || "";

  const skuRows = useMemo(
    () =>
      (Array.isArray(rows) ? rows : [])
        .filter((r) => r.sku === active)
        .sort((a, b) => a.forecastMonth.localeCompare(b.forecastMonth)),
    [rows, active],
  );

  const totals = useMemo(() => {
    let model = 0;
    let submitted = 0;
    let overridden = 0;
    for (const r of skuRows) {
      model += r.modelForecast;
      submitted += r.submittedForecast;
      if (r.submittedForecast !== r.modelForecast) overridden += 1;
    }
    const deltaPct = model > 0 ? ((submitted - model) / model) * 100 : 0;
    return { model, submitted, overridden, deltaPct, wmape: skuRows[0]?.mape ?? null };
  }, [skuRows]);

  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    // §6 — explicit, high-contrast, theme-stable series colors so Model /
    // Submitted / LY-same-month are always clearly visible (they were washing out
    // against the background, and the LY line was being drawn with width 0).
    // F.16 — navy/orange/neutral only: Model = muted neutral, Submitted = orange,
    // LY = faint orange (distinguished by symbol/dash, not a new hue).
    const modelColor = readCssVar("--muted-foreground") || "#8d99a6";
    const submittedColor = "#EF7602"; // brand orange
    const lyColor = "rgba(239,118,2,0.5)"; // faint orange
    const labels = skuRows.map((r) =>
      formatDate(r.forecastMonth, { month: "short", year: "numeric", day: undefined }),
    );
    return {
      animationDuration: 500,
      tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "—" : formatNumber(v as number)) },
      // §11 — legend top-LEFT so it never collides with the top-right toolbar.
      legend: { data: ["Model", "Submitted", "LY same month"], left: 0, top: 0, itemWidth: 14 },
      grid: { left: 4, right: 12, top: 40, bottom: 4, containLabel: true },
      xAxis: { type: "category", data: labels, boundaryGap: false },
      yAxis: { type: "value" },
      series: [
        {
          name: "Model",
          type: "line",
          data: skuRows.map((r) => r.modelForecast),
          lineStyle: { width: 2.5, type: "dashed", color: modelColor },
          itemStyle: { color: modelColor },
          showSymbol: false,
        },
        {
          name: "Submitted",
          type: "line",
          data: skuRows.map((r) => r.submittedForecast),
          lineStyle: { width: 3.5, color: submittedColor },
          itemStyle: { color: submittedColor },
          symbol: "circle",
          symbolSize: 7,
          showSymbol: true,
        },
        {
          name: "LY same month",
          type: "line",
          data: skuRows.map((r) => r.lastYearSameMonth),
          // Visible dashed line + diamonds (was width:0 → invisible line).
          lineStyle: { width: 2, type: "dashed", color: lyColor, opacity: 0.9 },
          itemStyle: { color: lyColor },
          symbol: "diamond",
          symbolSize: 9,
          showSymbol: true,
        },
      ],
      color: [modelColor, submittedColor, lyColor],
    };
  }, [skuRows, resolvedMode]);

  if (skus.length === 0) return null;

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <Field label={`Inspect ${levelLabel}`}>
          <Select
            value={active}
            onChange={setSku}
            options={skus.map((s) => ({ value: s, label: s }))}
            ariaLabel={`Inspect ${levelLabel}`}
          />
        </Field>

        {skuRows.length ? <EChartBase option={option} height={420} /> : null}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="Submitted (horizon)" value={num(totals.submitted)} />
          <Metric
            label="Model (horizon)"
            value={num(totals.model)}
            sub={`${totals.deltaPct > 0 ? "+" : ""}${totals.deltaPct.toFixed(1)}% vs model`}
          />
          <Metric label="Months overridden" value={String(totals.overridden)} />
          <Metric
            label="Backtest WMAPE"
            value={totals.wmape == null ? "—" : `${totals.wmape.toFixed(1)}%`}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</p>
      {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}
