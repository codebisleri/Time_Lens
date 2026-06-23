"use client";

import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChartBase } from "@/components/charts/echart-base";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/feedback/empty-state";
import { useThemeMode } from "@/lib/theme/use-theme-mode";
import { useAsync } from "@/lib/hooks";
import { formatForecastLevel } from "@/lib/utils/format";
import { dataService } from "@/lib/api/services";

const NUMERIC_RX = /int|float|double|decimal|numeric|number|real|long/i;

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
 * Exogenous Correlation Heatmap (Phase X.T · Task 4). Pearson correlation of the
 * Demand column against every NUMERIC exogenous variable, computed client-side
 * from the dataset preview rows. ID / Date / Forecast-Level / Demand columns are
 * excluded — only true numeric drivers (Price, Promotion, Discount, …) are shown.
 */
export function EdaCorrelationHeatmap({ datasetId }: { datasetId: string }) {
  const { resolvedMode } = useThemeMode();
  const preview = useAsync(
    () => (datasetId ? dataService.preview(datasetId, 5000) : Promise.resolve(null)),
    [datasetId],
  );
  const ds = useAsync(
    () => (datasetId ? dataService.getDataset(datasetId) : Promise.resolve(null)),
    [datasetId],
  );

  const corrs = useMemo(() => {
    const rows = preview.data?.rows ?? [];
    const schema = preview.data?.schema ?? [];
    if (!rows.length || !schema.length) return [] as { col: string; r: number }[];

    const cfg = ds.data?.config;
    const salesCol = cfg?.salesCol ?? null;
    const exclude = new Set<string>(
      [
        cfg?.dateCol,
        cfg?.skuCol,
        salesCol,
        ...(cfg?.forecastLevelCols ?? []),
      ].filter(Boolean) as string[],
    );

    // The demand column: configured sales column, else the first numeric column.
    const numericCols = schema.filter((s) => NUMERIC_RX.test(s.dtype)).map((s) => s.column);
    const demandCol = salesCol && numericCols.includes(salesCol) ? salesCol : numericCols[0];
    if (!demandCol) return [];

    const candidateCols = numericCols.filter((c) => c !== demandCol && !exclude.has(c));
    const out: { col: string; r: number }[] = [];
    for (const c of candidateCols) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const row of rows) {
        const draw = row[demandCol];
        const craw = row[c];
        if (draw == null || draw === "" || craw == null || craw === "") continue;
        const dv = Number(draw);
        const cv = Number(craw);
        if (Number.isFinite(dv) && Number.isFinite(cv)) {
          xs.push(cv);
          ys.push(dv);
        }
      }
      const r = pearson(xs, ys);
      if (r != null) out.push({ col: c, r });
    }
    out.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
    return out;
  }, [preview.data, ds.data]);

  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    return {
      animationDuration: 400,
      grid: { left: 4, right: 60, top: 8, bottom: 56, containLabel: true },
      tooltip: {
        position: "top",
        formatter: (p: unknown) => {
          const d = p as { name?: string; value?: [number, number, number] };
          return `${d?.name ?? ""}: <b>${(d?.value?.[2] ?? 0).toFixed(2)}</b>`;
        },
      },
      xAxis: { type: "category", data: ["Demand"], axisTick: { show: false }, splitArea: { show: true } },
      yAxis: {
        type: "category",
        data: corrs.map((c) => formatForecastLevel(c.col)).reverse(),
        axisTick: { show: false },
        splitArea: { show: true },
      },
      visualMap: {
        min: -1, max: 1, calculable: true, orient: "horizontal", left: "center", bottom: 4,
        inRange: { color: ["#2563eb", "#f1f5f9", "#dc2626"] },
        text: ["+1", "−1"],
      },
      series: [
        {
          type: "heatmap",
          data: corrs.map((c, i) => ({ name: formatForecastLevel(c.col), value: [0, corrs.length - 1 - i, c.r] as [number, number, number] })),
          label: { show: true, formatter: (p) => ((p.value as [number, number, number])[2]).toFixed(2) },
          itemStyle: { borderColor: "transparent", borderWidth: 1 },
        },
      ],
    };
  }, [corrs, resolvedMode]);

  if (preview.isLoading || ds.isLoading) return <Skeleton className="h-48 w-full rounded-md" />;
  if (!corrs.length) {
    return (
      <EmptyState
        title="No numeric exogenous variables available"
        description="This dataset has no numeric driver columns (Price, Promotion, Discount, …) to correlate against demand."
      />
    );
  }
  return <EChartBase option={option} height={Math.max(160, corrs.length * 44 + 80)} />;
}
