/** Exploratory Data Analysis payload (backend `/eda`). */
export interface EdaSeriesPoint {
  date: string;
  value: number | null;
}

/** Pairwise exogenous-driver correlation matrix (backend `/eda/correlation`).
 *  `matrix[i][j]` is the Pearson correlation of `columns[i]` vs `columns[j]`
 *  (null when undefined). Drivers include uploaded numeric exog + engineered
 *  features (lag/rolling/seasonal/holiday). */
export interface EdaCorrelationResult {
  available: boolean;
  columns: string[];
  matrix: (number | null)[][];
  outcome: string | null;
}

export interface EdaDataQuality {
  totalRecords: number;
  nPeriods: number;
  minDate: string | null;
  maxDate: string | null;
  missingValues: number;
  frequency: string;
  frequencyLabel: string;
  skuCount: number;
  /** Total revenue across the full dataset (Streamlit Data-tab KPI). */
  totalRevenue?: number | null;
  /** Total sales units across the full dataset (revenue fallback). */
  totalSalesUnits?: number | null;
}

export interface EdaTrend {
  mean: number | null;
  min: number | null;
  max: number | null;
  std: number | null;
  total: number | null;
  growthPct: number | null;
  slope: number | null;
  direction: "up" | "down" | "flat";
}

export interface EdaSeasonalPoint {
  label: string;
  value: number | null;
}

export interface EdaDecompositionPoint {
  date: string;
  trend: number | null;
  seasonal: number | null;
  resid: number | null;
}

export interface EdaAcfPoint {
  lag: number;
  value: number | null;
}

/** Target Variable Distribution — histogram bins + per-month box-plot stats. */
export interface EdaHistogramBin {
  binStart: number | null;
  binEnd: number | null;
  label: string;
  count: number;
}

export interface EdaMonthlyBox {
  month: string;
  min: number | null;
  q1: number | null;
  median: number | null;
  q3: number | null;
  max: number | null;
}

export interface EdaDistribution {
  histogram: EdaHistogramBin[];
  monthlyBox: EdaMonthlyBox[];
}

/** Holiday Analysis — markers + avg-on/off-holiday comparison (India calendar). */
export interface EdaHolidayMarker {
  date: string | null;
  value: number | null;
}

export interface EdaHoliday {
  available: boolean;
  /** Holiday-calendar country code the backend used (the configured holiday country). */
  country?: string | null;
  markers: EdaHolidayMarker[];
  holidayCount: number;
  avgHoliday: number | null;
  avgNonHoliday: number | null;
}

export interface EdaOutlier {
  date: string | null;
  value: number | null;
  isHoliday: boolean;
  suggestedAction: string;
  correctAnomaly: boolean;
}

export interface EdaAnomalySummary {
  totalPotential: number;
  correctedCount: number;
}

export interface EdaResult {
  mode: "portfolio" | "sku";
  sku: string | null;
  datasetId: string;
  series: EdaSeriesPoint[];
  dataQuality: EdaDataQuality;
  trend: EdaTrend;
  seasonality: EdaSeasonalPoint[];
  peakMonth: string | null;
  distribution: EdaDistribution;
  decomposition: EdaDecompositionPoint[] | null;
  decompositionReason: string;
  autocorrelation: EdaAcfPoint[];
  partialAutocorrelation: EdaAcfPoint[];
  /** Streamlit warning text when the series is too short for 20-lag ACF/PACF. */
  acfPacfReason: string;
  holiday: EdaHoliday;
  outliers: { count: number; points: EdaOutlier[]; summary: EdaAnomalySummary };
}

/** Response of `POST /eda/anomalies` — the recomputed clean series + markers. */
export interface EdaCorrectedAnomaly {
  date: string | null;
  original: number | null;
  replacedWith: number | null;
}

export interface EdaAnomalyApplyResult {
  series: EdaSeriesPoint[];
  correctedAnomalies: EdaCorrectedAnomaly[];
  summary: EdaAnomalySummary;
}
