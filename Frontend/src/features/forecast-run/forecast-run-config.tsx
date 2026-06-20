"use client";

import { useMemo } from "react";
import { Loader2, Play, Sparkles, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Check, Field, NumberInput, Select } from "@/features/data/controls";
import type { ForecastAlgorithms } from "@/types/forecast";

const ALL_BRANDS = "__all_brands__";

export interface RunConfig {
  forecastMode: "portfolio" | "single_sku";
  selectionMode: "pick" | "sample" | "all";
  brands: string[];
  segments: string[];
  skuIds: string[];
  samplePerStrategy: number;
  limit: number;
  periods: number;
  compareAlgos: string[];
  cvMode: boolean;
  reconcile: boolean;
  useGlobal: boolean;
  /** Streamlit's "Evaluate out-of-sample accuracy over the forecast horizon"
   *  checkbox — wired to the engine's run_backtest flag. */
  evaluateOos: boolean;
  /** Single-SKU mode: which models compete (Streamlit "Models to compete"). */
  singleSkuModels: string[];
}

// Streamlit single-series "Models to compete" (render_single_series_forecast_tab).
export const SINGLE_SKU_MODELS: { value: string; label: string }[] = [
  { value: "prophet", label: "Prophet" },
  { value: "auto_arima", label: "AutoARIMA" },
  { value: "sarimax", label: "SARIMAX" },
  { value: "arima", label: "ARIMA" },
  { value: "holt_winters", label: "Holt-Winters" },
  { value: "exponential_smoothing", label: "Exponential Smoothing" },
  { value: "lightgbm", label: "LightGBM" },
  { value: "dl_moe", label: "Deep MoE (Keras)" },
];
export const SINGLE_SKU_MODELS_DEFAULT = ["auto_arima", "sarimax", "holt_winters", "lightgbm"];

const MODES: { value: RunConfig["selectionMode"]; label: string }[] = [
  { value: "pick", label: "Pick specific SKUs" },
  { value: "sample", label: "Sample N SKUs per strategy" },
  { value: "all", label: "All SKUs (slow)" },
];

// Streamlit's "Forecast mode" radio (render_unified_forecast_tab), verbatim.
const FORECAST_MODES: { value: RunConfig["forecastMode"]; label: string }[] = [
  { value: "portfolio", label: "A. Portfolio routed forecast" },
  { value: "single_sku", label: "B. Single-SKU multi-model competition" },
];

// Streamlit's "Algorithms to compare" option set (render_forecast_tab `_all_algos`),
// in order. The default selection is the backend `recommended` (6) subset.
const STREAMLIT_ALGOS = [
  "moe", "global_lgbm", "local_sarimax_promo", "prophet", "autoarima",
  "theta", "holt_winters", "croston_sba", "tsb", "naive_seasonal",
];

function toggle(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

/**
 * Forecast configuration — replicates the Streamlit Forecast-tab setup: what to
 * forecast (pick / sample-N / all + brand & segment filters), training options
 * (global LightGBM, reconcile, out-of-sample eval, K-fold CV), the algorithm comparison
 * multiselect (Select all / Reset to recommended), and the horizon.
 */
export function ForecastRunConfig({
  config,
  onChange,
  algorithms,
  brandOptions,
  segmentOptions,
  skuOptions,
  onRun,
  running,
  progress,
  jobStatus,
  jobMessage,
  savedHorizon,
}: {
  config: RunConfig;
  onChange: (patch: Partial<RunConfig>) => void;
  algorithms: ForecastAlgorithms | null;
  brandOptions: string[];
  segmentOptions: string[];
  skuOptions: { sku: string; brand: string | null; segment: string }[];
  onRun: () => void;
  running: boolean;
  progress: number;
  jobStatus: string;
  jobMessage?: string;
  /** Forecast horizon from Configuration & Preparation — the single source of
   *  truth (Issue 6). Displayed read-only here; no duplicate control. */
  savedHorizon?: number;
}) {
  const algoLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of algorithms?.strategyInfo ?? []) m.set(a.key, a.name);
    for (const a of algorithms?.additionalAlgorithms ?? []) m.set(a.key, a.name);
    return m;
  }, [algorithms]);

  const matchesFilter = (
    s: { brand: string | null; segment: string },
    brands: string[],
    segments: string[],
  ) =>
    (brands.length === 0 || (s.brand != null && brands.includes(s.brand))) &&
    (segments.length === 0 || segments.includes(s.segment));

  const filteredSkus = useMemo(
    () => skuOptions.filter((s) => matchesFilter(s, config.brands, config.segments)),
    [skuOptions, config.brands, config.segments],
  );

  // Streamlit behavior: changing a brand/segment filter recomputes the matching
  // SKUs and auto-selects ALL of them (kept in sync with the filter).
  const selectAllMatching = (brands: string[], segments: string[]): string[] =>
    skuOptions.filter((s) => matchesFilter(s, brands, segments)).map((s) => s.sku);

  // Streamlit's "Algorithms to compare" multiselect exposes the 10-algorithm
  // option set (`_all_algos`) and defaults to the 6 `recommended`. Mirror that:
  // show the 10 (filtered to keys the backend actually knows), default-select 6.
  const known = new Set(algoLabel.keys());
  const visibleAlgos = STREAMLIT_ALGOS.filter((k) => known.has(k));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Target className="size-4 text-primary" /> Forecast configuration
        </CardTitle>
        <CardDescription>What to forecast, training options, and the algorithm competition.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Forecast mode — Streamlit's horizontal radio + caption */}
        <section className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">Forecast mode</p>
          <div className="inline-flex flex-wrap rounded-md border border-border p-0.5">
            {FORECAST_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => onChange({ forecastMode: m.value, skuIds: [] })}
                className={cn(
                  "rounded px-3 py-1.5 text-sm transition-colors",
                  config.forecastMode === m.value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Portfolio routing for all SKUs · or multi-model competition for one
          </p>
        </section>

        {/* Forecast Engine */}
        <section className="space-y-3">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">Forecast Engine</p>

          {config.forecastMode === "single_sku" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Filter by brand">
                <Select
                  ariaLabel="Filter by brand"
                  value={config.brands[0] ?? ALL_BRANDS}
                  onChange={(b) => onChange({ brands: b === ALL_BRANDS ? [] : [b], skuIds: [] })}
                  options={[{ value: ALL_BRANDS, label: "All brands" }, ...brandOptions.map((b) => ({ value: b, label: b }))]}
                />
              </Field>
              <Field label={`SKU (${filteredSkus.length} available)`}>
                <Select
                  ariaLabel="Select a SKU"
                  value={config.skuIds[0] ?? ""}
                  onChange={(sku) => onChange({ skuIds: sku ? [sku] : [] })}
                  options={[{ value: "", label: "Select a SKU…" }, ...filteredSkus.map((s) => ({ value: s.sku, label: s.sku }))]}
                />
              </Field>
              <Field label="Models to compete" className="sm:col-span-2">
                <div className="grid grid-cols-1 gap-2 rounded-md border border-border p-2 sm:grid-cols-2 lg:grid-cols-3">
                  {SINGLE_SKU_MODELS.map((m) => (
                    <Check
                      key={m.value}
                      label={m.label}
                      checked={config.singleSkuModels.includes(m.value)}
                      onChange={() => onChange({ singleSkuModels: toggle(config.singleSkuModels, m.value) })}
                    />
                  ))}
                </div>
              </Field>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                The selected models compete head-to-head on this SKU; the champion is chosen by hold-out WMAPE.
              </p>
            </div>
          ) : (
          <>
          <p className="text-xs text-muted-foreground">What to forecast</p>
          <div className="inline-flex flex-wrap rounded-md border border-border p-0.5">
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => onChange({ selectionMode: m.value })}
                className={cn(
                  "rounded px-3 py-1.5 text-sm transition-colors",
                  config.selectionMode === m.value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>

          {config.selectionMode === "pick" ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <Field label="Filter by brand">
                <div className="max-h-40 space-y-1.5 overflow-auto rounded-md border border-border p-2">
                  {brandOptions.length ? brandOptions.map((b) => (
                    <Check key={b} label={b} checked={config.brands.includes(b)} onChange={() => {
                      const brands = toggle(config.brands, b);
                      onChange({ brands, skuIds: selectAllMatching(brands, config.segments) });
                    }} />
                  )) : <p className="text-xs text-muted-foreground">No brands.</p>}
                </div>
              </Field>
              <Field label="Filter by segment">
                <div className="max-h-40 space-y-1.5 overflow-auto rounded-md border border-border p-2">
                  {segmentOptions.length ? segmentOptions.map((s) => (
                    <Check key={s} label={s} checked={config.segments.includes(s)} onChange={() => {
                      const segments = toggle(config.segments, s);
                      onChange({ segments, skuIds: selectAllMatching(config.brands, segments) });
                    }} />
                  )) : <p className="text-xs text-muted-foreground">No segments.</p>}
                </div>
              </Field>
              <Field label={`SKUs (${filteredSkus.length} match the filter)`}>
                <div className="max-h-40 space-y-1.5 overflow-auto rounded-md border border-border p-2">
                  {filteredSkus.slice(0, 300).map((s) => (
                    <Check key={s.sku} label={s.sku} checked={config.skuIds.includes(s.sku)} onChange={() => onChange({ skuIds: toggle(config.skuIds, s.sku) })} />
                  ))}
                </div>
              </Field>
            </div>
          ) : config.selectionMode === "sample" ? (
            <Field label="N Per Strategy" className="max-w-xs">
              <NumberInput min={1} max={50} value={config.samplePerStrategy} onChange={(v) => onChange({ samplePerStrategy: v })} ariaLabel="N per strategy" />
            </Field>
          ) : (
            <p className="text-sm text-muted-foreground">
              Forecasts the top {config.limit}+ SKUs by volume (bounded for latency — engine is ~30–60s/SKU).
            </p>
          )}
          </>
          )}
        </section>

        {/* Training options */}
        <section className="space-y-3">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">Training options</p>
          {/* Order + labels mirror Streamlit's render_forecast_tab checkboxes. */}
          <div className="grid grid-cols-1 gap-2">
            <Check label="Train global LightGBM (recommended — needed for ~80% of SKUs)" checked={config.useGlobal} onChange={(v) => onChange({ useGlobal: v })} />
            <Check label="Reconcile to brand totals" checked={config.reconcile} onChange={(v) => onChange({ reconcile: v })} />
            <Check label="Evaluate out-of-sample accuracy over the forecast horizon (drives model selection)" checked={config.evaluateOos} onChange={(v) => onChange({ evaluateOos: v })} />
            <Check label={`🏆 Auto-select best algorithm via K=3 CV (for SKUs with ≥ ${algorithms?.minHistoryForCv ?? 24} months)`} checked={config.cvMode} onChange={(v) => onChange({ cvMode: v })} />
          </div>
        </section>

        {/* Algorithms */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
              <Sparkles className="size-3.5" /> Algorithms to compare
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => onChange({ compareAlgos: [...visibleAlgos] })}>Select all</Button>
              <Button variant="ghost" size="sm" onClick={() => onChange({ compareAlgos: [...(algorithms?.recommended ?? [])] })}>Reset to recommended</Button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {visibleAlgos.map((k) => (
              <Check key={k} label={algoLabel.get(k) ?? k} checked={config.compareAlgos.includes(k)} onChange={() => onChange({ compareAlgos: toggle(config.compareAlgos, k) })} />
            ))}
          </div>
          {config.compareAlgos.length === 0 ? (
            <p className="text-xs text-warning">No algorithms selected — the engine falls back to each SKU’s auto-routed default.</p>
          ) : null}
        </section>

        {/* Horizon (read-only — owned by Configuration & Preparation) + run */}
        <section className="flex flex-col gap-4 border-t border-border/60 pt-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
              Forecast horizon
            </p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
              {savedHorizon ?? config.periods} periods
            </p>
            <p className="text-xs text-muted-foreground">
              Set in Configuration &amp; Preparation
            </p>
          </div>
          <Button onClick={onRun} disabled={running} className="sm:w-48">
            {running ? (
              <><Loader2 className="size-4 animate-spin" /> {jobStatus === "queued" ? "Queued…" : `Running… ${progress}%`}</>
            ) : (
              <><Play className="size-4" /> Run forecasts</>
            )}
          </Button>
        </section>

        {running ? (
          <div className="space-y-1.5">
            {/* Filled bar tracks real progress; a moving shimmer keeps it visibly
                active even while a single SKU's long competition holds the % steady
                (F.12 #12 — never appears frozen). */}
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500"
                style={{ width: `${Math.max(progress, 4)}%` }}
              />
              <div
                className="pointer-events-none absolute inset-y-0 left-0 w-1/4 bg-gradient-to-r from-transparent via-white/40 to-transparent"
                style={{ animation: "tl-shimmer 1.4s ease-in-out infinite" }}
                aria-hidden
              />
            </div>
            {jobMessage ? (
              <p className="text-xs text-muted-foreground">{jobMessage}</p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
