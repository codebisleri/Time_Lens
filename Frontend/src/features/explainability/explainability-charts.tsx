"use client";

import { useMemo } from "react";
import type { ECharts } from "echarts";
import type { EChartsOption } from "echarts";
import { EChartBase } from "@/components/charts/echart-base";
import { useThemeMode } from "@/lib/theme/use-theme-mode";
import { chartColors, withAlpha } from "@/lib/charts/colors";
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
// Issue 4 — all colours are now resolved from the theme tokens via chartColors()
// inside each option memo (re-resolved on Light/Dark switch); no hardcoded hex.

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
    const { palette } = chartColors();
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
          data: drivers.map((d, i) => ({ value: d.pct, itemStyle: { color: palette[(drivers.length - 1 - i) % palette.length] } })),
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
    // Waterfall semantics (Task 9): base/total navy, gains orange, losses grey —
    // all theme-bound (no hardcoded green/red/blue).
    const c = chartColors();
    const placeholder: number[] = [];
    const bars: { value: number; itemStyle: { color: string } }[] = [];
    let running = 0;
    for (const s of steps) {
      if (s.type === "base" || s.type === "total") {
        placeholder.push(0);
        bars.push({ value: s.value, itemStyle: { color: s.type === "base" ? c.neutral : c.primary } });
        running = s.value;
      } else {
        const start = s.value >= 0 ? running : running + s.value;
        placeholder.push(start);
        bars.push({ value: Math.abs(s.value), itemStyle: { color: s.value >= 0 ? c.positive : c.negative } });
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
    const { palette } = chartColors(); // theme-bound layer colours
    const hasExog = periods.some((p) => (p.exogenous ?? 0) !== 0);
    const hasResid = periods.some((p) => (p.residual ?? 0) !== 0);
    // Task 17 — restore the stacked-BAR "By Horizon" layout, but give each bar a
    // subtle vertical gradient (line-shaded) fill instead of a heavy solid colour:
    // opaque at the top fading to translucent, with a thin border in the layer's
    // colour for definition. Clean + modern; data / stacking / tooltip unchanged.
    const grad = (c: string) => ({
      type: "linear" as const,
      x: 0, y: 0, x2: 0, y2: 1,
      // withAlpha keeps these valid for theme-bound hsl()/rgb() colours — a raw
      // `${c}e6` on an hsl() string crashes canvas addColorStop.
      colorStops: [
        { offset: 0, color: withAlpha(c, 0.9) },
        { offset: 1, color: withAlpha(c, 0.2) },
      ],
    });
    const layer = (name: string, data: number[], color: string) => ({
      name,
      type: "bar" as const,
      stack: "h",
      barWidth: "58%",
      data,
      itemStyle: { color: grad(color), borderColor: color, borderWidth: 1 },
    });
    return {
      animationDuration: 500,
      legend: { top: 0 },
      grid: { left: 4, right: 12, top: 32, bottom: 24, containLabel: true },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (v) => formatNumber(v as number) },
      xAxis: {
        type: "category",
        data: periods.map((p) => p.index ?? p.label),
        axisLabel: { interval: 0, rotate: 28, fontSize: 10 },
      },
      yAxis: { type: "value" },
      series: [
        layer("Base", periods.map((p) => p.base), palette[2]!),
        layer("Trend", periods.map((p) => p.trend), palette[0]!),
        layer("Seasonality", periods.map((p) => p.seasonality), palette[1]!),
        ...(hasExog ? [layer("Exogenous", periods.map((p) => p.exogenous ?? 0), palette[4]!)] : []),
        ...(hasResid ? [layer("Residual", periods.map((p) => p.residual ?? 0), palette[6]!)] : []),
      ],
    };
  }, [periods, resolvedMode]);
  return <EChartBase option={option} height={height} onReady={onReady} slider />;
}
