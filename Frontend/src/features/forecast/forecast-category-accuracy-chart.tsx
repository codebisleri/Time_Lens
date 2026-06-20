"use client";

import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChartBase } from "@/components/charts/echart-base";
import { useThemeMode } from "@/lib/theme/use-theme-mode";
import { readCssVar } from "@/lib/theme/theme-config";
import { formatPercent } from "@/lib/utils/format";

export interface CategoryAccuracyDatum {
  category: string;
  accuracy: number;
}

/**
 * Accuracy by category — a horizontal bar chart sorted so the top-performing
 * categories sit at the top and the lowest at the bottom. Each bar is tinted by
 * its health band (green / amber / red). Theme-aware, animated, responsive.
 */
export function ForecastCategoryAccuracyChart({
  data,
  height = 300,
}: {
  data: CategoryAccuracyDatum[];
  height?: number;
}) {
  const { resolvedMode } = useThemeMode();

  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const success = readCssVar("--success") || "#22c55e";
    const warning = readCssVar("--warning") || "#f59e0b";
    const destructive = readCssVar("--destructive") || "#ef4444";

    // Guard against undefined/null entries and non-finite accuracy so every
    // bar value is a real number before it reaches the animator.
    const rows = (Array.isArray(data) ? data : []).filter(
      (d) => d != null && Number.isFinite(d.accuracy),
    );
    // Ascending so the highest accuracy renders at the top of the value axis.
    const sorted = [...rows].sort((a, b) => a.accuracy - b.accuracy);
    const colorFor = (acc: number) =>
      acc >= 0.9 ? success : acc >= 0.8 ? warning : destructive;

    return {
      animationDuration: 700,
      animationEasing: "cubicOut",
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        valueFormatter: (v) => formatPercent(v as number),
      },
      grid: { left: 4, right: 24, top: 8, bottom: 4, containLabel: true },
      xAxis: {
        type: "value",
        min: 0,
        max: 1,
        axisLabel: { formatter: (v: number) => formatPercent(v, 0) },
      },
      yAxis: {
        type: "category",
        data: sorted.map((d) => d.category),
        axisTick: { show: false },
      },
      series: [
        {
          name: "Accuracy",
          type: "bar",
          barWidth: "56%",
          data: sorted.map((d) => ({
            value: d.accuracy,
            itemStyle: {
              color: colorFor(d.accuracy),
              borderRadius: [0, 6, 6, 0],
            },
          })),
          label: {
            show: true,
            position: "right",
            formatter: (p) =>
              formatPercent(typeof p.value === "number" ? p.value : 0),
            // A concrete token color (not "inherit") so the label color is never
            // handed to the color interpolator as an unparseable literal.
            color: readCssVar("--foreground") || "#0f172a",
            fontSize: 11,
            fontWeight: 500,
          },
        },
      ],
    };
  }, [data, resolvedMode]);

  return <EChartBase option={option} height={height} />;
}
