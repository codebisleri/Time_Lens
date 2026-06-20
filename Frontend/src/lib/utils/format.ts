/** Display formatters shared across tables, charts, and cards. Locale-aware,
 *  side-effect free. Keep all number/date presentation logic here. */

const DEFAULT_LOCALE = "en-US";

export function formatNumber(value: number, opts?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat(DEFAULT_LOCALE, opts).format(value);
}

/** Compact notation: 1.2K, 3.4M — used heavily in KPI tiles and axes. */
export function formatCompact(value: number) {
  return new Intl.NumberFormat(DEFAULT_LOCALE, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatCurrency(value: number, currency = "USD") {
  return new Intl.NumberFormat(DEFAULT_LOCALE, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

/** Indian currency in Crores / Lakhs — exact parity with the Streamlit Data-tab
 *  KPI: `₹{v/1e7:.1f} Cr` when ≥ ₹1 crore, else `₹{v/1e5:.1f} L`. */
export function formatIndianCurrency(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1e7) return `₹${(value / 1e7).toFixed(1)} Cr`;
  if (value >= 1e5) return `₹${(value / 1e5).toFixed(1)} L`;
  return `₹${formatNumber(Math.round(value))}`;
}

/** Fraction (0.123) -> "12.3%". */
export function formatPercent(value: number, fractionDigits = 1) {
  return new Intl.NumberFormat(DEFAULT_LOCALE, {
    style: "percent",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

/** Signed delta for comparison views: +4.2% / -1.0%. */
export function formatDelta(value: number, fractionDigits = 1) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatPercent(value, fractionDigits)}`;
}

/** Configured forecast-frequency code → human label. Mirrors the Streamlit
 *  engine's resample codes; used for display so the UI reflects the *chosen*
 *  frequency rather than the auto-detected raw granularity. */
const FREQUENCY_LABELS: Record<string, string> = {
  D: "Daily",
  W: "Weekly",
  MS: "Monthly",
  QS: "Quarterly",
  YS: "Yearly",
};

export function formatFrequency(code?: string | null): string {
  if (!code) return "—";
  return FREQUENCY_LABELS[code] ?? code;
}

export function formatDate(iso: string, opts?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...opts,
  }).format(new Date(iso));
}

export function formatDateTime(iso: string) {
  return formatDate(iso, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * F.17 §3/§13 — humanize a raw column / forecast-level key for display.
 *   sku          → SKU      (the standalone level keeps its acronym)
 *   sku_unit     → Sku Unit
 *   item_no      → Item No
 *   customer_code→ Customer Code
 *   product_id   → Product Id
 * Rule: replace "_"/whitespace, Title-Case each word; the exact key "sku" is the
 * only one rendered fully upper-case. The SINGLE shared helper — never hardcode
 * "SKU"/"SKUs"/"Inspect SKU" in components.
 */
const LEVEL_ACRONYMS = new Set(["sku", "id"]);

export function formatForecastLevel(raw?: string | null): string {
  const key = (raw ?? "").trim();
  if (!key) return "SKU";
  return key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => {
      const lw = w.toLowerCase();
      // Acronyms stay upper-case: sku→SKU, id→ID (sku_id→"SKU ID").
      return LEVEL_ACRONYMS.has(lw) ? lw.toUpperCase() : lw.charAt(0).toUpperCase() + lw.slice(1);
    })
    .join(" ");
}

/** Reusable column-name humanizer (alias of formatForecastLevel rules). */
export const formatColumnName = formatForecastLevel;

/** Naive pluralizer for the forecast-level label ("SKU" → "SKUs", "Item No" →
 *  "Item Nos"). Used for "Items Forecasted", "Item Count", etc. */
export function pluralizeLevel(label: string): string {
  if (!label) return label;
  return /s$/i.test(label) ? `${label}es` : `${label}s`;
}

/** Singular + plural display terms derived from the forecast-level key. */
export function forecastLevelTerms(raw?: string | null): {
  singular: string;
  plural: string;
} {
  const singular = formatForecastLevel(raw);
  return { singular, plural: pluralizeLevel(singular) };
}
