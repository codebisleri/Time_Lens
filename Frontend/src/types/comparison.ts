import type { ID, ISODateString } from "./api";

/** Per-period values across the scenarios being compared (long-to-wide shape
 *  the comparison chart consumes directly). */
export interface ComparisonPoint {
  date: ISODateString;
  /** scenarioId -> value for that period. */
  values: Record<ID, number>;
}

/** Aggregate delta of a scenario against the pinned baseline. */
export interface ScenarioDelta {
  scenarioId: ID;
  scenarioName: string;
  totalUnits: number;
  totalRevenue?: number;
  unitsDeltaPct: number;
  revenueDeltaPct?: number;
  /** Whether this scenario is the comparison baseline. */
  isBaseline: boolean;
}

export interface ComparisonResult {
  baselineScenarioId: ID;
  scenarioIds: ID[];
  series: ComparisonPoint[];
  deltas: ScenarioDelta[];
  generatedAt: ISODateString;
}

export interface ComparisonRequest {
  scenarioIds: ID[];
  baselineScenarioId: ID;
  metric?: "units" | "revenue";
}
