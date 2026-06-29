"use client";

import { useMemo } from "react";
import type { ECharts } from "echarts";
import type { EChartsOption } from "echarts";
import { EChartBase } from "@/components/charts/echart-base";
import { useThemeMode } from "@/lib/theme/use-theme-mode";
import { formatNumber } from "@/lib/utils/format";
import { flatDrivers } from "./explainability-helpers";
import type {
  DriverContributions,
  HorizonPeriod,
  WaterfallStep,
} from "@/types/explainability";

// Phase X.W — Explainability is forecast-level only. The portfolio DriverDonut
// (pie/circular) and SegmentComparison charts were removed; visualizations are
// limited to horizontal contribution bars, the waterfall, and the horizon stack.

const PALETTE = [
  "#2563eb", "#ea580c", "#16a34a", "#7c3aed", "#db2777",
  "#0891b2", "#ca8a04", "#4f46e5", "#0d9488", "#dc2626", "#64748b",
];

// Waterfall semantics (Task 9): positive contributions green, negative red,
// base grey, final forecast blue.
const WF_POSITIVE = "#16a34a";
const WF_NEGATIVE = "#dc2626";
const WF_BASE = "#64748b";
const WF_FINAL = "#2563eb";

type OnReady = ((chart: ECharts | null) => void) | undefined;

export function ContributionBars({
  contributions,
  height = 260,
  onReady,
}: {
  contributions: DriverContributions;
  height?: number;
  onReady?: OnReady;
}) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const drivers = flatDrivers(contributions).reverse(); // biggest on top
    return {
      animationDuration: 500,
      grid: { left: 4, right: 32, top: 8, bottom: 4, containLabel: true },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (v) => `${v}%` },
      xAxis: { type: "value", axisLabel: { formatter: "{value}%" } },
      yAxis: { type: "category", data: drivers.map((d) => d.label), axisTick: { show: false } },
      series: [
        {
          type: "bar",
          barWidth: "60%",
          data: drivers.map((d, i) => ({ value: d.pct, itemStyle: { color: PALETTE[(drivers.length - 1 - i) % PALETTE.length] } })),
          label: { show: true, position: "right", formatter: (p) => `${p.value}%` },
          itemStyle: { borderRadius: [0, 4, 4, 0] },
        },
      ],
    };
  }, [contributions, resolvedMode]);
  return <EChartBase option={option} height={height} onReady={onReady} />;
}

export function WaterfallChart({
  steps,
  height = 340,
  onReady,
}: {
  steps: WaterfallStep[];
  height?: number;
  onReady?: OnReady;
}) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const placeholder: number[] = [];
    const bars: { value: number; itemStyle: { color: string } }[] = [];
    let running = 0;
    for (const s of steps) {
      if (s.type === "base" || s.type === "total") {
        placeholder.push(0);
        bars.push({ value: s.value, itemStyle: { color: s.type === "base" ? WF_BASE : WF_FINAL } });
        running = s.value;
      } else {
        const start = s.value >= 0 ? running : running + s.value;
        placeholder.push(start);
        bars.push({ value: Math.abs(s.value), itemStyle: { color: s.value >= 0 ? WF_POSITIVE : WF_NEGATIVE } });
        running += s.value;
      }
    }
    return {
      animationDuration: 500,
      grid: { left: 4, right: 12, top: 16, bottom: 24, containLabel: true },
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const ps = params as { dataIndex: number }[];
          const i = ps?.[0]?.dataIndex ?? 0;
          const s = steps[i];
          return s ? `${s.label}: <b>${s.value >= 0 ? "+" : ""}${formatNumber(s.value)}</b>` : "";
        },
      },
      xAxis: { type: "category", data: steps.map((s) => s.label), axisLabel: { interval: 0, rotate: 28, fontSize: 10 } },
      yAxis: { type: "value" },
      series: [
        { type: "bar", stack: "wf", itemStyle: { color: "transparent" }, emphasis: { itemStyle: { color: "transparent" } }, data: placeholder, silent: true },
        { type: "bar", stack: "wf", data: bars, label: { show: true, position: "top", formatter: (p) => formatNumber(steps[p.dataIndex]?.value ?? 0) }, itemStyle: { borderRadius: [3, 3, 0, 0] } },
      ],
    };
  }, [steps, resolvedMode]);
  return <EChartBase option={option} height={height} onReady={onReady} slider />;
}

export function HorizonStacked({
  periods,
  height = 300,
  onReady,
}: {
  periods: HorizonPeriod[];
  height?: number;
  onReady?: OnReady;
}) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const hasExog = periods.some((p) => (p.exogenous ?? 0) !== 0);
    const hasResid = periods.some((p) => (p.residual ?? 0) !== 0);
    // Task 7 — modern stacked AREA with smooth lines + gradient fills (replaces
    // the flat stacked bars). Each layer fades top→bottom for depth.
    const grad = (c: string) => ({
      type: "linear" as const,
      x: 0, y: 0, x2: 0, y2: 1,
      colorStops: [
        { offset: 0, color: `${c}cc` },
        { offset: 1, color: `${c}14` },
      ],
    });
    const layer = (name: string, data: number[], color: string) => ({
      name,
      type: "line" as const,
      stack: "h",
      smooth: true,
      showSymbol: false,
      data,
      lineStyle: { width: 1.5, color },
      itemStyle: { color },
      areaStyle: { color: grad(color), opacity: 0.95 },
    });
    return {
      animationDuration: 500,
      legend: { top: 0 },
      grid: { left: 4, right: 12, top: 32, bottom: 24, containLabel: true },
      tooltip: { trigger: "axis", valueFormatter: (v) => formatNumber(v as number) },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: periods.map((p) => p.index ?? p.label),
        axisLabel: { interval: 0, rotate: 28, fontSize: 10 },
      },
      yAxis: { type: "value" },
      series: [
        layer("Base", periods.map((p) => p.base), "#64748b"),
        layer("Trend", periods.map((p) => p.trend), "#2563eb"),
        layer("Seasonality", periods.map((p) => p.seasonality), "#16a34a"),
        ...(hasExog ? [layer("Exogenous", periods.map((p) => p.exogenous ?? 0), "#ea580c")] : []),
        ...(hasResid ? [layer("Residual", periods.map((p) => p.residual ?? 0), "#94a3b8")] : []),
      ],
    };
  }, [periods, resolvedMode]);
  return <EChartBase option={option} height={height} onReady={onReady} slider />;
}
