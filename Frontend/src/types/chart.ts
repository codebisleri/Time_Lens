import type { ISODateString } from "./api";

/** Prop contracts for the chart wrapper layer (components/charts/*). These keep
 *  page code free of raw ECharts option objects. */

export interface SeriesConfig {
  key: string;
  name: string;
  /** Token index into the chart palette (--chart-1..8); falls back to theme. */
  colorIndex?: number;
  type?: "line" | "bar" | "area";
  /** Render as a dashed line (e.g. forecast vs. actual). */
  dashed?: boolean;
}

export interface TimeSeriesDatum {
  date: ISODateString;
  [seriesKey: string]: number | string | null | undefined;
}

export interface AxisConfig {
  label?: string;
  format?: "number" | "currency" | "percent" | "compact";
  min?: number;
  max?: number;
}

export interface ConfidenceBandConfig {
  lowerKey: string;
  upperKey: string;
}
