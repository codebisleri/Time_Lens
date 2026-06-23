/**
 * Pure, echarts-free helpers for the Explainability view (Phase X.W). Kept in a
 * separate module so the view can import driver math, model-family mapping and
 * CSV builders WITHOUT eagerly pulling the lazy-loaded chart/echarts bundle.
 * Everything here is a read-only interpretation of already-computed forecast
 * data — no forecast is rerun, retrained, or changed.
 */
import type {
  DriverContributions,
  HorizonPeriod,
  WaterfallStep,
} from "@/types/explainability";

export interface FlatDriver {
  label: string;
  /** Magnitude (always ≥ 0) — used for donut/bar sizing. */
  pct: number;
  /** Signed value — keeps direction (down-trend / inverse exogenous). */
  signed: number;
}

/** Flatten a contribution object into a sorted driver list (Trend / Seasonality /
 *  Holiday / exogenous / Residual). `pct` is the magnitude; `signed` keeps sign. */
export function flatDrivers(c: DriverContributions): FlatDriver[] {
  const out: FlatDriver[] = [
    { label: "Trend", pct: c.trend, signed: c.slopeDirection === "down" ? -c.trend : c.trend },
    { label: "Seasonality", pct: c.seasonality, signed: c.seasonality },
    { label: "Holiday", pct: c.holiday, signed: c.holiday },
  ];
  for (const [label, e] of Object.entries(c.exogenous ?? {})) {
    out.push({ label, pct: Math.abs(e.pct), signed: e.pct });
  }
  out.push({ label: "Residual", pct: c.residual, signed: c.residual });
  return out.filter((d) => d.pct > 0).sort((a, b) => b.pct - a.pct);
}

export type DriverDirection = "up" | "down" | "neutral";

export interface DriverTableRow {
  driver: string;
  pct: number;
  direction: DriverDirection;
  /** Qualitative impact bucket derived from the contribution magnitude. */
  impact: "High" | "Medium" | "Low";
}

/** Build the Driver Contribution table (Task 2). Residual is always neutral
 *  (unexplained variance carries no direction). */
export function driverTableRows(c: DriverContributions): DriverTableRow[] {
  return flatDrivers(c).map((d) => ({
    driver: d.label,
    pct: d.pct,
    direction:
      d.label === "Residual" ? "neutral" : d.signed > 0 ? "up" : d.signed < 0 ? "down" : "neutral",
    impact: d.pct >= 25 ? "High" : d.pct >= 10 ? "Medium" : "Low",
  }));
}

// ── Monthly Forecast Bridge / actual-value contributions (Phase X.X 6,7,8) ───
/** Driver order for the monthly bridge — Base first, Residual last, the rest
 *  in a stable business order; any other exog labels keep their natural order. */
const MONTHLY_ORDER = ["Trend", "Seasonality", "Promotion", "Price", "Holiday", "Weather"];

/** Ordered [label, value] driver list for a month, in actual demand units
 *  (signed). Residual is forced last. */
export function monthlyDrivers(drivers: Record<string, number>): { label: string; value: number }[] {
  const entries = Object.entries(drivers).filter(([k]) => k !== "Residual");
  entries.sort((a, b) => {
    const ia = MONTHLY_ORDER.indexOf(a[0]);
    const ib = MONTHLY_ORDER.indexOf(b[0]);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  if ("Residual" in drivers) entries.push(["Residual", drivers.Residual!]);
  return entries.map(([label, value]) => ({ label, value }));
}

/** Build a month-wise Forecast Bridge (Base demand → drivers → Final forecast)
 *  in actual demand units from a horizon period's driver map (Task 6). */
export function monthlyWaterfall(base: number, drivers: Record<string, number>): WaterfallStep[] {
  const steps: WaterfallStep[] = [{ label: "Base demand", value: round1(base), type: "base" }];
  let total = base;
  for (const { label, value } of monthlyDrivers(drivers)) {
    if (value === 0) continue;
    steps.push({ label, value: round1(value), type: "delta" });
    total += value;
  }
  steps.push({ label: "Final forecast", value: round1(total), type: "total" });
  return steps;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export const DIRECTION_GLYPH: Record<DriverDirection, string> = {
  up: "↑",
  down: "↓",
  neutral: "→",
};

// ── Model family / model-specific panel (Phase X.X — universal coverage) ──────
// EVERY champion model maps to a family that produces an explanation. The
// catch-all is "universal" (historical decomposition), never an "unavailable"
// state. Keyword matching is case-insensitive and substring-based so engine
// labels like "Global LightGBM (Full Pool)", "Local SARIMAX + Exog",
// "Mixture of Experts", "Croston / SBA" all resolve.
export type ModelFamily =
  | "prophet"
  | "lightgbm"
  | "catboost"
  | "sarimax"
  | "chronos"
  | "moe"
  | "tsb"
  | "croston"
  | "ensemble"
  | "statistical"
  | "universal";

/** Map a champion-model label (free text from the engine) onto an explainability
 *  family. Order matters — most specific keywords are checked first. Always
 *  returns a usable family; "universal" is the decomposition fallback. */
export function modelFamily(label?: string | null): ModelFamily {
  const s = (label ?? "").toLowerCase();
  if (!s) return "universal";
  if (s.includes("prophet")) return "prophet";
  if (s.includes("catboost")) return "catboost";
  if (s.includes("lightgbm") || s.includes("lgbm") || s.includes("xgb") || s.includes("gbm") || s.includes("gradient"))
    return "lightgbm";
  if (s.includes("sarimax") || s.includes("sarima") || s.includes("arimax") || s.includes("arima"))
    return "sarimax";
  if (s.includes("chronos")) return "chronos";
  if (s.includes("mixture of expert") || s.includes("moe") || s.includes("expert")) return "moe";
  if (s.includes("tsb")) return "tsb";
  if (s.includes("croston") || s.includes("sba")) return "croston";
  if (s.includes("ensemble") || s.includes("blend") || s.includes("stack") || s.includes("weighted"))
    return "ensemble";
  if (["ets", "holt", "winters", "theta", "expon", "ses", "naive", "moving", "seasonal", "drift"].some((k) => s.includes(k)))
    return "statistical";
  return "universal";
}

// ── Qualitative labels for the summary card (Task 1) ─────────────────────────
export function trendDirectionLabel(c: DriverContributions): "Increasing" | "Decreasing" | "Flat" {
  if (c.slopeDirection === "up") return "Increasing";
  if (c.slopeDirection === "down") return "Decreasing";
  return "Flat";
}

export function seasonalityStrengthLabel(c: DriverContributions): "Strong" | "Moderate" | "Weak" | "None" {
  const p = c.seasonality;
  if (p >= 25) return "Strong";
  if (p >= 12) return "Moderate";
  if (p > 0) return "Weak";
  return "None";
}

// ── CSV builders (Task 7) ────────────────────────────────────────────────────
/** RFC-4180-ish escaping for a single CSV cell. */
function csvCell(v: string | number): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

export function driversToCsv(c: DriverContributions, title: string): string {
  const rows: (string | number)[][] = [["# " + title], ["Driver", "Contribution %", "Direction", "Impact"]];
  for (const r of driverTableRows(c)) {
    rows.push([r.driver, r.pct, r.direction, r.impact]);
  }
  return rowsToCsv(rows);
}

export function waterfallToCsv(steps: WaterfallStep[], entity: string): string {
  const rows: (string | number)[][] = [["# Forecast bridge — " + entity], ["Step", "Value", "Type"]];
  for (const s of steps) rows.push([s.label, s.value, s.type]);
  return rowsToCsv(rows);
}

export function horizonToCsv(periods: HorizonPeriod[], entity: string): string {
  const rows: (string | number)[][] = [
    ["# Horizon explanation — " + entity],
    ["Horizon", "Period", "Base", "Trend", "Seasonality", "Exogenous", "Residual", "Trend %", "Seasonality %", "Exogenous %", "Residual %"],
  ];
  for (const p of periods) {
    rows.push([
      p.index ?? "",
      p.label,
      p.base,
      p.trend,
      p.seasonality,
      p.exogenous ?? 0,
      p.residual ?? 0,
      p.trendPct ?? 0,
      p.seasonalityPct ?? 0,
      p.exogenousPct ?? 0,
      p.residualPct ?? 0,
    ]);
  }
  return rowsToCsv(rows);
}
