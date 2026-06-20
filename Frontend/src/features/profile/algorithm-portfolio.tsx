"use client";

import { useMemo } from "react";
import { Cpu, Layers3, ListChecks, PlusCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatNumber, formatPercent } from "@/lib/utils/format";
import type { ForecastAlgorithms } from "@/types/forecast";
import type { StrategyDistItem } from "@/types/segmentation";

/**
 * Final Algorithm Selection — parity with Streamlit `_render_algorithm_portfolio`
 * (app_v2_6 (1).py:9068). Shows the recommended-algorithm distribution table, the
 * auto-routed algorithm cards (icon · name · family · use-case · assigned SKUs),
 * the additional/benchmark algorithms available in the Forecast step, and the
 * portfolio summary. Read-only mirror — selection happens in the Forecast tab.
 */
export function AlgorithmPortfolio({
  strategyDistribution,
  algorithms,
}: {
  strategyDistribution: StrategyDistItem[];
  algorithms: ForecastAlgorithms | null;
}) {
  const info = useMemo(() => {
    const m = new Map<string, { name: string; family: string | null; icon: string | null; description: string | null }>();
    for (const a of algorithms?.strategyInfo ?? []) m.set(a.key, a);
    return m;
  }, [algorithms]);

  const routed = useMemo(
    () => strategyDistribution.filter((s) => s.count > 0).sort((a, b) => b.count - a.count),
    [strategyDistribution],
  );
  const totalSkus = useMemo(() => routed.reduce((acc, s) => acc + s.count, 0), [routed]);
  const additional = algorithms?.additionalAlgorithms ?? [];
  const totalActive = routed.length + additional.length;

  if (!routed.length) return null;

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-base font-semibold tracking-tight text-foreground">
          <Cpu className="size-4 text-primary" /> Final Algorithm Selection
        </h3>
        <p className="text-sm text-muted-foreground">
          Every SKU is auto-routed to a best-fit model family. These run in the
          Forecast step; disabled families fall back to Ensemble Local.
        </p>
      </div>

      {/* Portfolio summary */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <SummaryTile icon={ListChecks} label="Active algorithms" value={formatNumber(totalActive)}
          meta={`${routed.length} routed + ${additional.length} additional`} />
        <SummaryTile icon={Layers3} label="Auto-routed families" value={formatNumber(routed.length)} />
        <SummaryTile icon={PlusCircle} label="Additional available" value={formatNumber(additional.length)} />
        <SummaryTile icon={Cpu} label="SKU coverage" value={formatNumber(totalSkus)} meta="across all families" />
      </div>

      {/* Recommended algorithm distribution table */}
      <Card>
        <CardContent className="space-y-3 pt-6">
          <h4 className="text-sm font-semibold text-foreground">Recommended algorithm distribution</h4>
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border bg-secondary/40">
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Algorithm</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Family</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">SKUs</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Share</th>
                </tr>
              </thead>
              <tbody>
                {routed.map((s) => (
                  <tr key={s.strategy} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2 text-sm font-medium text-foreground">
                      {info.get(s.strategy)?.name ?? s.label}
                    </td>
                    <td className="px-3 py-2 text-sm text-muted-foreground">
                      {info.get(s.strategy)?.family ?? s.family ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-sm tabular-nums">{formatNumber(s.count)}</td>
                    <td className="px-3 py-2 text-right text-sm tabular-nums text-muted-foreground">
                      {totalSkus ? formatPercent(s.count / totalSkus) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Auto-routed algorithm cards */}
      <div className="space-y-2">
        <h4 className="text-sm font-semibold text-foreground">Auto-routed algorithms</h4>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {routed.map((s) => {
            const a = info.get(s.strategy);
            return (
              <AlgoCard
                key={s.strategy}
                icon={a?.icon ?? "🤖"}
                name={a?.name ?? s.label}
                family={a?.family ?? s.family}
                description={a?.description ?? null}
                pill={`${formatNumber(s.count)} SKUs`}
                pillTone="brand"
              />
            );
          })}
        </div>
      </div>

      {/* Additional / benchmark algorithms */}
      {additional.length ? (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-foreground">Additional algorithms (benchmarks)</h4>
          <p className="text-xs text-muted-foreground">
            Optional models you can add to the competition in the Forecast step.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {additional.map((a) => (
              <AlgoCard
                key={a.key}
                icon={a.icon ?? "➕"}
                name={a.name}
                family={a.family}
                description={a.description}
                pill="Benchmark"
                pillTone="muted"
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SummaryTile({
  icon: Icon,
  label,
  value,
  meta,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  meta?: string;
}) {
  return (
    <Card className="glass p-4">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3.5 text-primary" /> {label}
      </div>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
      {meta ? <p className="mt-0.5 text-xs text-muted-foreground">{meta}</p> : null}
    </Card>
  );
}

function AlgoCard({
  icon,
  name,
  family,
  description,
  pill,
  pillTone,
}: {
  icon: string;
  name: string;
  family: string | null;
  description: string | null;
  pill: string;
  pillTone: "brand" | "muted";
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 transition-colors hover:border-brand/40">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-lg leading-none" aria-hidden>{icon}</span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{name}</p>
            {family ? <p className="truncate text-[11px] text-muted-foreground">{family}</p> : null}
          </div>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
            pillTone === "brand"
              ? "bg-primary/15 text-primary"
              : "border border-border bg-secondary text-muted-foreground",
          )}
        >
          {pill}
        </span>
      </div>
      {description ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}
