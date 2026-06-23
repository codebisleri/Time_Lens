"use client";

import { useEffect, useMemo } from "react";
import { Loader2, Play, Sparkles, Target, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Check, Field, NumberInput, Select } from "@/features/data/controls";
import { useForecastStore } from "@/lib/stores";
import { useForecastFiltersStore } from "@/lib/stores/forecast-filters-store";
import { useForecastLevel } from "@/lib/stores/forecast-level-store";
import { DynamicFilters } from "./dynamic-filters";
import { formatNumber } from "@/lib/utils/format";
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

// Phase X.J — labels use the dataset's Forecast Level term (Items / Product IDs…).
const MODES: { value: RunConfig["selectionMode"]; label: (plural: string) => string }[] = [
  { value: "pick", label: (p) => `Pick Specific ${p}` },
  { value: "sample", label: (p) => `Sample N ${p} per strategy` },
  { value: "all", label: (p) => `All ${p} (slow)` },
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
  onCancel,
  running,
  progress,
  jobStatus,
  jobMessage,
  savedHorizon,
  levelPlural = "SKUs",
  attrColumns = [],
}: {
  config: RunConfig;
  onChange: (patch: Partial<RunConfig>) => void;
  algorithms: ForecastAlgorithms | null;
  brandOptions: string[];
  segmentOptions: string[];
  skuOptions: { sku: string; brand: string | null; segment: string; attrs: Record<string, string> }[];
  /** Dynamic, dataset-derived filter columns (Phase X.Q · Task 2). */
  attrColumns?: { key: string; label: string }[];
  onRun: () => void;
  /** Phase Y.3 · Task 6 — cancel an in-flight run (frontend-side). */
  onCancel?: () => void;
  running: boolean;
  progress: number;
  jobStatus: string;
  jobMessage?: string;
  /** Forecast horizon from Configuration & Preparation — the single source of
   *  truth (Issue 6). Displayed read-only here; no duplicate control. */
  savedHorizon?: number;
  /** Forecast-level plural term (Items / Product IDs / SKUs…) for labels. */
  levelPlural?: string;
}) {
  const { label: levelLabel } = useForecastLevel();
  // Phase Y.2 — reflect the stored Top-Down choice in the live run status.
  const topDownEnabled = useForecastStore((s) => s.topDownEnabled);
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

  // Streamlit's "Algorithms to compare" multiselect exposes the 10-algorithm
  // option set (`_all_algos`) and defaults to the 6 `recommended`. Mirror that:
  // show the 10 (filtered to keys the backend actually knows), default-select 6.
  const known = new Set(algoLabel.keys());
  const visibleAlgos = STREAMLIT_ALGOS.filter((k) => known.has(k));

  // ── Phase X.P · Task 2 — dynamic, dataset-derived filters (Pick mode) ──────
  // Filter columns are derived from the data (presence-driven, labelled with the
  // real dataset column name), never hardcoded. Selections persist in Zustand.
  const filterColumns = useForecastFiltersStore((s) => s.filterColumns);
  const filterValues = useForecastFiltersStore((s) => s.filterValues);

  // Distinct values per filter column, derived from the per-entity attrs.
  const valuesByColumn = useMemo<Record<string, string[]>>(() => {
    const sets: Record<string, Set<string>> = {};
    for (const col of attrColumns) sets[col.key] = new Set<string>();
    for (const s of skuOptions) {
      for (const col of attrColumns) {
        const v = s.attrs?.[col.key];
        if (v) sets[col.key]!.add(v);
      }
    }
    const out: Record<string, string[]> = {};
    for (const k of Object.keys(sets)) out[k] = Array.from(sets[k]!).sort();
    return out;
  }, [skuOptions, attrColumns]);

  // Only offer columns that actually have values in this dataset.
  const dynamicColumns = useMemo(
    () => attrColumns.filter((c) => (valuesByColumn[c.key]?.length ?? 0) > 0),
    [attrColumns, valuesByColumn],
  );

  const matchesDynamic = useMemo(() => {
    return (s: { attrs: Record<string, string> }) => {
      for (const key of filterColumns) {
        const vals = filterValues[key];
        if (!vals || vals.length === 0) continue;
        const v = s.attrs?.[key];
        if (!(v != null && vals.includes(v))) return false;
      }
      return true;
    };
  }, [filterColumns, filterValues]);

  const pickFilteredSkus = useMemo(
    () => skuOptions.filter(matchesDynamic),
    [skuOptions, matchesDynamic],
  );

  // Keep the explicit selection ⊆ the dynamic filter (Streamlit parity). Pruning
  // only runs when filters change; config.skuIds is read via closure (not a dep)
  // so this can never loop.
  useEffect(() => {
    if (config.selectionMode !== "pick") return;
    const visible = new Set(pickFilteredSkus.map((s) => s.sku));
    const pruned = config.skuIds.filter((id) => visible.has(id));
    if (pruned.length !== config.skuIds.length) onChange({ skuIds: pruned });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickFilteredSkus, config.selectionMode]);

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
              <Field label={`${levelLabel} (${filteredSkus.length} available)`}>
                <Select
                  ariaLabel={`Select a ${levelLabel}`}
                  value={config.skuIds[0] ?? ""}
                  onChange={(sku) => onChange({ skuIds: sku ? [sku] : [] })}
                  options={[{ value: "", label: `Select a ${levelLabel}…` }, ...filteredSkus.map((s) => ({ value: s.sku, label: s.sku }))]}
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
                {m.label(levelPlural)}
              </button>
            ))}
          </div>

          {config.selectionMode === "pick" ? (
            <div className="space-y-3">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {/* Dynamic, dataset-derived filters (Phase X.P · Task 2) — replaces
                  the hardcoded brand/segment filters. */}
              <DynamicFilters
                columns={dynamicColumns}
                valuesByColumn={valuesByColumn}
                levelPlural={levelPlural}
                matchCount={pickFilteredSkus.length}
                totalCount={skuOptions.length}
              />
              <Field label={`${levelPlural} (${config.skuIds.length} selected · ${pickFilteredSkus.length} match the filter)`}>
                <div className="mb-1.5 flex items-center gap-2">
                  <Button type="button" variant="ghost" size="sm"
                    onClick={() => onChange({ skuIds: pickFilteredSkus.map((s) => s.sku) })}>
                    Select all
                  </Button>
                  <Button type="button" variant="ghost" size="sm"
                    onClick={() => onChange({ skuIds: [] })}>
                    Deselect all
                  </Button>
                </div>
                <div className="max-h-40 space-y-1.5 overflow-auto rounded-md border border-border p-2">
                  {pickFilteredSkus.slice(0, 300).map((s) => (
                    <Check key={s.sku} label={s.sku} checked={config.skuIds.includes(s.sku)} onChange={() => onChange({ skuIds: toggle(config.skuIds, s.sku) })} />
                  ))}
                  {pickFilteredSkus.length > 300 ? (
                    <p className="text-[0.7rem] text-muted-foreground">+{pickFilteredSkus.length - 300} more — refine the filter to see them.</p>
                  ) : null}
                </div>
              </Field>
            </div>

            {/* Final selection preview (the EXACT list sent to the backend). */}
            <div className="rounded-md border border-border bg-secondary/20 px-3 py-2.5 text-sm">
              <p className="font-medium text-foreground">Selected {levelPlural}: {config.skuIds.length}</p>
              {config.skuIds.length ? (
                <p className="mt-1 break-words font-mono text-xs text-muted-foreground">
                  Forecasting: {config.skuIds.slice(0, 8).join(", ")}
                  {config.skuIds.length > 8 ? ` +${config.skuIds.length - 8} more` : ""}
                </p>
              ) : (
                <p className="mt-1 text-xs font-medium text-brand-accent">
                  Please select at least one {levelPlural.replace(/s$/, "")}.
                </p>
              )}
            </div>
            </div>
          ) : config.selectionMode === "sample" ? (
            <div className="space-y-3">
              <Field label="N Per Strategy" className="max-w-xs">
                <NumberInput min={1} max={50} value={config.samplePerStrategy} onChange={(v) => onChange({ samplePerStrategy: v })} ariaLabel="N per strategy" />
              </Field>
              {/* Task 1 — per-segment sample preview before execution. */}
              {segmentOptions.length ? (
                <div className="rounded-md border border-border bg-secondary/20 px-3 py-2.5 text-sm">
                  <p className="mb-1 font-medium text-foreground">Will sample up to {config.samplePerStrategy} per segment:</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {segmentOptions.map((s) => (
                      <span key={s}>
                        {s}: <span className="font-semibold text-foreground">{config.samplePerStrategy}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm">
              <p className="font-medium text-foreground">
                Forecasting {formatNumber(skuOptions.length)} {levelPlural.toLowerCase()}.
              </p>
              <p className="mt-1 text-xs text-warning">
                ⚠ All-{levelPlural.toLowerCase()} runs are slow (the engine is ~30–60s per {levelPlural.replace(/s$/i, "").toLowerCase()}); bounded to the top {config.limit} by volume.
              </p>
            </div>
          )}
          </>
          )}
        </section>

        {/* Training options */}
        <section className="space-y-3">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">Training options</p>
          {/* Order + labels mirror Streamlit's render_forecast_tab checkboxes. */}
          <div className="grid grid-cols-1 gap-2">
            <Check label={`Train global LightGBM (recommended — needed for ~80% of ${levelPlural})`} checked={config.useGlobal} onChange={(v) => onChange({ useGlobal: v })} />
            <Check label="Reconcile to brand totals" checked={config.reconcile} onChange={(v) => onChange({ reconcile: v })} />
            <Check label="Evaluate out-of-sample accuracy over the forecast horizon (drives model selection)" checked={config.evaluateOos} onChange={(v) => onChange({ evaluateOos: v })} />
            <Check label={`🏆 Auto-select best algorithm via K=3 CV (for ${levelPlural} with ≥ ${algorithms?.minHistoryForCv ?? 24} months)`} checked={config.cvMode} onChange={(v) => onChange({ cvMode: v })} />
          </div>
        </section>

        {/* Benchmark Algorithms — ONE global set applied to every segment
            (Phase X.Q · Task 3). Drives the backend `compareAlgos` competition
            pool / WMAPE comparison / champion selection (unchanged). Persisted. */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
              <Sparkles className="size-3.5" /> Benchmark Algorithms
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => onChange({ compareAlgos: [...visibleAlgos] })}>Select all</Button>
              <Button variant="ghost" size="sm" onClick={() => onChange({ compareAlgos: [...(algorithms?.recommended ?? [])] })}>Reset to recommended</Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            These models compete for every segment ({levelPlural}). The champion is chosen by hold-out WMAPE.
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {visibleAlgos.map((k) => (
              <Check key={k} label={algoLabel.get(k) ?? k} checked={config.compareAlgos.includes(k)} onChange={() => onChange({ compareAlgos: toggle(config.compareAlgos, k) })} />
            ))}
          </div>
          {config.compareAlgos.length === 0 ? (
            <p className="text-xs text-warning">No benchmark algorithms selected — the engine falls back to each {levelLabel.toLowerCase()}&apos;s auto-routed default.</p>
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
          <div className="flex items-center gap-2">
            <Button onClick={onRun} disabled={running} className="sm:w-48">
              {running ? (
                <><Loader2 className="size-4 animate-spin" /> {jobStatus === "queued" ? "Queued…" : `Running Forecast… ${progress}%`}</>
              ) : (
                <><Play className="size-4" /> Run forecasts</>
              )}
            </Button>
            {running && onCancel ? (
              <Button variant="outline" onClick={onCancel} aria-label="Cancel forecast">
                <X className="size-4" /> Stop Forecast
              </Button>
            ) : null}
          </div>
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
            <p className="text-xs text-muted-foreground">
              Top-Down:{" "}
              <span
                className={cn(
                  "font-semibold",
                  topDownEnabled ? "text-emerald-600 dark:text-emerald-400" : "text-foreground",
                )}
              >
                {topDownEnabled ? "Enabled" : "Disabled"}
              </span>
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
