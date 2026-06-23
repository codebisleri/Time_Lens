import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

/**
 * Forecast-run session preferences (Phase Y.1 / Y.3).
 *
 * `topDownEnabled` records the planner's choice from the Top-Down Forecasting
 * dialog shown when "Run forecasts" is clicked: forecast a stable aggregate and
 * distribute it back to new/sparse/noisy SKUs by contribution. `topDownOptions`
 * holds the advanced settings (moved out of the Configuration page into the
 * dialog in Y.3). Stored here — not in component state — so the selection
 * survives re-renders and can be read by any forecast surface. It does NOT alter
 * the run payload/API; it is a session-level preference the UI owns.
 */
export interface TopDownOptions {
  aggregationLevel: string;
  weighting: string;
  applyTo: { cold: boolean; short: boolean; lumpy: boolean; noisy: boolean };
}

export const TOP_DOWN_AGGREGATION_LEVELS = ["Brand", "Category", "Enterprise"] as const;
export const TOP_DOWN_WEIGHTING = [
  "Historical average share",
  "Recent 3-month share",
  "Equal split",
] as const;

const DEFAULT_OPTIONS: TopDownOptions = {
  aggregationLevel: "Brand",
  weighting: "Historical average share",
  applyTo: { cold: true, short: false, lumpy: true, noisy: false },
};

/**
 * Per-segment model override (Phase X.L · Tasks 5–6). Mirrors the Streamlit
 * `algo_portfolio.segment_overrides[seg] = {'primary': ..., 'extras': [...]}`.
 * `primary === null` means "use auto-routed". `extras` are additional algorithms
 * to run alongside the primary for that segment's items. This is a SAVED USER
 * PREFERENCE only — it does NOT retrain models, alter forecast logic, or change
 * champion selection; the Forecast step reads it when assembling its run.
 */
export interface SegmentOverride {
  /** Selected primary model key, or null to keep the auto-routed default. */
  primary: string | null;
  /** Extra (benchmark) algorithm keys to run alongside the primary. */
  extras: string[];
}

interface ForecastPrefsState {
  topDownEnabled: boolean;
  topDownOptions: TopDownOptions;
  setTopDownEnabled: (enabled: boolean) => void;
  setTopDownOptions: (patch: Partial<TopDownOptions>) => void;

  /** Keyed by segment name. Empty/absent ⇒ that segment uses its auto-routed model. */
  segmentOverrides: Record<string, SegmentOverride>;
  setSegmentPrimary: (segment: string, primary: string | null) => void;
  toggleSegmentExtra: (segment: string, key: string) => void;
  resetSegmentOverrides: () => void;

  /**
   * Phase X.Q · Task 3 — ONE global benchmark algorithm set (= the model
   * competition pool / `compareAlgos`). Applies to every segment. `null` means
   * "not yet chosen" so the forecast page can seed it from the backend
   * `recommended` set once. Persisted so it survives refresh / restart.
   */
  benchmarkAlgos: string[] | null;
  setBenchmarkAlgos: (algos: string[]) => void;
}

const emptyOverride = (): SegmentOverride => ({ primary: null, extras: [] });

export const useForecastStore = create<ForecastPrefsState>()(
  devtools(
    persist(
      (set) => ({
        topDownEnabled: false,
        topDownOptions: DEFAULT_OPTIONS,
        setTopDownEnabled: (enabled) => set({ topDownEnabled: enabled }),
        setTopDownOptions: (patch) =>
          set((s) => ({ topDownOptions: { ...s.topDownOptions, ...patch } })),

        segmentOverrides: {},
        setSegmentPrimary: (segment, primary) =>
          set((s) => {
            const prev = s.segmentOverrides[segment] ?? emptyOverride();
            // Keep extras consistent: the primary can't also be an extra.
            const extras = prev.extras.filter((e) => e !== primary);
            return {
              segmentOverrides: {
                ...s.segmentOverrides,
                [segment]: { primary, extras },
              },
            };
          }),
        toggleSegmentExtra: (segment, key) =>
          set((s) => {
            const prev = s.segmentOverrides[segment] ?? emptyOverride();
            const has = prev.extras.includes(key);
            const extras = has
              ? prev.extras.filter((e) => e !== key)
              : [...prev.extras, key];
            return {
              segmentOverrides: {
                ...s.segmentOverrides,
                [segment]: { ...prev, extras },
              },
            };
          }),
        resetSegmentOverrides: () => set({ segmentOverrides: {} }),

        benchmarkAlgos: null,
        setBenchmarkAlgos: (algos) => set({ benchmarkAlgos: algos }),
      }),
      {
        name: "forecast-prefs",
        // Persist the saved planner preferences (segment overrides + the global
        // benchmark set), not transient top-down dialog state.
        partialize: (s) => ({
          segmentOverrides: s.segmentOverrides,
          benchmarkAlgos: s.benchmarkAlgos,
        }),
      },
    ),
    { name: "forecast-store" },
  ),
);
