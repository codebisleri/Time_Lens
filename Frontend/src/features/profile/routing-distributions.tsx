"use client";

import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChartBase } from "@/components/charts/echart-base";
import { useThemeMode } from "@/lib/theme/use-theme-mode";
import { formatNumber } from "@/lib/utils/format";
import type { IntermittencyDistItem, SegmentSummary, StrategyDistItem } from "@/types/segmentation";

/** SKU Distribution by Segment — vertical bars of SKU counts per business
 *  segment (Stable/Volatile × High/Mid/Low + lifecycle), colored by segment. */
export function SegmentDistributionChart({
  data,
  skus = [],
  height = 320,
  levelPlural = "SKUs",
}: {
  data: SegmentSummary[];
  /** Per-SKU segment membership — used to list SKU names in the tooltip. */
  skus?: { sku: string; segment: string }[];
  height?: number;
  /** Dynamic forecast-level term for axis/tooltip labels (Task 8). */
  levelPlural?: string;
}) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const rows = [...(Array.isArray(data) ? data : [])].sort((a, b) => b.skuCount - a.skuCount);
    // Task 5 — SKU names per segment for the hover tooltip (cap 20, then "+N more").
    const bySegment = new Map<string, string[]>();
    for (const s of skus) {
      if (!bySegment.has(s.segment)) bySegment.set(s.segment, []);
      bySegment.get(s.segment)!.push(s.sku);
    }
    const MAX = 20;
    return {
      animationDuration: 500,
      grid: { left: 4, right: 16, top: 16, bottom: 4, containLabel: true },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (params: unknown) => {
          const p = (Array.isArray(params) ? params[0] : params) as { name?: string; value?: number };
          const seg = p?.name ?? "";
          const names = bySegment.get(seg) ?? [];
          const shown = names.slice(0, MAX);
          const more = names.length - shown.length;
          const list = shown.length
            ? shown.map((n) => `<div style="font-family:monospace;font-size:11px">${n}</div>`).join("") +
              (more > 0 ? `<div style="font-size:11px;opacity:.7">+${more} more</div>` : "")
            : "";
          return (
            `<div style="font-weight:600">Segment: ${seg}</div>` +
            `<div style="margin-bottom:4px">${levelPlural}: <b>${formatNumber((p?.value as number) ?? names.length)}</b></div>` +
            list
          );
        },
      },
      xAxis: {
        type: "category",
        data: rows.map((d) => d.segment),
        axisLabel: { interval: 0, rotate: 28, fontSize: 10 },
        axisTick: { show: false },
      },
      yAxis: { type: "value", name: `Number of ${levelPlural}`, nameLocation: "middle", nameGap: 40 },
      series: [{
        type: "bar", barWidth: "55%",
        data: rows.map((d) => ({ value: d.skuCount, itemStyle: { color: d.color ?? "#64748b" } })),
        label: { show: true, position: "top", formatter: (p) => formatNumber(p.value as number) },
        itemStyle: { borderRadius: [4, 4, 0, 0] },
      }],
    };
  }, [data, skus, resolvedMode, levelPlural]);
  return <EChartBase option={option} height={height} />;
}

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
