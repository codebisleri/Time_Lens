import type { SegmentSummary, StrategyDistItem } from "@/types/segmentation";

/** Engine feature keys → human labels (shared by segment cards + auto-routing). */
export const FEATURE_LABELS: Record<string, string> = {
  lag_rolling: "Lag + Rolling",
  price: "Price",
  fourier: "Fourier seasonality",
  holiday: "Holiday effects",
  promo: "Promo / Scheme",
  events: "User events",
  cross_sku: "Cross-SKU pool",
};

/** Engine strategy keys → model display names. */
export const MODEL_LABELS: Record<string, string> = {
  prophet: "Prophet",
  local_sarimax_promo: "SARIMAX + promo",
  global_lgbm: "Global LightGBM",
  global_lgbm_full: "Global LightGBM",
  moe: "MoE",
  dl_moe: "Deep MoE",
  catboost: "CatBoost",
  xgb_quantile_90: "XGBoost",
  autoarima: "AutoARIMA",
  theta: "Theta",
  holt_winters: "Holt-Winters",
  croston_sba: "Croston / SBA",
  tsb: "TSB",
  naive_seasonal: "Naive Seasonal",
  chronos_zero_shot: "Chronos zero-shot",
  naive_zero: "Naive Zero",
};

/** Best-effort display name for a model/strategy key. */
export const modelName = (k: string): string => MODEL_LABELS[k] ?? humanizeKey(k);

/** Title-case an engine snake_case key ("quantile_lgbm" → "Quantile Lgbm"). */
export function humanizeKey(k: string): string {
  return (k || "")
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Confidence-interval source key → display ("quantile_lgbm" → "Quantile LightGBM"). */
export function ciMethodName(k: string | null | undefined): string | null {
  if (!k) return null;
  const map: Record<string, string> = {
    quantile_lgbm: "Quantile LightGBM",
    quantile_gbm: "Quantile GBM",
    conformal: "Conformal",
    residual_bootstrap: "Residual bootstrap",
    empirical: "Empirical residuals",
    parametric: "Parametric",
    normal: "Normal (parametric)",
  };
  return map[k] ?? humanizeKey(k);
}

/** Reconciliation key → display ("bottom_up" → "Bottom-up"). */
export function reconcileName(k: string | null | undefined): string | null {
  if (!k) return null;
  const map: Record<string, string> = {
    bottom_up: "Bottom-up",
    top_down: "Top-down",
    middle_out: "Middle-out",
  };
  return map[k] ?? humanizeKey(k);
}

/** Residual-correction key → display ("xgb" → "XGB residual"; "none"/null → null). */
export function residualName(k: string | null | undefined): string | null {
  if (!k || k.toLowerCase() === "none") return null;
  return `${k.toUpperCase()} residual`;
}

/**
 * Shared Profile & Route routing summary (Phase X.L · Task 9).
 *
 * SINGLE source of truth for everything derived from the segment grid — the
 * segment cards, the "Recommended forecasting strategy" chart, the Auto-Routed
 * Algorithms section and the per-segment overrides all consume these helpers so
 * they can never disagree. No component re-aggregates segment data on its own.
 *
 * Why this exists: the backend's `strategyDistribution` groups SKUs by the
 * per-SKU `recommended_strategy` (cold-start / short-history / intermittency
 * routing), which is a DIFFERENT view from each segment's architecture primary
 * model. The Streamlit "Recommended forecasting strategy" chart shows the
 * per-segment primary models — so we aggregate them here from the segment grid.
 */

// Distinct, accessible palette for the primary-model groups (a group can span
// several segments, so segment colors can't be reused 1:1).
const ROUTING_PALETTE = [
  "#2563eb", "#7c3aed", "#0891b2", "#ea580c", "#16a34a",
  "#db2777", "#ca8a04", "#4f46e5", "#0d9488", "#dc2626",
];

/** Segments that actually contain items (count > 0). Empty/zero segments are
 *  hidden everywhere on Profile & Route (Task 2). Sorted largest-first. */
export function visibleSegments(segments: SegmentSummary[]): SegmentSummary[] {
  return [...(Array.isArray(segments) ? segments : [])]
    .filter((s) => (s.skuCount ?? 0) > 0)
    .sort((a, b) => b.skuCount - a.skuCount);
}

export interface PrimaryModelGroup {
  /** architecture.primaryKey (stable engine key). */
  key: string;
  /** architecture.primary (display name, e.g. "Global LightGBM"). */
  model: string;
  /** Total items across every visible segment that routes to this primary. */
  count: number;
  /** Names of the segments contributing to this group. */
  segments: string[];
  color: string;
}

/**
 * Aggregate visible segments by their architecture PRIMARY model, summing item
 * counts (Task 1). Two segments sharing a primary (e.g. Stable Low + Stable
 * High → "SARIMAX + promo") collapse into ONE bar with the combined count — no
 * model is dropped and nothing is hardcoded.
 */
export function aggregatePrimaryModels(segments: SegmentSummary[]): PrimaryModelGroup[] {
  const map = new Map<string, PrimaryModelGroup>();
  for (const s of visibleSegments(segments)) {
    const arch = s.architecture;
    const rawKey = arch?.primaryKey || arch?.primary || s.segment;
    // Render via the SAME helper the cards/auto-routing use, so the chart label
    // always matches them (Task 9). Group by the DISPLAY label so engine
    // variants that render identically (e.g. global_lgbm / global_lgbm_full →
    // "Global LightGBM") merge into one bar instead of duplicating.
    const label = modelName(rawKey);
    const existing = map.get(label);
    if (existing) {
      existing.count += s.skuCount;
      existing.segments.push(s.segment);
    } else {
      map.set(label, {
        key: rawKey,
        model: label,
        count: s.skuCount,
        segments: [s.segment],
        color: "",
      });
    }
  }
  const groups = [...map.values()].sort((a, b) => b.count - a.count);
  groups.forEach((g, i) => {
    g.color = ROUTING_PALETTE[i % ROUTING_PALETTE.length] ?? "#64748b";
  });
  return groups;
}

/**
 * The aggregated primary models shaped for the existing StrategyDistributionChart
 * (`StrategyDistItem[]`). This drives the "Recommended forecasting strategy"
 * chart so it matches the segment cards exactly.
 */
export function primaryModelDistribution(segments: SegmentSummary[]): StrategyDistItem[] {
  return aggregatePrimaryModels(segments).map((g) => ({
    strategy: g.key,
    label: g.model,
    family: null,
    count: g.count,
    color: g.color,
  }));
}
