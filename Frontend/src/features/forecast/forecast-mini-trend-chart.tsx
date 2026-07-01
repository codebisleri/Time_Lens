"use client";

import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChartBase } from "@/components/charts/echart-base";
import { useThemeMode } from "@/lib/theme/use-theme-mode";
import { readCssVar } from "@/lib/theme/theme-config";
import { formatCompact, formatDate, formatNumber } from "@/lib/utils/format";
import type { ForecastPoint } from "@/types/forecast";

/**
 * Compact actual-vs-forecast spark used inside the detail drawer's history
 * section. Same theme-aware, responsive base as the page charts, trimmed for a
 * dense panel.
 */
export function ForecastMiniTrendChart({
  series,
  height = 168,
}: {
  series: ForecastPoint[];
  height?: number;
}) {
  const { resolvedMode } = useThemeMode();

  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const actualColor = readCssVar("--chart-1") || "#6366f1";
    const forecastColor = readCssVar("--chart-5") || "#38bdf8";

    const rows = (Array.isArray(series) ? series : []).filter(
      (d) => d != null && typeof d.date === "string",
    );
    const labels = rows.map((d) =>
      formatDate(d.date, { month: "short", year: "2-digit", day: undefined }),
    );
    // Emit only finite, non-stacked [label, value] points so the line/area
    // painter and animator never see undefined/null segments.
    const actual: [string, number][] = [];
    const forecast: [string, number][] = [];
    rows.forEach((d, i) => {
      const label = labels[i] ?? "";
      if (Number.isFinite(d.actual)) actual.push([label, d.actual as number]);
      if (Number.isFinite(d.forecast))
        forecast.push([label, d.forecast as number]);
    });

    // Task 2 — bridge the actual→forecast handoff: seed the dashed forecast line
    // with the LAST actual point so it connects smoothly (no visible gap). Only
    // when they don't already share the boundary. Dashed styling is preserved
    // (same series); the forecast values themselves are unchanged.
    const lastActual = actual[actual.length - 1];
    const firstForecast = forecast[0];
    if (lastActual && firstForecast && lastActual[0] !== firstForecast[0]) {
      forecast.unshift(lastActual);
    }

    return {
      animationDuration: 600,
      animationEasing: "cubicOut",
      tooltip: {
        trigger: "axis",
        valueFormatter: (v) => (v == null ? "—" : formatNumber(v as number)),
      },
      legend: { data: ["Actual", "Forecast"], right: 0, top: 0, itemWidth: 12 },
      grid: { left: 0, right: 4, top: 28, bottom: 0, containLabel: true },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: labels,
        axisLabel: { show: false },
      },
      yAxis: {
        type: "value",
        axisLabel: { formatter: (v: number) => formatCompact(v), fontSize: 10 },
      },
      series: [
        {
          name: "Actual",
          type: "line",
          // Task 10 — monotone-x smoothing keeps the curve from overshooting at
          // the actual→forecast handoff, so the join reads as one continuous
          // sweep (no pointed/angular kink). Values are unchanged.
          smooth: true,
          smoothMonotone: "x",
          showSymbol: false,
          data: actual,
          lineStyle: { width: 2, color: actualColor },
          itemStyle: { color: actualColor },
        },
        {
          name: "Forecast",
          type: "line",
          smooth: true,
          smoothMonotone: "x",
          showSymbol: false,
          data: forecast,
          lineStyle: { width: 2, type: "dashed", color: forecastColor },
          itemStyle: { color: forecastColor },
        },
      ],
    };
  }, [series, resolvedMode]);

  return <EChartBase option={option} height={height} slider />;
}
