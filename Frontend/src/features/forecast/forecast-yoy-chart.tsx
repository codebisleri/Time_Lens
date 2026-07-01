"use client";

import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChartBase } from "@/components/charts/echart-base";
import { useThemeMode } from "@/lib/theme/use-theme-mode";
import { chartColors } from "@/lib/charts/colors";
import { formatNumber } from "@/lib/utils/format";

/**
 * Phase X.I · Tasks 1-3 — Year-over-Year trend view for the Forecast
 * Interpretation panel. Overlays one line per calendar year on a Jan→Dec axis,
 * using the SAME forecast-detail series the panel reads (no recalculation, no
 * new forecasting — visualization only):
 *   • each historical year = a solid line of its ACTUALS
 *   • the current year (latest with actuals) is highlighted (thicker)
 *   • forecast months = a DASHED continuation line with markers
 *   • missing months stay null (connectNulls:false → no interpolation)
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Issue 4 — year/current/forecast colours are resolved from the theme palette at
// render time (see the option memo) so they track Light/Dark; no hardcoded hex.

interface SeriesPoint {
  date: string;
  actual?: number | null;
  forecast?: number | null;
}

export function ForecastYoYChart({
  series,
  height = 320,
}: {
  series: SeriesPoint[];
  height?: number;
}) {
  const { resolvedMode } = useThemeMode();

  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const c = chartColors();
    const YEAR_COLORS = c.palette; // historical years (oldest→newer)
    const CURRENT_COLOR = c.primary; // highlighted current year (navy)
    const FORECAST_COLOR = c.accent; // dashed forecast continuation (orange)
    const rows = Array.isArray(series) ? series : [];
    const byYear = new Map<number, { actual: (number | null)[]; forecast: (number | null)[] }>();
    for (const p of rows) {
      const m = /^(\d{4})-(\d{2})/.exec(p.date);
      if (!m) continue;
      const y = Number(m[1]);
      const mi = Number(m[2]) - 1;
      if (mi < 0 || mi > 11) continue;
      if (!byYear.has(y)) {
        byYear.set(y, { actual: new Array(12).fill(null), forecast: new Array(12).fill(null) });
      }
      const rec = byYear.get(y)!;
      if (p.actual != null && Number.isFinite(p.actual)) rec.actual[mi] = p.actual as number;
      if (p.forecast != null && Number.isFinite(p.forecast)) rec.forecast[mi] = p.forecast as number;
    }

    const years = [...byYear.keys()].sort((a, b) => a - b);
    // Show at most the last 5 years to avoid clutter.
    const shown = years.slice(-5);
    const currentYear = years.filter((y) => byYear.get(y)!.actual.some((v) => v != null)).pop() ?? null;

    const echSeries: NonNullable<EChartsOption["series"]> = [];
    const legend: string[] = [];

    shown.forEach((y, idx) => {
      const rec = byYear.get(y)!;
      const isCurrent = y === currentYear;
      const color = isCurrent ? CURRENT_COLOR : YEAR_COLORS[idx % YEAR_COLORS.length];
      if (rec.actual.some((v) => v != null)) {
        legend.push(String(y));
        echSeries.push({
          name: String(y),
          type: "line",
          data: rec.actual,
          connectNulls: false, // no interpolation across missing months
          showSymbol: true,
          symbolSize: isCurrent ? 6 : 4,
          smooth: false,
          lineStyle: { width: isCurrent ? 3 : 1.6, color },
          itemStyle: { color },
          z: isCurrent ? 4 : 3,
        });
      }
      // Forecast continuation for any year that has forecast values (dashed).
      if (rec.forecast.some((v) => v != null)) {
        const fname = `${y} (forecast)`;
        legend.push(fname);
        echSeries.push({
          name: fname,
          type: "line",
          data: rec.forecast,
          connectNulls: false,
          showSymbol: true,
          symbol: "diamond",
          symbolSize: 7,
          smooth: false,
          lineStyle: { width: 2, type: "dashed", color: FORECAST_COLOR },
          itemStyle: { color: FORECAST_COLOR },
          z: 5,
        });
      }
    });

    return {
      animationDuration: 500,
      tooltip: {
        trigger: "axis",
        valueFormatter: (v) => (v == null ? "—" : formatNumber(v as number)),
      },
      legend: { top: 0, left: "center", itemWidth: 14, data: legend },
      grid: { left: 4, right: 8, top: 32, bottom: 4, containLabel: true },
      xAxis: { type: "category", boundaryGap: false, data: MONTHS },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => formatNumber(v) } },
      series: echSeries,
    };
  }, [series, resolvedMode]);

  return <EChartBase option={option} height={height} />;
}
