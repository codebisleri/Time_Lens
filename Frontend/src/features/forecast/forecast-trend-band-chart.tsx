"use client";

import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChartBase } from "@/components/charts/echart-base";
import { useThemeMode } from "@/lib/theme/use-theme-mode";
import { readCssVar } from "@/lib/theme/theme-config";
import { formatCompact, formatDate, formatNumber } from "@/lib/utils/format";
import type { ForecastBandPoint } from "./hooks/use-forecast-trend";

interface TooltipParam {
  seriesName?: string;
  value?: unknown;
  axisValue?: string;
  marker?: string;
}

/**
 * Hero forecast visualization: historical demand (solid, area-filled) handing
 * off to the forecast (dashed), wrapped in a shaded confidence band. The band is
 * drawn as a stacked lower-base + (upper − lower) area pair. Theme-aware (colors
 * from CSS tokens, recomputed on mode switch), smooth, animated, and responsive.
 */
export function ForecastTrendBandChart({
  data,
  height = 360,
}: {
  data: ForecastBandPoint[];
  height?: number;
}) {
  const { resolvedMode } = useThemeMode();

  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    // F.16 — navy/orange/neutral only.
    const actualColor = readCssVar("--chart-1") || "#d6dee8"; // neutral — actual
    const forecastColor = readCssVar("--chart-5") || "#EF7602"; // orange — forecast
    const fitColor = readCssVar("--chart-7") || "#8d99a6"; // grey — in-sample fit
    const testColor = readCssVar("--chart-8") || "#b4560a"; // deep orange — test pred

    const rows = Array.isArray(data) ? data : [];
    const labels = rows.map((d) =>
      formatDate(d.date, { month: "short", day: "numeric" }),
    );

    const n = rows.length;

    // EVERY series uses one consistent shape: a full-length, index-aligned
    // SCALAR array (length === labels.length). No [label,value] tuples, no
    // sparse arrays, no mixing tuple+scalar on the same chart. Mixed/misaligned
    // shapes (esp. alongside a stacked series) leave the animated/stacked
    // `points` arrays short, and zrender's interpolate1DArray then dereferences
    // `.length` on an undefined segment ("reading 'length'").
    //
    // Rules that keep every series animation-safe:
    //  - The two band series and the demand-area fill carry NO nulls (numbers
    //    only), so stacking + area painting never see a gap.
    //  - The visible Actual / Forecast lines carry null ONLY as gap markers and
    //    deliberately have NO areaStyle, so the area painter is never handed a
    //    null segment (that was the dashboard's separate crash mode).
    const actualLine: (number | null)[] = new Array(n).fill(null);
    const forecastLine: (number | null)[] = new Array(n).fill(null);
    const fitLine: (number | null)[] = new Array(n).fill(null); // in-sample fit
    const testLine: (number | null)[] = new Array(n).fill(null); // hold-out test pred
    const demandArea: number[] = new Array(n).fill(0); // continuous fill, no null
    const bandLower: number[] = new Array(n).fill(0);
    const bandSpan: number[] = new Array(n).fill(0);
    let hasFit = false;
    let hasTest = false;

    let lastActualIdx = -1;
    rows.forEach((d, i) => {
      const a = Number.isFinite(d.actual) ? (d.actual as number) : null;
      const f = Number.isFinite(d.forecast) ? (d.forecast as number) : null;
      const ft = Number.isFinite(d.fit) ? (d.fit as number) : null;
      const tp = Number.isFinite(d.testPred) ? (d.testPred as number) : null;

      if (a != null) {
        actualLine[i] = a;
        lastActualIdx = i;
      }
      if (f != null) forecastLine[i] = f;
      if (ft != null) { fitLine[i] = ft; hasFit = true; }
      if (tp != null) { testLine[i] = tp; hasTest = true; }
      demandArea[i] = a ?? f ?? 0;

      if (Number.isFinite(d.lower) && Number.isFinite(d.upper)) {
        bandLower[i] = d.lower as number;
        bandSpan[i] = Math.max(0, (d.upper as number) - (d.lower as number));
      } else {
        // Collapse the band to zero width (anchored to a defined value) where
        // there's no interval — keeps the stacked arrays null-free.
        bandLower[i] = a ?? f ?? 0;
        bandSpan[i] = 0;
      }
    });

    // Bridge the solid→dashed handoff so the visible lines meet at the boundary.
    if (
      lastActualIdx >= 0 &&
      lastActualIdx + 1 < n &&
      forecastLine[lastActualIdx] == null
    ) {
      forecastLine[lastActualIdx] = actualLine[lastActualIdx] ?? null;
    }

    // §10 — history → forecast split line + shaded forecast horizon (Streamlit
    // drill-down parity). Only when the series has both history and a forecast
    // tail. Solid translucent fill (no gradient) so it's animation/hover-safe.
    const hasSplit = lastActualIdx >= 0 && lastActualIdx + 1 < n;
    const boundaryLabel = hasSplit ? labels[lastActualIdx] : null;
    const horizonEndLabel = hasSplit ? labels[n - 1] : null;

    // Nothing to plot yet — return an empty (but valid) option rather than feed
    // the animator degenerate series.
    if (n === 0) {
      return {
        xAxis: { type: "category", data: [] },
        yAxis: { type: "value" },
        series: [],
      };
    }

    return {
      animationDuration: 900,
      animationEasing: "cubicOut",
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const list = Array.isArray(params)
            ? (params as TooltipParam[])
            : [params as TooltipParam];
          const header = list[0]?.axisValue ?? "";
          const named = new Set([
            "Actual",
            "Forecast",
            "In-sample fit",
            "Test prediction",
          ]);
          const lines = list
            .filter((p) => p.seriesName && named.has(p.seriesName) && p.value != null)
            .map((p) => {
              const v = Array.isArray(p.value) ? p.value[1] : p.value;
              return `${p.marker ?? ""} ${p.seriesName}: <b>${
                typeof v === "number" ? formatNumber(v) : "—"
              }</b>`;
            });
          return [`<div style="font-weight:600">${header}</div>`, ...lines].join(
            "<br/>",
          );
        },
      },
      legend: {
        data: [
          "Actual",
          ...(hasFit ? ["In-sample fit"] : []),
          ...(hasTest ? ["Test prediction"] : []),
          "Forecast",
        ],
        // §11 — anchor the legend top-LEFT so it never collides with the
        // top-right chart toolbar.
        left: 0,
        top: 0,
        itemWidth: 14,
      },
      grid: { left: 4, right: 8, top: 44, bottom: 4, containLabel: true },
      xAxis: { type: "category", boundaryGap: false, data: labels },
      yAxis: {
        type: "value",
        axisLabel: { formatter: (v: number) => formatCompact(v) },
      },
      series: [
        // Invisible base = lower bound; the band stacks on top of it.
        // Null-free numeric data → stacking + animation are both safe.
        {
          name: "__band_base",
          type: "line",
          stack: "confidence",
          data: bandLower,
          showSymbol: false,
          silent: true,
          lineStyle: { opacity: 0 },
          tooltip: { show: false },
          z: 1,
        },
        // Visible band = (upper − lower), filled.
        {
          name: "Confidence band",
          type: "line",
          stack: "confidence",
          data: bandSpan,
          showSymbol: false,
          silent: true,
          lineStyle: { opacity: 0 },
          areaStyle: { color: forecastColor, opacity: 0.14 },
          tooltip: { show: false },
          z: 1,
        },
        // Continuous demand-area fill (no nulls) under the whole curve — keeps
        // the gradient area off the null-containing visible lines.
        {
          name: "__demand_area",
          type: "line",
          smooth: true,
          showSymbol: false,
          silent: true,
          data: demandArea,
          lineStyle: { opacity: 0 },
          areaStyle: {
            opacity: 0.16,
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
          tooltip: { show: false },
          z: 2,
        },
        // Visible historical demand (solid). No areaStyle → null gaps are safe.
        {
          name: "Actual",
          type: "line",
          smooth: true,
          showSymbol: false,
          connectNulls: false,
          data: actualLine,
          lineStyle: { width: 2.5, color: actualColor },
          itemStyle: { color: actualColor },
          z: 3,
        },
        // In-sample fit (rolling-origin train prediction) over the history.
        ...(hasFit
          ? [{
              name: "In-sample fit",
              type: "line" as const,
              smooth: true,
              showSymbol: false,
              connectNulls: false,
              data: fitLine,
              lineStyle: { width: 1.5, type: "dotted" as const, color: fitColor },
              itemStyle: { color: fitColor },
              z: 3,
            }]
          : []),
        // Hold-out / validation test prediction over the backtest window.
        ...(hasTest
          ? [{
              name: "Test prediction",
              type: "line" as const,
              smooth: false,
              showSymbol: true,
              symbolSize: 5,
              connectNulls: false,
              data: testLine,
              lineStyle: { width: 2, color: testColor },
              itemStyle: { color: testColor },
              z: 4,
            }]
          : []),
        // Visible forecast (dashed). No areaStyle → null gaps are safe.
        {
          name: "Forecast",
          type: "line",
          smooth: true,
          showSymbol: false,
          connectNulls: false,
          data: forecastLine,
          lineStyle: { width: 2.5, type: "dashed", color: forecastColor },
          itemStyle: { color: forecastColor },
          z: 3,
          // §10 — vertical split at the last actual + shaded forecast horizon.
          markLine: boundaryLabel
            ? {
                silent: true,
                symbol: "none",
                lineStyle: { color: forecastColor, type: "dashed", width: 1.5, opacity: 0.8 },
                label: { formatter: "Forecast →", color: forecastColor, fontSize: 10, position: "insideEndTop" },
                data: [{ xAxis: boundaryLabel }],
              }
            : undefined,
          markArea:
            boundaryLabel && horizonEndLabel
              ? {
                  silent: true,
                  itemStyle: { color: forecastColor, opacity: 0.06 },
                  data: [[{ xAxis: boundaryLabel }, { xAxis: horizonEndLabel }]],
                }
              : undefined,
        },
      ],
    };
  }, [data, resolvedMode]);

  return <EChartBase option={option} height={height} />;
}
