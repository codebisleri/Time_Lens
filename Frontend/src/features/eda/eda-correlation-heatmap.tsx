"use client";

import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChartBase } from "@/components/charts/echart-base";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/feedback/empty-state";
import { useAsync } from "@/lib/hooks";
import { useThemeMode } from "@/lib/theme/use-theme-mode";
import { readCssVar } from "@/lib/theme/theme-config";
import { chartColors } from "@/lib/charts/colors";
import { dataService, edaService } from "@/lib/api/services";

// ID-like columns are identifiers, not drivers — exclude even when numeric.
const ID_RX = /(^|[_\s])(id|ids|code|codes|uuid|guid|key)$/i;

/** Pearson correlation; null when too few finite pairs or zero variance. */
function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i]!, y = ys[i]!;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  const cov = sxy - (sx * sy) / n;
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  if (vx <= 0 || vy <= 0) return null;
  return Math.max(-1, Math.min(1, cov / Math.sqrt(vx * vy)));
}

/**
 * Exogenous Correlation Heatmap (Phase Y.2 · restored in the Y.7 hotfix). A FULL
 * pairwise Pearson correlation matrix across every NUMERIC driver.
 *
 * PRIMARY source: the read-only backend `/eda/correlation`, which reuses the
 * engine's feature engineering — so the matrix includes BOTH uploaded numeric
 * exogenous columns (Price / Promotion / Discount / Holiday / …) AND engineered
 * features (month_sin/cos, lag_*, rolling_mean/std_*, is_holiday, …).
 *
 * FALLBACK (no backend / mock mode): compute from the dataset preview rows.
 * Numeric columns are detected by PARSING the actual values with Number() — NOT
 * by the pandas dtype string — because CSV-origin columns frequently arrive as
 * strings (dtype "object"), which previously hid every driver and forced the
 * "No numeric exogenous variables available" empty state.
 *
 * READ-ONLY: no forecast is run or changed. Colour scale: negative = red,
 * neutral = white, positive = blue.
 */
export function EdaCorrelationHeatmap({ datasetId }: { datasetId: string }) {
  const { resolvedMode } = useThemeMode();
  // 1) Server-side correlation (engineered + uploaded drivers). Never throws.
  const corr = useAsync(
    () => (datasetId ? edaService.correlation({ datasetId }).catch(() => null) : Promise.resolve(null)),
    [datasetId],
  );
  const backendReady = !!corr.data?.available && (corr.data?.columns.length ?? 0) >= 2;

  // 2) Fallback (only fetched when the backend matrix is unavailable/insufficient).
  const needFallback = !corr.isLoading && !backendReady;
  const preview = useAsync(
    () => (needFallback && datasetId ? dataService.preview(datasetId, 5000).catch(() => null) : Promise.resolve(null)),
    [needFallback, datasetId],
  );
  const dsMeta = useAsync(
    () => (needFallback && datasetId ? dataService.getDataset(datasetId).catch(() => null) : Promise.resolve(null)),
    [needFallback, datasetId],
  );

  // Unified { cols, matrix } from whichever source resolved.
  const { cols, matrix } = useMemo<{ cols: string[]; matrix: (number | null)[][] }>(() => {
    if (backendReady && corr.data) {
      return { cols: corr.data.columns, matrix: corr.data.matrix };
    }
    // ── Client fallback: value-based numeric detection + pairwise Pearson. ──
    const rows = preview.data?.rows ?? [];
    const schema = preview.data?.schema ?? [];
    if (!rows.length || !schema.length) return { cols: [], matrix: [] };

    const cfg = dsMeta.data?.config;
    const exclude = new Set<string>(
      [cfg?.dateCol, cfg?.skuCol, cfg?.salesCol, ...(cfg?.forecastLevelCols ?? [])].filter(
        Boolean,
      ) as string[],
    );

    // A column is numeric if a clear majority of its NON-EMPTY values parse to a
    // finite number via Number() — robust to CSV strings (Task 3).
    const isNumericCol = (col: string): boolean => {
      let nonEmpty = 0;
      let numeric = 0;
      for (const r of rows) {
        const raw = r[col];
        if (raw == null || raw === "") continue;
        nonEmpty += 1;
        if (Number.isFinite(Number(raw))) numeric += 1;
      }
      return nonEmpty >= 3 && numeric / nonEmpty >= 0.6;
    };

    const cand = schema
      .map((s) => s.column)
      .filter((c) => !exclude.has(c) && !ID_RX.test(c) && isNumericCol(c));

    const series = cand.map((c) =>
      rows.map((row) => {
        const raw = row[c];
        if (raw == null || raw === "") return NaN;
        const v = Number(raw);
        return Number.isFinite(v) ? v : NaN;
      }),
    );

    const m: (number | null)[][] = [];
    for (let i = 0; i < cand.length; i++) {
      m[i] = [];
      for (let j = 0; j < cand.length; j++) {
        if (i === j) { m[i]![j] = 1; continue; }
        if (j < i) { m[i]![j] = m[j]![i] ?? null; continue; }
        const a = series[i]!, b = series[j]!;
        const xs: number[] = [], ys: number[] = [];
        for (let k = 0; k < a.length; k++) {
          if (Number.isFinite(a[k]!) && Number.isFinite(b[k]!)) { xs.push(a[k]!); ys.push(b[k]!); }
        }
        m[i]![j] = pearson(xs, ys);
      }
    }
    return { cols: cand, matrix: m };
  }, [backendReady, corr.data, preview.data, dsMeta.data]);

  const option = useMemo<EChartsOption>(() => {
    void resolvedMode; // re-resolve the theme-bound scale on Light/Dark switch
    // Theme-bound diverging scale (Issue 4): negative navy → neutral card → positive
    // orange. No hardcoded hex; tracks Light/Dark via the live tokens.
    const c = chartColors();
    const heatNeg = c.negative;
    const heatMid = readCssVar("--card") || "#ffffff";
    const heatPos = c.positive;
    // Undefined correlations (constant column / too few pairs) stay `null` — NOT
    // the string "-" — so ECharts renders them as an empty cell instead of an
    // unmappable value that the visualMap colours black.
    const data: [number, number, number | null][] = [];
    for (let i = 0; i < cols.length; i++) {
      for (let j = 0; j < cols.length; j++) {
        const v = matrix[i]?.[j];
        data.push([i, j, v == null ? null : Number(v.toFixed(2))]);
      }
    }
    return {
      animationDuration: 400,
      grid: { left: 4, right: 12, top: 8, bottom: 64, containLabel: true },
      tooltip: {
        position: "top",
        formatter: (p: unknown) => {
          const d = p as { value?: [number, number, number | null] };
          const v = d?.value;
          if (!v) return "";
          const x = cols[v[0]] ?? "", y = cols[v[1]] ?? "";
          const r = typeof v[2] === "number" ? v[2].toFixed(2) : "—";
          return `${y} × ${x}: <b>${r}</b>`;
        },
      },
      xAxis: {
        type: "category",
        data: cols,
        axisTick: { show: false },
        axisLabel: { rotate: 45, fontSize: 10, interval: 0 },
        splitArea: { show: true },
      },
      yAxis: {
        type: "category",
        data: [...cols].reverse(),
        axisTick: { show: false },
        axisLabel: { fontSize: 10 },
        splitArea: { show: true },
      },
      visualMap: {
        min: -1, max: 1, calculable: true, orient: "horizontal", left: "center", bottom: 8,
        // Theme-bound diverging scale: negative → neutral → positive.
        inRange: { color: [heatNeg, heatMid, heatPos] },
        text: ["+1", "−1"],
      },
      series: [
        {
          type: "heatmap",
          // y reversed on the axis, so flip the y index to match.
          data: data.map(([x, y, v]) => [x, cols.length - 1 - y, v] as [number, number, number | null]),
          label: {
            show: cols.length <= 12,
            formatter: (p) => {
              const val = (p.value as [number, number, number | null])[2];
              return typeof val === "number" ? val.toFixed(2) : "";
            },
            fontSize: 10,
          },
          itemStyle: { borderColor: "transparent", borderWidth: 1 },
        },
      ],
    };
  }, [cols, matrix, resolvedMode]);

  const loading =
    corr.isLoading || (needFallback && (preview.isLoading || dsMeta.isLoading));
  if (loading) return <Skeleton className="h-64 w-full rounded-md" />;

  if (cols.length === 0) {
    return (
      <EmptyState
        title="No numeric exogenous variables available"
        description="This dataset has no numeric driver columns (Price, Promotion, Discount, …) to correlate."
      />
    );
  }
  if (cols.length === 1) {
    return (
      <EmptyState
        title="At least two numeric exogenous variables are required"
        description="A correlation heatmap needs two or more numeric exogenous drivers to compare."
      />
    );
  }

  return <EChartBase option={option} height={Math.max(280, cols.length * 34 + 150)} />;
}
