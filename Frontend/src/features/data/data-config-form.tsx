"use client";

import { useEffect, useMemo, useState } from "react";
import { Save, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { DataConfig, Dataset } from "@/types/dataset";
import { formatForecastLevel } from "@/lib/utils/format";
import { Check, Field, NONE, Select, columnOptions, type Opt } from "./controls";
import { NumericInput } from "@/components/ui/numeric-input";

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

// Phase X.Q · Task 6 — granularity rank (finer → coarser). A forecast can never
// be FINER than the detected history cadence, so any option ranked below the
// history's rank is disabled (Weekly history ⇒ no Daily; Yearly ⇒ Yearly only).
function freqRank(f: string | null | undefined): number {
  const s = String(f ?? "").trim().toUpperCase();
  if (s.startsWith("D")) return 0;
  if (s.startsWith("W")) return 1;
  if (s.startsWith("Q")) return 3;
  if (s.startsWith("Y") || s.startsWith("A")) return 4;
  if (s.startsWith("M")) return 2;
  return 2; // default: monthly
}
const FREQ_LABEL: Record<number, string> = {
  0: "daily", 1: "weekly", 2: "monthly", 3: "quarterly", 4: "yearly",
};

const HOLIDAY: Opt[] = ["IN", "US", "GB", "AU", "CA", "DE", "FR", "JP", "SG", "AE"].map(
  (v) => ({ value: v, label: v }),
);

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
      useGeneratedSegmentation: false,
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
  // Task 2 — Forecast Horizon must be valid (1–36) before the config can be saved.
  const [horizonValid, setHorizonValid] = useState(true);
  // Phase X.T · Task 1 — routing thresholds must be valid before saving.
  const [coldValid, setColdValid] = useState(true);
  const [shortValid, setShortValid] = useState(true);
  const columns = useMemo(() => dataset.columns ?? [], [dataset.columns]);

  // Phase X.Q · Task 6 — forecast frequencies finer than the detected history
  // cadence are greyed out (with a tooltip) and cannot be chosen.
  const historyRank = freqRank(dataset.frequency);
  const freqOptions = useMemo<Opt[]>(
    () =>
      FREQS.map((o) => {
        const disabled = freqRank(o.value) < historyRank;
        return disabled
          ? {
              ...o,
              disabled: true,
              title: `${o.label} unavailable for ${FREQ_LABEL[historyRank]} historical data.`,
            }
          : o;
      }),
    [historyRank],
  );
  // Never leave an invalid (too-fine) frequency selected — snap up to the
  // coarsest-but-still-valid (= the history cadence) option.
  useEffect(() => {
    if (freqRank(cfg.freq) < historyRank) {
      const fallback = FREQS.find((o) => freqRank(o.value) === historyRank) ?? FREQS[0]!;
      set("freq", fallback.value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyRank]);

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
              <Select ariaLabel="Forecast Frequency" value={cfg.freq} onChange={(v) => set("freq", v)} options={freqOptions} />
            </Field>
            <Field label="Forecast Horizon">
              {/* Task 2 — 1–36 months, validated (red border + message), gates Save. */}
              <NumericInput
                min={1} max={36} value={cfg.horizon}
                onChange={(v) => set("horizon", v)}
                onValidityChange={setHorizonValid}
                hardLimit
                ariaLabel="Forecast Horizon"
                label="Forecast horizon"
                unit="months"
                helperText="Number of future periods to project (1–36)."
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
              {/* Phase X.T · Task 1 — same validated NumericInput as Forecast
                  Horizon (1–24, red border + message, gates Save). */}
              <NumericInput
                min={1} max={24} value={cfg.coldStartMonths}
                onChange={(v) => set("coldStartMonths", v)}
                onValidityChange={setColdValid}
                hardLimit
                ariaLabel="Cold-Start months"
                label="Cold-Start"
                unit="months"
              />
            </Field>
            <Field label="Short-History">
              <NumericInput
                min={1} max={36} value={cfg.shortHistoryMonths}
                onChange={(v) => set("shortHistoryMonths", v)}
                onValidityChange={setShortValid}
                hardLimit
                ariaLabel="Short-History months"
                label="Short-History"
                unit="months"
              />
            </Field>
          </div>
        </section>

        {/* Top-Down Forecasting moved to the Run Forecast dialog (Phase Y.3 ·
            Task 1) — configured at run time, not on the Configuration page. */}

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
          <Button onClick={() => onSave(cfg)} disabled={saving || !horizonValid || !coldValid || !shortValid}>
            <Save className="size-4" /> Save configuration
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
