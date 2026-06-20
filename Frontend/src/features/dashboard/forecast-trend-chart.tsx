"use client";

import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChartBase } from "@/components/charts/echart-base";
import { useThemeMode } from "@/lib/theme/use-theme-mode";
import { readCssVar } from "@/lib/theme/theme-config";
import { formatCompact, formatDate, formatNumber } from "@/lib/utils/format";
import type { TimeSeriesDatum } from "@/types";

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/**
 * Forecast Trend — actuals (solid, area-filled) handing off to the forecast
 * (dashed). Theme-aware (colors read from CSS tokens, recomputed on mode switch),
 * smooth, animated, and responsive via EChartBase's resize observer.
 */
export function ForecastTrendChart({ data }: { data: TimeSeriesDatum[] }) {
  const { resolvedMode } = useThemeMode();

  const option = useMemo<EChartsOption>(() => {
    // resolvedMode is referenced so colors refresh when the theme toggles.
    void resolvedMode;
    const actualColor = readCssVar("--chart-1") || "#6366f1";
    const forecastColor = readCssVar("--chart-5") || "#38bdf8";

    // Defensive: never assume `data` is a populated array.
    const rows = Array.isArray(data) ? data : [];
    const labels = rows.map((d) =>
      formatDate(d.date, { month: "short", day: "numeric" }),
    );

    // Emit only real [label, value] points per series. Padding a smooth + area
    // line with `null` (for the region the other series owns) makes ECharts'
    // canvas area painter dereference an empty segment → "reading 'length'".
    // Filtering the nulls out keeps every series array clean and crash-proof,
    // while preserving the actual→forecast handoff visually.
    const actualPoints: [string, number][] = [];
    const forecastPoints: [string, number][] = [];
    rows.forEach((d, i) => {
      const label = labels[i] ?? "";
      const a = num(d.actual);
      const f = num(d.forecast);
      if (a != null) actualPoints.push([label, a]);
      if (f != null) forecastPoints.push([label, f]);
    });

    return {
      animationDuration: 800,
      animationEasing: "cubicOut",
      tooltip: {
        trigger: "axis",
        valueFormatter: (v) => (v == null ? "—" : formatNumber(v as number)),
      },
      legend: {
        data: ["Actual", "Forecast"],
        right: 0,
        top: 0,
        itemWidth: 14,
      },
      grid: { left: 4, right: 8, top: 36, bottom: 4, containLabel: true },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: labels,
      },
      yAxis: {
        type: "value",
        axisLabel: { formatter: (v: number) => formatCompact(v) },
      },
      series: [
        {
          name: "Actual",
          type: "line",
          smooth: true,
          showSymbol: false,
          data: actualPoints,
          lineStyle: { width: 2.5, color: actualColor },
          itemStyle: { color: actualColor },
          areaStyle: {
            opacity: 0.18,
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: actualColor },
                { offset: 1, color: "transparent" },
              ],
            },
          },
        },
        {
          name: "Forecast",
          type: "line",
          smooth: true,
          showSymbol: false,
          data: forecastPoints,
          lineStyle: { width: 2.5, type: "dashed", color: forecastColor },
          itemStyle: { color: forecastColor },
        },
      ],
    };
  }, [data, resolvedMode]);

  return <EChartBase option={option} height={320} />;
}
