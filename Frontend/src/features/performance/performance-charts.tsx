"use client";

import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChartBase } from "@/components/charts/echart-base";
import { useThemeMode } from "@/lib/theme/use-theme-mode";
import { readCssVar } from "@/lib/theme/theme-config";
import type { ForecastMetricRow, PooledGroup } from "@/types/forecast";
import {
  WMAPE_GOOD,
  WMAPE_POOR,
  vol,
  wmapeTone,
  type GroupPerf,
  type Tone,
} from "./derive";

function tones() {
  return {
    success: readCssVar("--success") || "#16a34a",
    warning: readCssVar("--warning") || "#f59e0b",
    destructive: readCssVar("--destructive") || "#dc2626",
    muted: readCssVar("--muted-foreground") || "#94a3b8",
  } as Record<Tone, string>;
}

/** Horizontal WMAPE bar by group (segment/brand), traffic-light coloured. */
export function WmapeByGroupChart({
  groups,
  height = 360,
}: {
  groups: GroupPerf[];
  height?: number;
}) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const t = tones();
    // Worst at bottom: sort descending so the largest WMAPE sits at the foot.
    const data = [...groups]
      .filter((g) => g.weightedWmape != null)
      .sort((a, b) => (b.weightedWmape ?? 0) - (a.weightedWmape ?? 0));
    return {
      animationDuration: 500,
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        valueFormatter: (v) => `${(v as number).toFixed(1)}%`,
      },
      grid: { left: 4, right: 48, top: 12, bottom: 24, containLabel: true },
      xAxis: {
        type: "value",
        name: "WMAPE %",
        nameLocation: "middle",
        nameGap: 28,
        axisLabel: { formatter: (v: number) => `${v}%` },
      },
      yAxis: {
        type: "category",
        data: data.map((g) => g.key),
        axisTick: { show: false },
      },
      series: [
        {
          type: "bar",
          barWidth: "60%",
          data: data.map((g) => ({
            value: Number((g.weightedWmape ?? 0).toFixed(1)),
            itemStyle: {
              color: t[wmapeTone(g.weightedWmape)],
              borderRadius: [0, 6, 6, 0],
            },
          })),
          label: {
            show: true,
            position: "right",
            formatter: (p) =>
              `${typeof p.value === "number" ? p.value.toFixed(1) : p.value}%`,
            color: t.muted,
            fontSize: 11,
          },
          markLine: {
            symbol: "none",
            silent: true,
            lineStyle: { type: "dashed" },
            data: [
              { xAxis: WMAPE_GOOD, lineStyle: { color: t.success } },
              { xAxis: WMAPE_POOR, lineStyle: { color: t.destructive } },
            ],
          },
        },
      ],
    };
  }, [groups, resolvedMode]);
  return <EChartBase option={option} height={height} />;
}

/** Brand × segment WMAPE heatmap with traffic-light bands. Cells are pooled
 *  brand×segment WMAPE values computed server-side (Streamlit parity). */
export function BrandSegmentHeatmap({
  groups,
  height = 420,
}: {
  groups: PooledGroup[];
  height?: number;
}) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const t = tones();
    const brands = [...new Set(groups.map((g) => g.brand || "—"))];
    const segments = [...new Set(groups.map((g) => g.segment || "—"))];
    // brands ordered by pooled held-out volume (desc) so the heaviest sit on top.
    const brandVol = new Map<string, number>();
    for (const g of groups)
      brandVol.set(
        g.brand || "—",
        (brandVol.get(g.brand || "—") ?? 0) + (g.volume ?? 0),
      );
    brands.sort((a, b) => (brandVol.get(b) ?? 0) - (brandVol.get(a) ?? 0));

    const cellMap = new Map<string, PooledGroup>();
    for (const g of groups) cellMap.set(`${g.brand || "—"}__${g.segment || "—"}`, g);

    const cells: [number, number, number][] = [];
    const counts: Record<string, number> = {};
    segments.forEach((seg, x) => {
      brands.forEach((br, y) => {
        const g = cellMap.get(`${br}__${seg}`);
        counts[`${x}_${y}`] = g?.skuCount ?? 0;
        if (g && g.weightedWmape != null)
          cells.push([x, y, Number(g.weightedWmape.toFixed(1))]);
      });
    });

    return {
      animationDuration: 500,
      tooltip: {
        position: "top",
        formatter: (p: unknown) => {
          const d = p as { value: [number, number, number] };
          const [x, y, v] = d.value;
          return `${brands[y]} · ${segments[x]}<br/>WMAPE ${v}% · n=${counts[`${x}_${y}`] ?? 0}`;
        },
      },
      grid: { left: 4, right: 12, top: 8, bottom: 64, containLabel: true },
      xAxis: {
        type: "category",
        data: segments,
        axisLabel: { interval: 0, rotate: 30, fontSize: 11 },
      },
      yAxis: { type: "category", data: brands, axisLabel: { fontSize: 11 } },
      visualMap: {
        type: "piecewise",
        show: true,
        orient: "horizontal",
        left: "center",
        bottom: 0,
        pieces: [
          { min: 0, max: WMAPE_GOOD, color: t.success, label: `<${WMAPE_GOOD}%` },
          {
            min: WMAPE_GOOD,
            max: WMAPE_POOR,
            color: t.warning,
            label: `${WMAPE_GOOD}–${WMAPE_POOR}%`,
          },
          { min: WMAPE_POOR, color: t.destructive, label: `>${WMAPE_POOR}%` },
        ],
      },
      series: [
        {
          type: "heatmap",
          data: cells,
          label: {
            show: true,
            formatter: (p) => {
              const v = (p as unknown as { value: [number, number, number] })
                .value[2];
              return `${v}%`;
            },
            fontSize: 10,
          },
        },
      ],
    };
  }, [groups, resolvedMode]);
  return <EChartBase option={option} height={height} />;
}

/** SKU portfolio scatter — volume (log) × WMAPE, coloured by band. */
export function SkuQualityScatter({
  rows,
  height = 380,
}: {
  rows: ForecastMetricRow[];
  height?: number;
}) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const t = tones();
    const scored = rows.filter(
      (r) => r.testWmape != null && vol(r) > 0,
    );
    const seriesFor = (band: string, color: string) => ({
      name: band,
      type: "scatter" as const,
      data: scored
        .filter((r) => r.band === band)
        .map((r) => ({
          value: [vol(r), Math.min(r.testWmape as number, 200)],
          name: r.sku,
        })),
      itemStyle: { color, opacity: 0.75 },
      symbolSize: (v: number[]) => Math.max(6, Math.sqrt((v[0] ?? 0)) / 4),
    });
    return {
      animationDuration: 500,
      // Task 11 — the option-level palette drives BOTH the legend icons and each
      // series' colour by index, so the three legend entries are distinct and
      // match their plotted points: Good=green, Review=amber, Poor=red (the 4th
      // slot is the silent threshold line). Without this the legend fell back to a
      // single palette colour while only the points carried an itemStyle colour.
      color: [t.success, t.warning, t.destructive, t.muted],
      tooltip: {
        trigger: "item",
        formatter: (p: unknown) => {
          const d = p as { data: { name: string; value: [number, number] } };
          return `${d.data.name}<br/>Volume ${Math.round(d.data.value[0]).toLocaleString()} · WMAPE ${d.data.value[1].toFixed(1)}%`;
        },
      },
      legend: { top: 0, data: ["Good", "Review", "Poor"], itemWidth: 12 },
      grid: { left: 4, right: 16, top: 32, bottom: 36, containLabel: true },
      xAxis: {
        type: "log",
        name: "Hold-out volume (log)",
        nameLocation: "middle",
        nameGap: 28,
      },
      yAxis: {
        type: "value",
        name: "WMAPE %",
        axisLabel: { formatter: (v: number) => `${v}%` },
      },
      series: [
        seriesFor("Good", t.success),
        seriesFor("Review", t.warning),
        seriesFor("Poor", t.destructive),
        {
          type: "line",
          markLine: {
            symbol: "none",
            silent: true,
            lineStyle: { type: "dashed" },
            data: [
              { yAxis: WMAPE_GOOD, lineStyle: { color: t.success } },
              { yAxis: WMAPE_POOR, lineStyle: { color: t.destructive } },
            ],
          },
          data: [],
        },
      ],
    };
  }, [rows, resolvedMode]);
  return <EChartBase option={option} height={height} />;
}
