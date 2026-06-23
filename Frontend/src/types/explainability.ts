/** Forecast Explainability payloads (backend `/explainability/*`, read-only). */

export interface ExogenousContribution {
  /** Signed contribution percentage (negative when the driver is inversely related). */
  pct: number;
  correlation: number;
}

export interface DriverContributions {
  trend: number;
  seasonality: number;
  holiday: number;
  residual: number;
  /** Keyed by humanized driver label (Price, Promotion, …). */
  exogenous: Record<string, ExogenousContribution>;
  slopeDirection: "up" | "down" | "flat";
}

export interface WaterfallStep {
  label: string;
  value: number;
  type: "base" | "delta" | "total";
}

export interface LocalExplainability {
  available: boolean;
  entity: string;
  /** Champion model label for this entity (drives the model-specific panel). */
  model: string;
  contributions: DriverContributions | null;
  waterfall: WaterfallStep[];
}

export interface HorizonPeriod {
  label: string;
  /** Relative horizon offset — "M+1", "M+2", … */
  index?: string;
  base: number;
  trend: number;
  seasonality: number;
  exogenous?: number;
  residual?: number;
  /** Per-period contribution shares (sum ≈ 100 across trend/seasonality/exogenous/residual). */
  trendPct?: number;
  seasonalityPct?: number;
  exogenousPct?: number;
  residualPct?: number;
  /** Per-driver ABSOLUTE contributions for this month (signed, demand units):
   *  Trend / Seasonality / Holiday / Promotion / Price / Weather / … / Residual.
   *  Drives the monthly Forecast Bridge + actual-value driver contribution. */
  drivers?: Record<string, number>;
}

export interface HorizonExplainability {
  available: boolean;
  entity: string;
  periods: HorizonPeriod[];
}
