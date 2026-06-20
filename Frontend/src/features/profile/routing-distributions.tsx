"use client";

import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChartBase } from "@/components/charts/echart-base";
import { useThemeMode } from "@/lib/theme/use-theme-mode";
import { formatNumber } from "@/lib/utils/format";
import type { IntermittencyDistItem, StrategyDistItem } from "@/types/segmentation";

/** Recommended forecasting strategy — horizontal bar of SKU counts per strategy. */
export function StrategyDistributionChart({
  data,
  height = 320,
}: {
  data: StrategyDistItem[];
  height?: number;
}) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    // ECharts y-axis category renders bottom-up; reverse so the biggest is on top.
    const rows = [...(Array.isArray(data) ? data : [])].reverse();
    return {
      animationDuration: 500,
      grid: { left: 4, right: 24, top: 8, bottom: 4, containLabel: true },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" },
        valueFormatter: (v) => formatNumber(v as number) },
      xAxis: { type: "value" },
      yAxis: { type: "category", data: rows.map((d) => d.label), axisTick: { show: false } },
      series: [{
        type: "bar", barWidth: "60%",
        data: rows.map((d) => ({ value: d.count, itemStyle: { color: d.color } })),
        label: { show: true, position: "right", formatter: (p) => formatNumber(p.value as number) },
        itemStyle: { borderRadius: [0, 4, 4, 0] },
      }],
    };
  }, [data, resolvedMode]);
  return <EChartBase option={option} height={height} />;
}

/** Demand pattern (intermittency) — donut of SKU counts per SBC class. */
export function IntermittencyDistributionChart({
  data,
  height = 320,
}: {
  data: IntermittencyDistItem[];
  height?: number;
}) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    return {
      animationDuration: 500,
      tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
      legend: { orient: "vertical", left: "left", top: "middle", itemWidth: 12 },
      series: [{
        type: "pie", radius: ["45%", "70%"], center: ["62%", "50%"],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: "transparent", borderWidth: 2 },
        label: { show: true, formatter: "{b}\n{c}" },
        data: (Array.isArray(data) ? data : []).map((d) => ({
          name: d.pattern, value: d.count, itemStyle: { color: d.color },
        })),
      }],
    };
  }, [data, resolvedMode]);
  return <EChartBase option={option} height={height} />;
}
