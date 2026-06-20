"use client";

import { useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/feedback/empty-state";
import { EChartBase } from "@/components/charts/echart-base";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { Select } from "@/features/data/controls";
import { useAsync } from "@/lib/hooks";
import { useThemeMode } from "@/lib/theme/use-theme-mode";
import { readCssVar } from "@/lib/theme/theme-config";
import { downloadFile } from "@/lib/utils/download";
import { formatCompact, formatDate, formatNumber } from "@/lib/utils/format";
import { forecastService } from "@/lib/api/services";
import type { BrandReconciliation } from "@/types/forecast";

const num = (v: number | null) =>
  v == null || !Number.isFinite(v) ? "—" : formatNumber(Math.round(v));

// F.16 — STRICT navy + orange + neutral grey only (no blue/green/purple).
// Differentiation is via neutral-vs-orange + line weight/dash, not extra hues.
const ORANGE = "#EF7602";

/**
 * Reconciled forecast chart for one brand — Streamlit parity: historical actual
 * continuing into the forecast split, previous-year overlay, then bottom-up /
 * top-down / reconciled over the horizon, with a forecast-boundary marker.
 */
function ReconChart({ brand }: { brand: BrandReconciliation }) {
  const { resolvedMode } = useThemeMode();
  const option = useMemo<EChartsOption>(() => {
    void resolvedMode;
    // Theme-aware neutrals (navy in light, white in dark) + orange accent only.
    const RECON_COLORS = {
      history: readCssVar("--foreground") || "#0a1f3a",
      previousYear: "rgba(239,118,2,0.45)",
      bottomUp: readCssVar("--muted-foreground") || "#8d99a6",
      topDown: ORANGE,
      reconciled: ORANGE,
    };
    const fc = brand.series;
    const hist = brand.history ?? [];
    const histMap = new Map(hist.map((p) => [p.date, p.value]));
    const pvMap = new Map((brand.previousYear ?? []).map((p) => [p.date, p.value]));
    const fcMap = new Map(fc.map((p) => [p.date, p]));

    // Unified, sorted date axis across history + forecast.
    const allDates = Array.from(
      new Set([...hist.map((p) => p.date), ...fc.map((p) => p.date)]),
    ).sort();
    const labels = allDates.map((d) => formatDate(d, { month: "short", year: "2-digit" }));

    const historyLine = allDates.map((d) => (histMap.has(d) ? histMap.get(d) ?? null : null));
    const prevYearLine = allDates.map((d) => pvMap.get(d) ?? null);
    const bottomUpLine = allDates.map((d) => fcMap.get(d)?.bottomUp ?? null);
    const topDownLine = allDates.map((d) => fcMap.get(d)?.topDown ?? null);
    const reconciledLine = allDates.map((d) => fcMap.get(d)?.reconciled ?? null);

    // Forecast boundary = first forecast date; bridge the history line into it so
    // it visually continues into the split (Streamlit behavior).
    const firstFcDate = fc.length ? fc[0]!.date : null;
    const splitIdx = firstFcDate ? allDates.indexOf(firstFcDate) : -1;
    let lastHistIdx = -1;
    for (let i = 0; i < historyLine.length; i++) if (historyLine[i] != null) lastHistIdx = i;
    if (splitIdx > 0 && lastHistIdx >= 0 && lastHistIdx < splitIdx) {
      const bridge = historyLine[lastHistIdx]!;
      if (bottomUpLine[lastHistIdx] == null) bottomUpLine[lastHistIdx] = bridge;
      if (topDownLine[lastHistIdx] == null) topDownLine[lastHistIdx] = bridge;
      if (reconciledLine[lastHistIdx] == null) reconciledLine[lastHistIdx] = bridge;
    }
    const boundaryLabel = splitIdx >= 0 ? labels[splitIdx] : null;

    const line = (
      name: string,
      data: (number | null)[],
      color: string,
      lineStyle: Record<string, unknown> = {},
    ) => ({
      name, type: "line" as const, smooth: true, showSymbol: false, connectNulls: false,
      data, lineStyle: { width: 2.5, color, ...lineStyle }, itemStyle: { color },
    });

    return {
      animationDuration: 600,
      tooltip: {
        trigger: "axis",
        valueFormatter: (v) => (v == null ? "—" : formatNumber(v as number)),
      },
      legend: {
        data: [
          ...(hist.length ? ["Historical actual"] : []),
          ...(pvMap.size ? ["Previous year"] : []),
          "Bottom-up", "Top-down", "Reconciled",
        ],
        left: 0, // §11 — top-left, clear of the top-right toolbar
        top: 0,
        itemWidth: 14,
      },
      grid: { left: 4, right: 8, top: 44, bottom: 4, containLabel: true },
      xAxis: { type: "category", boundaryGap: false, data: labels },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => formatCompact(v) } },
      series: [
        ...(hist.length ? [line("Historical actual", historyLine, RECON_COLORS.history)] : []),
        ...(pvMap.size
          ? [line("Previous year", prevYearLine, RECON_COLORS.previousYear, { width: 2, type: "dashed" })]
          : []),
        line("Bottom-up", bottomUpLine, RECON_COLORS.bottomUp),
        line("Top-down", topDownLine, RECON_COLORS.topDown, { width: 2.5, type: "dashed" }),
        {
          ...line("Reconciled", reconciledLine, RECON_COLORS.reconciled, { width: 3.5 }),
          markLine: boundaryLabel
            ? {
                silent: true,
                symbol: "none",
                lineStyle: { color: RECON_COLORS.reconciled, type: "dashed", width: 1.5, opacity: 0.7 },
                label: { formatter: "Forecast →", color: RECON_COLORS.reconciled, fontSize: 10, position: "insideEndTop" },
                data: [{ xAxis: boundaryLabel }],
              }
            : undefined,
        },
      ],
      color: [
        RECON_COLORS.history, RECON_COLORS.previousYear,
        RECON_COLORS.bottomUp, RECON_COLORS.topDown, RECON_COLORS.reconciled,
      ],
    };
  }, [brand, resolvedMode]);
  return <EChartBase option={option} height={500} />;
}

/** Brand reconciliation table → CSV (Period, Bottom-up, Top-down, Reconciled). */
function exportReconCsv(brand: BrandReconciliation): void {
  const header = ["Period", "Bottom-up", "Top-down", "Reconciled"];
  const lines = brand.series.map((p) =>
    [
      formatDate(p.date, { month: "short", year: "numeric" }),
      p.bottomUp ?? "",
      p.topDown ?? "",
      p.reconciled ?? "",
    ].join(","),
  );
  downloadFile(
    `reconciliation-${brand.brand.replace(/\s+/g, "_")}.csv`,
    [header.join(","), ...lines].join("\n"),
  );
}

/**
 * Brand-Level Reconciliation — restores the Streamlit Forecast-tab section that
 * only appears when the run was reconciled to brand totals: a per-brand
 * bottom-up vs top-down vs reconciled chart plus the reconciled values table.
 */
export function ReconciliationSection({
  datasetId,
  runId,
}: {
  datasetId?: string;
  runId?: string | null;
}) {
  const recon = useAsync(
    () => forecastService.reconciliation({ datasetId, runId: runId ?? undefined }),
    [datasetId, runId],
  );
  const brands = useMemo(() => recon.data?.reconciliation ?? [], [recon.data]);
  const [brand, setBrand] = useState<string>("");
  const active = brands.find((b) => b.brand === brand) ?? brands[0];

  if (recon.isLoading) return <Skeleton className="h-72 w-full" />;
  if (recon.isError || !brands.length) {
    return (
      <EmptyState
        title="No reconciliation"
        description="This run was not reconciled to brand totals — re-run with the toggle on."
      />
    );
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            Bottom-up (sum of SKU forecasts) vs top-down (brand-level) vs the reconciled blend.
          </p>
          <div className="sm:w-56">
            <Select
              ariaLabel="Brand"
              value={active?.brand ?? ""}
              onChange={setBrand}
              options={brands.map((b) => ({ value: b.brand, label: b.brand }))}
            />
          </div>
        </div>

        {active ? <ReconChart brand={active} /> : null}

        {active ? (
          <div className="max-h-72 overflow-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-secondary/40 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Period</th>
                  <th className="px-3 py-2 text-right font-medium">Bottom-up</th>
                  <th className="px-3 py-2 text-right font-medium">Top-down</th>
                  <th className="px-3 py-2 text-right font-medium">Reconciled</th>
                </tr>
              </thead>
              <tbody>
                {active.series.map((p) => (
                  <tr key={p.date} className="border-t border-border/60">
                    <td className="px-3 py-1.5">{formatDate(p.date, { month: "short", year: "2-digit" })}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{num(p.bottomUp)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{num(p.topDown)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{num(p.reconciled)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {active ? (
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={() => exportReconCsv(active)}>
              <Download className="size-4" /> Brand reconciliation (CSV)
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
