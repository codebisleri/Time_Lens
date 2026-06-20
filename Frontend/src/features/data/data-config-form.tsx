"use client";

import { useMemo, useState } from "react";
import { Save, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { DataConfig, Dataset } from "@/types/dataset";
import { formatForecastLevel } from "@/lib/utils/format";
import { Check, Field, NONE, NumberInput, Select, columnOptions, type Opt } from "./controls";

// Exact Streamlit date_format_options (keys + ordering); labels carry the same
// "(e.g. …)" hints Streamlit shows. Values map to the backend strftime table.
const DATE_FORMATS: Opt[] = [
  { value: "Auto-detect", label: "Auto-detect" },
  { value: "DD-MM-YYYY", label: "DD-MM-YYYY" },
  { value: "MM-DD-YYYY", label: "MM-DD-YYYY" },
  { value: "YYYY-MM-DD", label: "YYYY-MM-DD" },
  { value: "DD/MM/YYYY", label: "DD/MM/YYYY" },
  { value: "MM/DD/YYYY", label: "MM/DD/YYYY" },
  { value: "YYYY/MM/DD", label: "YYYY/MM/DD" },
  { value: "DD-MMM-YY", label: "DD-MMM-YY (e.g. 01-Jan-22)" },
  { value: "MMM-YY", label: "MMM-YY (e.g. Jan-22)" },
  { value: "YYYY-MM", label: "YYYY-MM (e.g. 2022-01)" },
  { value: "Custom...", label: "Custom..." },
];

// Display-only human labels; backend values (MS/W/D/QS/YS) unchanged (Part 3).
const FREQS: Opt[] = [
  { value: "MS", label: "Monthly" },
  { value: "W", label: "Weekly" },
  { value: "D", label: "Daily" },
  { value: "QS", label: "Quarterly" },
  { value: "YS", label: "Yearly" },
];

const HOLIDAY: Opt[] = ["IN", "US", "GB", "AU", "CA", "DE", "FR", "JP", "SG", "AE"].map(
  (v) => ({ value: v, label: v }),
);

// Streamlit "How to split the aggregate back to each SKU" (3b).
const DISAGG: Opt[] = [
  { value: "Historical average share", label: "Historical average share" },
  { value: "Recent share (last 6 periods)", label: "Recent share (last 6 periods)" },
  { value: "Equal share within group", label: "Equal share within group" },
];

export const EXOG_STRATEGIES: Opt[] = [
  { value: "auto", label: "Auto (recommended)" },
  { value: "repeat_seasonal", label: "Repeat seasonal" },
  { value: "hold_flat", label: "Hold flat" },
  { value: "assume_zero", label: "Assume zero" },
  { value: "calendar", label: "Calendar" },
  { value: "explicit", label: "Enter explicit" },
];

function defaultConfig(dataset: Dataset): DataConfig {
  const m = dataset.detectedMapping ?? {};
  return (
    dataset.config ?? {
      dateCol: m.date ?? null,
      dateFormat: "Auto-detect",
      dateFormatCustom: null,
      skuCol: m.sku ?? null,
      salesCol: m.sales ?? null,
      categoryCol: m.category ?? null,
      priceCol: m.price ?? null,
      segmentCol: null,
      brandCol: null,
      freq: dataset.frequency ?? "MS",
      horizon: 12,
      useFullHistory: true,
      historyStart: null,
      coldStartMonths: 6,
      shortHistoryMonths: 12,
      exogNumeric: [],
      exogCategorical: [],
      exogStrategy: {},
      missingHandling: "none",
      outlierHandling: "none",
      holidayCountry: "IN",
      futureEvents: [],
      forecastLevelMode: "sku",
      forecastLevelCols: [],
      topDownEnabled: false,
      topDownLevels: [],
      topDownApply: { cold: true, short: false, lumpy: true, noisy: false },
      topDownDisagg: "Historical average share",
    }
  );
}

/**
 * Configuration & Preparation — replicates the Streamlit sidebar `cfg`: column
 * mapping, date format, frequency, horizon, history window, routing thresholds,
 * missing/outlier handling, exogenous variables, and holiday country. Persists
 * via PATCH /datasets/{id}/config (the bridge re-derives schema metadata).
 */
export function DataConfigForm({
  dataset,
  numericColumns,
  categoricalColumns,
  onSave,
  saving,
}: {
  dataset: Dataset;
  numericColumns: string[];
  categoricalColumns: string[];
  onSave: (cfg: DataConfig) => void;
  saving: boolean;
}) {
  const [cfg, setCfg] = useState<DataConfig>(() => defaultConfig(dataset));
  const columns = useMemo(() => dataset.columns ?? [], [dataset.columns]);

  const set = <K extends keyof DataConfig>(key: K, value: DataConfig[K]) =>
    setCfg((c) => ({ ...c, [key]: value }));

  const colSel = (
    label: string,
    key: "dateCol" | "skuCol" | "salesCol" | "categoryCol" | "priceCol" | "segmentCol" | "brandCol",
    withNone: boolean,
    hint?: string,
  ) => (
    <Field label={label} hint={hint}>
      <Select
        ariaLabel={label}
        value={cfg[key] ?? (withNone ? NONE : "")}
        onChange={(v) => set(key, v === NONE ? null : v)}
        options={columnOptions(columns, withNone)}
      />
    </Field>
  );

  const numOffer = useMemo(() => {
    const reserved = new Set([cfg.dateCol, cfg.skuCol, cfg.salesCol].filter(Boolean) as string[]);
    return numericColumns.filter((c) => !reserved.has(c));
  }, [numericColumns, cfg.dateCol, cfg.skuCol, cfg.salesCol]);
  const catOffer = useMemo(() => {
    const reserved = new Set([cfg.dateCol, cfg.skuCol, cfg.salesCol].filter(Boolean) as string[]);
    return categoricalColumns.filter((c) => !reserved.has(c));
  }, [categoricalColumns, cfg.dateCol, cfg.skuCol, cfg.salesCol]);

  const toggleExog = (kind: "exogNumeric" | "exogCategorical", col: string) =>
    setCfg((c) => {
      const has = c[kind].includes(col);
      return { ...c, [kind]: has ? c[kind].filter((x) => x !== col) : [...c[kind], col] };
    });

  const selectedExog = [...cfg.exogNumeric, ...cfg.exogCategorical];

  // Live readiness — forecasting needs date + forecasting-level + demand columns.
  const ready = !!(cfg.dateCol && cfg.skuCol && cfg.salesCol);
  // The forecasting-level option mirrors the chosen level column name dynamically
  // (e.g. "Product_ID") rather than generic "Per-SKU" (Part 5).
  // F.17B §1/§4 — raw column names must NEVER surface; always humanize via the
  // shared formatter (sku→SKU, product_name→Product Name, sales→Sales, …). Used
  // by BOTH the Forecast Level summary card AND the level-mode selector button.
  const levelName = cfg.skuCol ? formatForecastLevel(cfg.skuCol) : "Forecasting Level";
  const levelLabel =
    cfg.forecastLevelMode === "overall"
      ? "Enterprise Level"
      : cfg.forecastLevelMode === "custom"
        ? cfg.forecastLevelCols.length
          ? cfg.forecastLevelCols.map(formatForecastLevel).join(" × ")
          : "Custom Group"
        : levelName;
  const freqLabel = FREQS.find((f) => f.value === cfg.freq)?.label ?? cfg.freq;
  const summary: { label: string; value: string }[] = [
    { label: "Date Column", value: cfg.dateCol ? formatForecastLevel(cfg.dateCol) : "—" },
    { label: "Demand Column", value: cfg.salesCol ? formatForecastLevel(cfg.salesCol) : "—" },
    { label: "Frequency", value: freqLabel },
    { label: "Horizon", value: `${cfg.horizon} periods` },
    { label: "Forecast Level", value: levelLabel },
    { label: "Top-Down", value: cfg.topDownEnabled ? "On" : "Off" },
  ];

  // Group/level candidates = all columns except date/sales/sku (Streamlit parity).
  const levelCandidates = useMemo(() => {
    const reserved = new Set(
      [cfg.dateCol, cfg.skuCol, cfg.salesCol].filter(Boolean) as string[],
    );
    return columns.filter((c) => !reserved.has(c));
  }, [columns, cfg.dateCol, cfg.skuCol, cfg.salesCol]);

  const toggleArr = (key: "forecastLevelCols" | "topDownLevels", col: string) =>
    setCfg((c) => {
      const arr = c[key];
      const has = arr.includes(col);
      return { ...c, [key]: has ? arr.filter((x) => x !== col) : [...arr, col] };
    });

  const setTopDownApply = (k: keyof DataConfig["topDownApply"], v: boolean) =>
    setCfg((c) => ({ ...c, topDownApply: { ...c.topDownApply, [k]: v } }));

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <SlidersHorizontal className="size-4 text-primary" /> Input Configuration
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Live configuration summary — updates as settings change. */}
        <div className="rounded-lg border border-border bg-secondary/40 p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
              Live configuration summary
            </p>
            <span
              className={
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium " +
                (ready
                  ? "border-success/25 bg-success/15 text-success"
                  : "border-warning/30 bg-warning/15 text-warning")
              }
            >
              <span className={"size-1.5 rounded-full " + (ready ? "bg-success" : "bg-warning")} aria-hidden />
              {ready ? "Forecast-ready" : "Mapping incomplete"}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
            {summary.map((s) => (
              <div key={s.label}>
                <dt className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {s.label}
                </dt>
                <dd className="mt-0.5 truncate text-sm font-semibold text-foreground" title={s.value}>
                  {s.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Column Configuration */}
        <section className="space-y-3">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
            Column Configuration
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {colSel("Date Column", "dateCol", false)}
            <Field label="Date Format">
              <div className="space-y-2">
                <Select
                  ariaLabel="Date Format"
                  value={cfg.dateFormat}
                  onChange={(v) => set("dateFormat", v)}
                  options={DATE_FORMATS}
                />
                {cfg.dateFormat === "Custom..." ? (
                  <Input
                    type="text"
                    placeholder="%Y-%m-%d"
                    value={cfg.dateFormatCustom ?? ""}
                    onChange={(e) => set("dateFormatCustom", e.target.value)}
                    aria-label="Custom date format string"
                  />
                ) : null}
              </div>
            </Field>
            {colSel("Forecasting Level", "skuCol", false)}
            {colSel("Demand Column", "salesCol", false)}
            {colSel("Segment Column (optional)", "segmentCol", true)}
          </div>
        </section>

        {/* Forecast Level */}
        <section className="space-y-3">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
            Forecast Level
          </p>
          <div className="space-y-3">
            <div className="inline-flex flex-wrap gap-1 rounded-md border border-border p-0.5">
              {(
                [
                  ["sku", levelName],
                  ["custom", "Custom Group"],
                  ["overall", "Enterprise Level"],
                ] as const
              ).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => set("forecastLevelMode", val)}
                  className={
                    "rounded px-3 py-1.5 text-sm font-medium transition-colors " +
                    (cfg.forecastLevelMode === val
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground")
                  }
                  aria-pressed={cfg.forecastLevelMode === val}
                >
                  {label}
                </button>
              ))}
            </div>
            {cfg.forecastLevelMode === "custom" ? (
              <Field label="Group By Column(s)">
                <div className="max-h-40 space-y-1.5 overflow-auto rounded-md border border-border p-2">
                  {levelCandidates.length ? (
                    levelCandidates.map((c) => (
                      <Check
                        key={c}
                        label={formatForecastLevel(c)}
                        checked={cfg.forecastLevelCols.includes(c)}
                        onChange={() => toggleArr("forecastLevelCols", c)}
                      />
                    ))
                  ) : (
                    <p className="text-xs text-muted-foreground">No groupable columns.</p>
                  )}
                </div>
              </Field>
            ) : null}
          </div>
        </section>

        {/* Frequency & Horizon */}
        <section className="space-y-3">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
            Frequency &amp; Horizon
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Forecast Frequency">
              <Select ariaLabel="Forecast Frequency" value={cfg.freq} onChange={(v) => set("freq", v)} options={FREQS} />
            </Field>
            <Field label="Forecast Horizon">
              <NumberInput
                min={1} max={36} value={cfg.horizon}
                onChange={(v) => set("horizon", v)}
                ariaLabel="Forecast Horizon"
              />
            </Field>
            {/* Start Date — empty = full dataset history; a date narrows it (Part 7). */}
            <Field label="Start Date">
              <Input
                type="date"
                value={cfg.historyStart ?? ""}
                onChange={(e) => {
                  const v = e.target.value || null;
                  // Keep the engine flag in lockstep: a date present → not-full.
                  setCfg((c) => ({ ...c, historyStart: v, useFullHistory: !v }));
                }}
                aria-label="Start Date"
              />
            </Field>
          </div>
        </section>

        {/* Routing Thresholds */}
        <section className="space-y-3">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
            Routing Thresholds
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Cold-Start">
              <NumberInput
                min={1} max={24} value={cfg.coldStartMonths}
                onChange={(v) => set("coldStartMonths", v)}
                ariaLabel="Cold-Start"
              />
            </Field>
            <Field label="Short-History">
              <NumberInput
                min={1} max={36} value={cfg.shortHistoryMonths}
                onChange={(v) => set("shortHistoryMonths", v)}
                ariaLabel="Short-History"
              />
            </Field>
          </div>
        </section>

        {/* Top-Down Forecasting (3b) — F.7 parity */}
        <section className="space-y-3">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
            Top-Down Forecasting
          </p>
          <Check
            checked={cfg.topDownEnabled}
            onChange={(v) => set("topDownEnabled", v)}
            label="Enable Top-Down for New / Sparse / Noisy Items"
          />
          <p className="text-xs text-muted-foreground">
            Forecast a stable aggregate, then split it back to hard-to-forecast
            items by their share.
          </p>
          {cfg.topDownEnabled ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Field label="Aggregate to level(s)">
                <div className="max-h-40 space-y-1.5 overflow-auto rounded-md border border-border p-2">
                  {levelCandidates.length ? (
                    levelCandidates.map((c) => (
                      <Check
                        key={c}
                        label={formatForecastLevel(c)}
                        checked={cfg.topDownLevels.includes(c)}
                        onChange={() => toggleArr("topDownLevels", c)}
                      />
                    ))
                  ) : (
                    <p className="text-xs text-muted-foreground">No aggregate columns.</p>
                  )}
                </div>
              </Field>
              <div className="space-y-3">
                <Field label="Apply top-down to which SKUs?">
                  <div className="space-y-1.5 rounded-md border border-border p-2">
                    <Check label="New / cold-start SKUs" checked={cfg.topDownApply.cold} onChange={(v) => setTopDownApply("cold", v)} />
                    <Check label="Short-history SKUs" checked={cfg.topDownApply.short} onChange={(v) => setTopDownApply("short", v)} />
                    <Check label="Lumpy / intermittent SKUs" checked={cfg.topDownApply.lumpy} onChange={(v) => setTopDownApply("lumpy", v)} />
                    <Check label="Noisy (high variability) SKUs" checked={cfg.topDownApply.noisy} onChange={(v) => setTopDownApply("noisy", v)} />
                  </div>
                </Field>
                <Field label="How to split the aggregate back to each SKU">
                  <Select
                    ariaLabel="Disaggregation method"
                    value={cfg.topDownDisagg}
                    onChange={(v) => set("topDownDisagg", v)}
                    options={DISAGG}
                  />
                </Field>
              </div>
            </div>
          ) : null}
        </section>

        {/* Holiday Calendar (Missing & Outlier handling removed — Part 8) */}
        <section className="space-y-3">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
            Holiday Calendar
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Holiday Country">
              <Select ariaLabel="Holiday Country" value={cfg.holidayCountry} onChange={(v) => set("holidayCountry", v)} options={HOLIDAY} />
            </Field>
          </div>
        </section>

        {/* Exogenous Variables */}
        <section className="space-y-3">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
            Exogenous Variables
          </p>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Field label={`Numeric exogenous (${numOffer.length} available)`}>
              <div className="max-h-40 space-y-1.5 overflow-auto rounded-md border border-border p-2">
                {numOffer.length ? (
                  numOffer.map((c) => (
                    <Check key={c} label={formatForecastLevel(c)} checked={cfg.exogNumeric.includes(c)} onChange={() => toggleExog("exogNumeric", c)} />
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">None available.</p>
                )}
              </div>
            </Field>
            <Field label={`Categorical exogenous (${catOffer.length} available)`}>
              <div className="max-h-40 space-y-1.5 overflow-auto rounded-md border border-border p-2">
                {catOffer.length ? (
                  catOffer.map((c) => (
                    <Check key={c} label={formatForecastLevel(c)} checked={cfg.exogCategorical.includes(c)} onChange={() => toggleExog("exogCategorical", c)} />
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">None available.</p>
                )}
              </div>
            </Field>
          </div>
          {selectedExog.length ? (
            <div className="space-y-2 rounded-md border border-border p-3">
              <p className="text-xs font-medium text-foreground">Per-exogenous projection strategy</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {selectedExog.map((c) => (
                  <Field key={c} label={formatForecastLevel(c)}>
                    <Select
                      ariaLabel={`Projection for ${c}`}
                      value={cfg.exogStrategy[c] ?? "auto"}
                      onChange={(v) => set("exogStrategy", { ...cfg.exogStrategy, [c]: v })}
                      options={EXOG_STRATEGIES}
                    />
                  </Field>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        <div className="flex justify-end">
          <Button onClick={() => onSave(cfg)} disabled={saving}>
            <Save className="size-4" /> Save configuration
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
