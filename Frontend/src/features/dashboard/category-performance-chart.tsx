"use client";

import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChartBase } from "@/components/charts/echart-base";
import { useThemeMode } from "@/lib/theme/use-theme-mode";
import { readCssVar } from "@/lib/theme/theme-config";
import { formatCompact, formatNumber } from "@/lib/utils/format";
import type { CategoryDatum } from "./hooks/use-category-performance";

/**
 * Category Performance — forecast volume by category as a gradient bar chart.
 * Theme-aware, animated entry, responsive.
 */
export function CategoryPerformanceChart({ data }: { data: CategoryDatum[] }) {
  const { resolvedMode } = useThemeMode();

  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const top = readCssVar("--chart-1") || "#6366f1";
    const bottom = readCssVar("--chart-2") || "#2dd4bf";

    // Defensive: tolerate an undefined/empty data prop.
    const rows = Array.isArray(data) ? data : [];

    return {
      animationDuration: 700,
      animationEasing: "cubicOut",
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        valueFormatter: (v) => formatNumber(v as number),
      },
      grid: { left: 4, right: 8, top: 16, bottom: 4, containLabel: true },
      xAxis: {
        type: "category",
        data: rows.map((d) => d.category),
        axisTick: { show: false },
      },
      yAxis: {
        type: "value",
        axisLabel: { formatter: (v: number) => formatCompact(v) },
      },
      series: [
        {
          name: "Forecast units",
          type: "bar",
          barWidth: "52%",
          data: rows.map((d) => d.units),
          itemStyle: {
            borderRadius: [6, 6, 0, 0],
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: top },
                { offset: 1, color: bottom },
              ],
            },
          },
        },
      ],
    };
  }, [data, resolvedMode]);

  return <EChartBase option={option} height={320} />;
}
