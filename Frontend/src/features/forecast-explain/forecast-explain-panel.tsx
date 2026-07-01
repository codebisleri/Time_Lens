"use client";

import { useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import { Copy, Check, Printer, Sparkles } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EChartBase } from "@/components/charts/echart-base";
import { Markdown } from "@/features/assistant/markdown";
import { useAsync } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils/format";
import { ciMethodName, FEATURE_LABELS } from "@/lib/utils/routing-summary";
import { chartColors } from "@/lib/charts/colors";
import { forecastService, segmentationService } from "@/lib/api/services";
import { useForecastStore } from "@/lib/stores/forecast-store";
import type { ForecastMetricRow } from "@/types/forecast";

type Scope = "full" | "model" | "exog" | "arithmetic";

const SCOPES: { value: Scope; label: string }[] = [
  { value: "full", label: "Full explanation" },
  { value: "model", label: "Model only" },
  { value: "exog", label: "Variables only" },
  { value: "arithmetic", label: "Arithmetic only" },
];

const pct = (v: number | null | undefined) =>
  v == null ? "—" : `${(v <= 1 ? v * 100 : v).toFixed(1)}%`;

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Forecast Explainability panel (Phase X.R). A read-only "Explain This Forecast"
 * trace: it SURFACES the metadata the engine already produced for one entity
 * (segment classification, candidate competition + WMAPE, champion, residual
 * model, confidence-interval method, per-period arithmetic) and an AI summary.
 * It never re-runs or re-computes anything — pure explanation/visualization.
 */
export function ForecastExplainPanel({
  open,
  onOpenChange,
  row,
  datasetId,
  levelLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: ForecastMetricRow | null;
  datasetId?: string;
  levelLabel: string;
}) {
  const [scope, setScope] = useState<Scope>("full");
  const topDownEnabled = useForecastStore((s) => s.topDownEnabled);

  // All three data sources are EXISTING read-only endpoints; fetched only while
  // the panel is open for a specific entity.
  const detail = useAsync(
    () => (open && row ? forecastService.getById(row.id) : Promise.resolve(null)),
    [open, row?.id],
  );
  const trace = useAsync(
    () => (open && row ? segmentationService.trace(row.sku).catch(() => null) : Promise.resolve(null)),
    [open, row?.sku],
  );
  const seg = useAsync(
    () => (open ? segmentationService.get().catch(() => null) : Promise.resolve(null)),
    [open, datasetId],
  );

  const segSku = useMemo(
    () => seg.data?.skus.find((s) => s.sku === row?.sku) ?? null,
    [seg.data, row?.sku],
  );
  const architecture = useMemo(
    () => seg.data?.segments.find((s) => s.segment === row?.segment)?.architecture ?? null,
    [seg.data, row?.segment],
  );

  const champion = useMemo(
    () => row?.allModels.find((m) => m.isChampion) ?? null,
    [row],
  );
  const showModel = scope === "full" || scope === "model";
  const showExog = scope === "full" || scope === "exog";
  const showArith = scope === "full" || scope === "arithmetic";

  // Model-competition WMAPE bar chart (Task 12 / Task 6).
  const competitionOption = useMemo<EChartsOption>(() => {
    const c = chartColors(); // theme-bound champion/other colours (Issue 4)
    const models = [...(row?.allModels ?? [])]
      .filter((m) => m.testWmape != null)
      .sort((a, b) => (a.testWmape ?? 0) - (b.testWmape ?? 0));
    return {
      animationDuration: 400,
      grid: { left: 4, right: 28, top: 8, bottom: 4, containLabel: true },
      tooltip: { trigger: "axis", valueFormatter: (v) => `${Number(v).toFixed(1)}%` },
      xAxis: { type: "value", name: "WMAPE %" },
      yAxis: { type: "category", data: models.map((m) => m.label).reverse(), axisTick: { show: false } },
      series: [
        {
          type: "bar",
          barWidth: "60%",
          data: models
            .map((m) => ({
              value: m.testWmape! <= 1 ? m.testWmape! * 100 : m.testWmape!,
              itemStyle: { color: m.isChampion ? c.accent : c.neutral },
            }))
            .reverse(),
          label: { show: true, position: "right", formatter: (p) => `${Number(p.value).toFixed(1)}%` },
          itemStyle: { borderRadius: [0, 4, 4, 0] },
        },
      ],
    };
  }, [row]);

  // Per-period forecast arithmetic + confidence interval (from the detail series).
  const periods = useMemo(() => {
    const series = detail.data?.series ?? [];
    const actualBy = new Map<string, number>();
    for (const p of detail.data?.testActual ?? []) if (p.value != null) actualBy.set(p.date, p.value);
    return series
      .filter((p) => p.forecast != null)
      .map((p) => {
        const actual = p.actual ?? actualBy.get(p.date) ?? null;
        return {
          date: p.date,
          forecast: p.forecast ?? null,
          lower: p.lowerBound ?? null,
          upper: p.upperBound ?? null,
          actual,
          residual: actual != null && p.forecast != null ? actual - p.forecast : null,
        };
      });
  }, [detail.data]);

  // Deterministic "Why this forecast?" summary (always available); the AI button
  // can enrich it via the assistant proxy.
  const baseSummary = useMemo(() => {
    if (!row) return "";
    const seg = row.segment ?? "its segment";
    const champ = champion?.label ?? row.strategyLabel;
    const w = pct(row.testWmape);
    const feats = (architecture?.features ?? [])
      .map((f) => FEATURE_LABELS[f] ?? f)
      .slice(0, 3)
      .join(", ");
    const ci = ciMethodName(architecture?.ciSource);
    return (
      `**${row.sku}** was classified as **${seg}**. ` +
      `In the multi-model competition, **${champ}** won with the lowest hold-out WMAPE (**${w}**). ` +
      (feats ? `The strongest engineered drivers were ${feats}. ` : "") +
      (architecture?.residualBooster
        ? `A ${architecture.residualBooster.toUpperCase()} residual-correction layer refined systematic errors. `
        : "") +
      (ci ? `Confidence intervals were produced via ${ci}.` : "")
    );
  }, [row, champion, architecture]);

  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const askAi = async () => {
    if (!row) return;
    setAiBusy(true);
    try {
      const meta =
        `Explain this forecast as the "Why this forecast?" summary in 4-5 sentences. ` +
        `Entity: ${row.sku}. Segment: ${row.segment}. ` +
        `Champion model: ${champion?.label ?? row.strategyLabel} (hold-out WMAPE ${pct(row.testWmape)}). ` +
        `Candidates: ${(row.allModels ?? []).map((m) => `${m.label} ${pct(m.testWmape)}`).join(", ")}. ` +
        `Model features: ${(architecture?.features ?? []).map((f) => FEATURE_LABELS[f] ?? f).join(", ") || "n/a"}. ` +
        `Residual model: ${architecture?.residualBooster?.toUpperCase() ?? "none"}. ` +
        `CI method: ${ciMethodName(architecture?.ciSource) ?? "n/a"}.`;
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: meta }],
          context: { page: "Forecast Explainability", step: `Explain ${levelLabel}` },
        }),
      });
      const data = await res.json();
      setAiSummary(res.ok ? data.reply : baseSummary);
    } catch {
      setAiSummary(baseSummary);
    } finally {
      setAiBusy(false);
    }
  };

  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(aiSummary ?? baseSummary);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const loading = detail.isLoading || seg.isLoading;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full max-w-xl flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        <SheetHeader className="shrink-0 border-b border-border p-4 print:hidden">
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" /> Forecast Explainability —{" "}
            <span className="font-mono">{row?.sku ?? "—"}</span>
          </SheetTitle>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="inline-flex flex-wrap rounded-md border border-border p-0.5">
              {SCOPES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setScope(s.value)}
                  className={cn(
                    "rounded px-2.5 py-1 text-xs transition-colors",
                    scope === s.value
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              <Printer className="size-3.5" /> Export
            </Button>
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
          {!row ? (
            <p className="text-sm text-muted-foreground">Select a {levelLabel.toLowerCase()} to explain.</p>
          ) : loading ? (
            <div className="space-y-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : (
            <>
              {/* Title for print/export */}
              <div className="hidden print:block">
                <h2 className="text-lg font-semibold">Forecast Explainability Report — {row.sku}</h2>
              </div>

              {/* AI summary (Task 13) */}
              <Section title="Why this forecast?">
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                  <Markdown text={aiSummary ?? baseSummary} />
                  <div className="mt-2 flex gap-2 print:hidden">
                    <Button variant="outline" size="sm" onClick={askAi} disabled={aiBusy}>
                      <Sparkles className="size-3.5" /> {aiBusy ? "Generating…" : "Ask AI to elaborate"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={copySummary}>
                      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </div>
              </Section>

              {/* Segment explanation (Task 4) */}
              <Section title="Segment classification">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border border-border p-3 text-sm sm:grid-cols-3">
                  <Meta label={levelLabel}>{row.sku}</Meta>
                  <Meta label="Segment">{row.segment ?? "—"}</Meta>
                  <Meta label="Demand pattern">{segSku?.intermittency ?? "—"}</Meta>
                  <Meta label="CV²">{segSku?.cv != null ? segSku.cv.toFixed(2) : "—"}</Meta>
                  <Meta label="Contribution">
                    {segSku?.revenueSharePct != null ? `${segSku.revenueSharePct.toFixed(2)}%` : "—"}
                  </Meta>
                  <Meta label="History">{segSku ? `${segSku.nPeriods} periods` : "—"}</Meta>
                </dl>
                {trace.data?.steps?.length ? (
                  <ol className="space-y-1 rounded-lg border border-border/60 p-3 text-xs text-muted-foreground">
                    {trace.data.steps.map((s) => (
                      <li key={s.step}>
                        <span className="font-medium text-foreground">{s.name}:</span> {s.detail}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </Section>

              {/* Exogenous variables / model drivers (Task 5) */}
              {showExog ? (
                <Section title="Variables & drivers">
                  {architecture?.features?.length ? (
                    <div className="overflow-hidden rounded-lg border border-border">
                      <table className="w-full text-sm">
                        <thead className="bg-secondary/40 text-xs uppercase tracking-wide text-muted-foreground">
                          <tr>
                            <th className="px-3 py-1.5 text-left font-medium">Variable</th>
                            <th className="px-3 py-1.5 text-left font-medium">Used</th>
                            <th className="px-3 py-1.5 text-left font-medium">Source</th>
                          </tr>
                        </thead>
                        <tbody>
                          {architecture.features.map((f) => (
                            <tr key={f} className="border-t border-border/60">
                              <td className="px-3 py-1.5">{FEATURE_LABELS[f] ?? f}</td>
                              <td className="px-3 py-1.5 text-success">Yes</td>
                              <td className="px-3 py-1.5 text-muted-foreground">Segment recipe</td>
                            </tr>
                          ))}
                          {architecture.residualBooster ? (
                            <tr className="border-t border-border/60">
                              <td className="px-3 py-1.5">{architecture.residualBooster.toUpperCase()} residual</td>
                              <td className="px-3 py-1.5 text-success">Yes</td>
                              <td className="px-3 py-1.5 text-muted-foreground">Post-hoc correction</td>
                            </tr>
                          ) : null}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No engineered drivers recorded for this segment.</p>
                  )}
                </Section>
              ) : null}

              {/* Candidate model competition (Tasks 6 & 12) */}
              {showModel ? (
                <Section title="Candidate model competition">
                  <div className="overflow-hidden rounded-lg border border-border">
                    <table className="w-full text-sm">
                      <thead className="bg-secondary/40 text-xs uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="px-3 py-1.5 text-left font-medium">Model</th>
                          <th className="px-3 py-1.5 text-right font-medium">WMAPE</th>
                          <th className="px-3 py-1.5 text-left font-medium">Outcome</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...(row.allModels ?? [])]
                          .sort((a, b) => (a.testWmape ?? 99) - (b.testWmape ?? 99))
                          .map((m) => (
                            <tr key={m.algorithm} className={cn("border-t border-border/60", m.isChampion && "bg-success/5")}>
                              <td className="px-3 py-1.5 font-medium">
                                {m.isChampion ? "★ " : ""}
                                {m.label}
                              </td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{pct(m.testWmape)}</td>
                              <td className="px-3 py-1.5 text-xs text-muted-foreground">
                                {m.isChampion ? "Champion — lowest WMAPE" : m.reason || "Higher error"}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  {row.allModels?.some((m) => m.testWmape != null) ? (
                    <EChartBase option={competitionOption} height={Math.max(140, (row.allModels?.length ?? 1) * 30)} />
                  ) : null}
                </Section>
              ) : null}

              {/* Champion explanation (Task 7) */}
              {showModel ? (
                <Section title="Champion">
                  <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-sm">
                    <p className="font-semibold text-foreground">{champion?.label ?? row.strategyLabel}</p>
                    <p className="mt-1 text-muted-foreground">
                      {champion?.reason || "Chosen for the lowest hold-out WMAPE among the candidates."}{" "}
                      Hold-out WMAPE {pct(row.testWmape)}, bias {row.bias != null ? `${row.bias.toFixed(1)}%` : "—"},
                      SMAPE {pct(row.smape)}.
                    </p>
                  </div>
                </Section>
              ) : null}

              {/* Residual correction (Task 8) */}
              {showModel ? (
                <Section title="Residual correction">
                  {architecture?.residualBooster ? (
                    <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
                      A <span className="font-medium text-foreground">{architecture.residualBooster.toUpperCase()}</span>{" "}
                      residual model is applied post-hoc to the base forecast — it learns the champion&apos;s systematic
                      errors (e.g. promo under-forecasting) and adds a correction, improving the final accuracy.
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">No residual-correction layer for this segment.</p>
                  )}
                </Section>
              ) : null}

              {/* Confidence intervals (Task 9) */}
              {showArith ? (
                <Section title="Confidence intervals">
                  <p className="text-sm text-muted-foreground">
                    Method: <span className="font-medium text-foreground">{ciMethodName(architecture?.ciSource) ?? "engine default"}</span>{" "}
                    — the P10 (lower) / P50 (point) / P90 (upper) band below quantifies forecast uncertainty.
                  </p>
                </Section>
              ) : null}

              {/* Forecast arithmetic + CI per period (Tasks 10 & 9) */}
              {showArith ? (
                <Section title="Forecast arithmetic (per period)">
                  {periods.length ? (
                    <div className="max-h-72 overflow-auto rounded-lg border border-border">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-secondary/40 text-xs uppercase tracking-wide text-muted-foreground">
                          <tr>
                            <th className="px-3 py-1.5 text-left font-medium">Period</th>
                            <th className="px-3 py-1.5 text-right font-medium">P10</th>
                            <th className="px-3 py-1.5 text-right font-medium">Forecast</th>
                            <th className="px-3 py-1.5 text-right font-medium">P90</th>
                            <th className="px-3 py-1.5 text-right font-medium">Actual</th>
                            <th className="px-3 py-1.5 text-right font-medium">Residual</th>
                          </tr>
                        </thead>
                        <tbody>
                          {periods.map((p) => (
                            <tr key={p.date} className="border-t border-border/60">
                              <td className="px-3 py-1.5">{p.date}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                                {p.lower != null ? formatNumber(p.lower, { maximumFractionDigits: 0 }) : "—"}
                              </td>
                              <td className="px-3 py-1.5 text-right font-medium tabular-nums">
                                {p.forecast != null ? formatNumber(p.forecast, { maximumFractionDigits: 0 }) : "—"}
                              </td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                                {p.upper != null ? formatNumber(p.upper, { maximumFractionDigits: 0 }) : "—"}
                              </td>
                              <td className="px-3 py-1.5 text-right tabular-nums">
                                {p.actual != null ? formatNumber(p.actual, { maximumFractionDigits: 0 }) : "—"}
                              </td>
                              <td className={cn("px-3 py-1.5 text-right tabular-nums", p.residual != null && p.residual < 0 ? "text-destructive" : "text-foreground")}>
                                {p.residual != null ? formatNumber(p.residual, { maximumFractionDigits: 0 }) : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No per-period series available for this forecast.</p>
                  )}
                </Section>
              ) : null}

              {/* Top-down explanation (Task 11) */}
              {topDownEnabled ? (
                <Section title="Top-Down allocation">
                  <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
                    This run used <span className="font-medium text-foreground">Top-Down</span> forecasting: a stable
                    aggregate was forecast and allocated back to each {levelLabel.toLowerCase()} by its historical
                    contribution share, then reconciled.
                  </p>
                </Section>
              ) : null}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm text-foreground">{children}</dd>
    </div>
  );
}
