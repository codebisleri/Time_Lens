"use client";

import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChartBase } from "@/components/charts/echart-base";
import { useThemeMode } from "@/lib/theme/use-theme-mode";
import { readCssVar } from "@/lib/theme/theme-config";
import { formatCompact, formatDate, formatNumber } from "@/lib/utils/format";
import type {
  EdaAcfPoint,
  EdaDecompositionPoint,
  EdaHistogramBin,
  EdaHoliday,
  EdaMonthlyBox,
  EdaSeasonalPoint,
  EdaSeriesPoint,
} from "@/types/eda";

function label(date: string): string {
  return formatDate(date, { month: "short", year: "2-digit" });
}

/** Trend — demand over time with a mean reference line. */
export function EdaTrendChart({
  series,
  mean,
  height = 300,
}: {
  series: EdaSeriesPoint[];
  mean: number | null;
  height?: number;
}) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const color = readCssVar("--chart-1") || "#6366f1";
    const rows = Array.isArray(series) ? series : [];
    return {
      animationDuration: 700,
      tooltip: {
        trigger: "axis",
        valueFormatter: (v) => (v == null ? "—" : formatNumber(v as number)),
      },
      grid: { left: 4, right: 8, top: 16, bottom: 4, containLabel: true },
      xAxis: { type: "category", boundaryGap: false, data: rows.map((d) => label(d.date)) },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => formatCompact(v) } },
      series: [
        {
          name: "Demand",
          type: "line",
          smooth: true,
          showSymbol: false,
          data: rows.map((d) => d.value),
          lineStyle: { width: 2.5, color },
          itemStyle: { color },
          areaStyle: {
            opacity: 0.15,
            color: {
              type: "linear", x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color },
                { offset: 1, color: "transparent" },
              ],
            },
          },
          markLine:
            mean != null
              ? {
                  silent: true,
                  symbol: "none",
                  lineStyle: { type: "dashed", color: readCssVar("--chart-5") || "#38bdf8" },
                  data: [{ yAxis: mean, name: "mean" }],
                  label: { formatter: `mean ${formatCompact(mean)}` },
                }
              : undefined,
        },
      ],
    };
  }, [series, mean, resolvedMode]);
  return <EChartBase option={option} height={height} />;
}

/** Seasonality — average demand by calendar month. */
export function EdaSeasonalityChart({
  data,
  height = 260,
}: {
  data: EdaSeasonalPoint[];
  height?: number;
}) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const top = readCssVar("--chart-2") || "#2dd4bf";
    const bottom = readCssVar("--chart-1") || "#6366f1";
    const rows = Array.isArray(data) ? data : [];
    return {
      animationDuration: 600,
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" },
        valueFormatter: (v) => formatNumber(v as number) },
      grid: { left: 4, right: 8, top: 12, bottom: 4, containLabel: true },
      xAxis: { type: "category", data: rows.map((d) => d.label), axisTick: { show: false } },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => formatCompact(v) } },
      series: [{
        type: "bar", barWidth: "55%", data: rows.map((d) => d.value),
        itemStyle: {
          borderRadius: [6, 6, 0, 0],
          color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [{ offset: 0, color: top }, { offset: 1, color: bottom }] },
        },
      }],
    };
  }, [data, resolvedMode]);
  return <EChartBase option={option} height={height} />;
}

// NOTE: the combined trend/seasonal/residual overlay chart was removed (F.13 §5B)
// in favour of EdaDecompositionPanel — four stacked Observed/Trend/Seasonal/
// Residual panels with a shared x-axis (Streamlit plot_decomposition parity).

/**
 * Seasonal decomposition — FOUR vertically stacked panels (Observed, Trend,
 * Seasonal, Residuals) sharing one category x-axis with synchronized zoom, an
 * exact match for the Streamlit `plot_decomposition` make_subplots(rows=4,
 * shared_xaxes=True) layout. Residuals are drawn as scatter points (Streamlit
 * `mode='markers'`); the others are lines. `series` supplies the Observed panel
 * (the original demand aligned to the decomposition dates).
 */
export function EdaDecompositionPanel({
  data,
  series,
  height = 560,
}: {
  data: EdaDecompositionPoint[];
  series: EdaSeriesPoint[];
  height?: number;
}) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const cObserved = readCssVar("--chart-1") || "#6366f1";
    const cTrend = readCssVar("--chart-2") || "#2dd4bf";
    const cSeasonal = readCssVar("--chart-5") || "#ef7602";
    const cResid = readCssVar("--chart-3") || "#94a3b8";
    const rows = Array.isArray(data) ? data : [];
    const labels = rows.map((d) => label(d.date));
    const byDate = new Map<string, number | null>();
    for (const p of Array.isArray(series) ? series : []) byDate.set(p.date, p.value);
    const observed = rows.map((d) => (byDate.has(d.date) ? byDate.get(d.date) ?? null : null));
    const trend = rows.map((d) => d.trend);
    const seasonal = rows.map((d) => d.seasonal);
    const resid = rows.map((d) => d.resid);

    // Four stacked grids; only the bottom grid shows x-axis labels.
    const gridTops = ["7%", "30.5%", "54%", "77.5%"];
    const panelH = "15.5%";
    const grid = gridTops.map((top) => ({
      left: 8,
      right: 12,
      top,
      height: panelH,
      containLabel: true,
    }));
    const titleConf = (text: string, top: string) => ({
      text,
      top,
      left: "center",
      textStyle: { fontSize: 11, fontWeight: 600 as const },
    });

    const mkXAxis = (i: number, showLabel: boolean) => ({
      type: "category" as const,
      gridIndex: i,
      data: labels,
      boundaryGap: i === 3, // scatter reads better with padding
      axisLabel: { show: showLabel },
      axisTick: { show: showLabel },
    });
    const mkYAxis = (i: number) => ({
      type: "value" as const,
      gridIndex: i,
      scale: true,
      axisLabel: { formatter: (v: number) => formatCompact(v), fontSize: 10 },
    });

    return {
      animationDuration: 600,
      title: [
        titleConf("Observed", "2%"),
        titleConf("Trend", "25.5%"),
        titleConf("Seasonal", "49%"),
        titleConf("Residuals", "72.5%"),
      ],
      tooltip: {
        trigger: "axis",
        valueFormatter: (v) => (v == null ? "—" : formatNumber(v as number)),
      },
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      grid,
      xAxis: [mkXAxis(0, false), mkXAxis(1, false), mkXAxis(2, false), mkXAxis(3, true)],
      yAxis: [mkYAxis(0), mkYAxis(1), mkYAxis(2), mkYAxis(3)],
      dataZoom: [
        { type: "inside", xAxisIndex: [0, 1, 2, 3] },
        { type: "slider", xAxisIndex: [0, 1, 2, 3], bottom: 4, height: 16 },
      ],
      series: [
        { name: "Observed", type: "line", xAxisIndex: 0, yAxisIndex: 0, smooth: true,
          showSymbol: false, data: observed,
          lineStyle: { width: 2, color: cObserved }, itemStyle: { color: cObserved } },
        { name: "Trend", type: "line", xAxisIndex: 1, yAxisIndex: 1, smooth: true,
          showSymbol: false, connectNulls: true, data: trend,
          lineStyle: { width: 2, color: cTrend }, itemStyle: { color: cTrend } },
        { name: "Seasonal", type: "line", xAxisIndex: 2, yAxisIndex: 2, smooth: true,
          showSymbol: false, data: seasonal,
          lineStyle: { width: 1.5, color: cSeasonal }, itemStyle: { color: cSeasonal } },
        { name: "Residuals", type: "scatter", xAxisIndex: 3, yAxisIndex: 3, symbolSize: 5,
          data: resid, itemStyle: { color: cResid, opacity: 0.8 } },
      ],
    };
  }, [data, series, resolvedMode]);
  return <EChartBase option={option} height={height} />;
}

/** Autocorrelation (ACF) bars — bars-only, matching the Streamlit plot_acf_pacf
 *  subplot (fixed 20 lags, no significance bands). */
export function EdaAcfChart({
  data,
  height = 260,
}: {
  data: EdaAcfPoint[];
  height?: number;
}) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const color = readCssVar("--chart-1") || "#6366f1";
    const rows = Array.isArray(data) ? data : [];
    return {
      animationDuration: 500,
      tooltip: { trigger: "axis",
        valueFormatter: (v) => (v == null ? "—" : formatNumber(v as number, { maximumFractionDigits: 3 })) },
      grid: { left: 4, right: 8, top: 12, bottom: 4, containLabel: true },
      xAxis: { type: "category", data: rows.map((d) => String(d.lag)), name: "lag" },
      yAxis: { type: "value", min: -1, max: 1 },
      series: [{
        type: "bar", barWidth: "45%", data: rows.map((d) => d.value), itemStyle: { color },
      }],
    };
  }, [data, resolvedMode]);
  return <EChartBase option={option} height={height} />;
}

/** Partial autocorrelation (PACF) bars — bars-only, matching Streamlit. */
export function EdaPacfChart({
  data,
  height = 260,
}: {
  data: EdaAcfPoint[];
  height?: number;
}) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const color = readCssVar("--chart-2") || "#2dd4bf";
    const rows = Array.isArray(data) ? data : [];
    return {
      animationDuration: 500,
      tooltip: { trigger: "axis",
        valueFormatter: (v) => (v == null ? "—" : formatNumber(v as number, { maximumFractionDigits: 3 })) },
      grid: { left: 4, right: 8, top: 12, bottom: 4, containLabel: true },
      xAxis: { type: "category", data: rows.map((d) => String(d.lag)), name: "lag" },
      yAxis: { type: "value", min: -1, max: 1 },
      series: [{
        type: "bar", barWidth: "45%", data: rows.map((d) => d.value), itemStyle: { color },
      }],
    };
  }, [data, resolvedMode]);
  return <EChartBase option={option} height={height} />;
}

/** Target Variable Distribution — overall histogram of demand values. */
export function EdaHistogramChart({
  data,
  height = 260,
}: {
  data: EdaHistogramBin[];
  height?: number;
}) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const color = readCssVar("--chart-1") || "#6366f1";
    const rows = Array.isArray(data) ? data : [];
    return {
      animationDuration: 500,
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" },
        valueFormatter: (v) => formatNumber(v as number) },
      grid: { left: 4, right: 8, top: 12, bottom: 4, containLabel: true },
      xAxis: { type: "category", data: rows.map((d) => d.label),
        axisLabel: { rotate: 45, fontSize: 10 }, axisTick: { show: false } },
      yAxis: { type: "value", name: "Frequency", axisLabel: { formatter: (v: number) => formatCompact(v) } },
      series: [{
        type: "bar", barWidth: "92%", data: rows.map((d) => d.count),
        itemStyle: { color, borderRadius: [3, 3, 0, 0] },
      }],
    };
  }, [data, resolvedMode]);
  return <EChartBase option={option} height={height} />;
}

/** Target Variable Distribution — demand distribution by calendar month (box),
 *  the larger of the two distribution panels (Streamlit "Distribution by Month").
 *  Boxes carry a named 5-number tooltip for readability. */
export function EdaMonthlyBoxChart({
  data,
  height = 360,
}: {
  data: EdaMonthlyBox[];
  height?: number;
}) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const color = readCssVar("--chart-2") || "#2dd4bf";
    const rows = Array.isArray(data) ? data : [];
    return {
      animationDuration: 500,
      tooltip: {
        trigger: "item",
        formatter: (p: unknown) => {
          const params = p as { name?: string; value?: (number | null)[] };
          const v = params.value ?? [];
          // boxplot value = [x?, min, q1, median, q3, max] OR [min,q1,median,q3,max]
          const o = v.length >= 6 ? v.slice(1) : v;
          const fmt = (n: number | null | undefined) =>
            n == null ? "—" : formatNumber(n);
          return [
            `<strong>${params.name ?? ""}</strong>`,
            `Max: ${fmt(o[4])}`,
            `Q3: ${fmt(o[3])}`,
            `Median: ${fmt(o[2])}`,
            `Q1: ${fmt(o[1])}`,
            `Min: ${fmt(o[0])}`,
          ].join("<br/>");
        },
      },
      grid: { left: 4, right: 8, top: 12, bottom: 4, containLabel: true },
      xAxis: { type: "category", data: rows.map((d) => d.month), axisTick: { show: false },
        axisLabel: { rotate: 30, fontSize: 11 } },
      // F.17 §7 — fit the y-axis to the data (no large empty area); 5% headroom.
      yAxis: {
        type: "value",
        scale: true,
        boundaryGap: ["5%", "5%"],
        axisLabel: { formatter: (v: number) => formatCompact(v) },
      },
      series: [{
        name: "Monthly", type: "boxplot", boxWidth: ["35%", "60%"],
        data: rows.map((d) => [d.min ?? 0, d.q1 ?? 0, d.median ?? 0, d.q3 ?? 0, d.max ?? 0]),
        itemStyle: { color: `${color}33`, borderColor: color, borderWidth: 1.5 },
      }],
    };
  }, [data, resolvedMode]);
  return <EChartBase option={option} height={height} />;
}

/** Holiday Analysis — demand line with holiday periods highlighted. */
export function EdaHolidayChart({
  series,
  holiday,
  height = 300,
}: {
  series: EdaSeriesPoint[];
  holiday: EdaHoliday;
  height?: number;
}) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const line = readCssVar("--chart-1") || "#6366f1";
    const mark = readCssVar("--chart-3") || "#10b981";
    const rows = Array.isArray(series) ? series : [];
    const labels = rows.map((d) => label(d.date));
    const holidaySet = new Set((holiday?.markers ?? []).map((m) => m.date));
    const scatter = rows.map((d) => (holidaySet.has(d.date) ? d.value : null));
    return {
      animationDuration: 600,
      tooltip: { trigger: "axis",
        valueFormatter: (v) => (v == null ? "—" : formatNumber(v as number)) },
      // F.17 §8 — centered legend below the top-right toolbar (no overlap).
      legend: { data: ["Demand", "Holidays"], top: 6, left: "center", itemWidth: 12 },
      grid: { left: 4, right: 8, top: 44, bottom: 4, containLabel: true },
      xAxis: { type: "category", boundaryGap: false, data: labels },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => formatCompact(v) } },
      series: [
        { name: "Demand", type: "line", smooth: true, showSymbol: false,
          data: rows.map((d) => d.value), lineStyle: { width: 2, color: line }, itemStyle: { color: line } },
        { name: "Holidays", type: "scatter", symbolSize: 9, data: scatter,
          itemStyle: { color: mark } },
      ],
    };
  }, [series, holiday, resolvedMode]);
  return <EChartBase option={option} height={height} />;
}

/** Anomaly Detection — cleaned demand line with corrected anomalies marked. */
export function EdaAnomalyChart({
  series,
  anomalies,
  height = 300,
}: {
  series: EdaSeriesPoint[];
  anomalies: { date: string | null; value: number | null }[];
  height?: number;
}) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    const line = readCssVar("--chart-1") || "#6366f1";
    const mark = readCssVar("--chart-5") || "#ef4444";
    const rows = Array.isArray(series) ? series : [];
    const labels = rows.map((d) => label(d.date));
    const byLabel = new Map<string, number | null>();
    for (const a of anomalies ?? []) {
      if (a.date) byLabel.set(label(a.date), a.value);
    }
    const scatter = labels.map((l) => (byLabel.has(l) ? byLabel.get(l) ?? null : null));
    return {
      animationDuration: 600,
      tooltip: { trigger: "axis",
        valueFormatter: (v) => (v == null ? "—" : formatNumber(v as number)) },
      // F.17 §8 — centered legend below the top-right toolbar (no overlap).
      legend: { data: ["Cleaned", "Anomalies (original)"], top: 6, left: "center", itemWidth: 12 },
      grid: { left: 4, right: 8, top: 44, bottom: 4, containLabel: true },
      xAxis: { type: "category", boundaryGap: false, data: labels },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => formatCompact(v) } },
      series: [
        { name: "Cleaned", type: "line", smooth: true, showSymbol: false,
          data: rows.map((d) => d.value), lineStyle: { width: 2, color: line }, itemStyle: { color: line } },
        { name: "Anomalies (original)", type: "scatter", symbol: "diamond", symbolSize: 12,
          data: scatter, itemStyle: { color: mark } },
      ],
    };
  }, [series, anomalies, resolvedMode]);
  return <EChartBase option={option} height={height} />;
}
