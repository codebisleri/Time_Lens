import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { formatForecastLevel, pluralizeLevel } from "@/lib/utils/format";

/**
 * Global Forecast-Level terminology (Phase X.O · Tasks 5 & 7).
 *
 * The platform must speak the user's own vocabulary instead of hardcoding "SKU".
 * Whatever column was chosen as the Forecast Level (Product ID, Material Code,
 * Item, Style, Article, Customer…) drives every user-visible label:
 *   `forecastLevelLabel`  → singular ("Material")
 *   `forecastLevelPlural` → plural   ("Materials")
 *
 * Persisted so the terminology survives refresh / browser restart / Electron
 * restart. Set it once when the dataset config is known (via `setForecastLevel`).
 */
interface ForecastLevelState {
  /** Singular display label, e.g. "Material", "Product", "SKU". */
  forecastLevelLabel: string;
  /** Plural display label, e.g. "Materials". */
  forecastLevelPlural: string;
  /**
   * Set the terminology from a raw level descriptor. Accepts either a raw column
   * key ("material_code") or a pre-formatted label; both are humanized. Pass a
   * mode/label pair for Enterprise / Custom-group levels.
   */
  setForecastLevel: (raw: string | null | undefined) => void;
  setForecastLevelLabel: (label: string) => void;
}

export const useForecastLevelStore = create<ForecastLevelState>()(
  devtools(
    persist(
      (set) => ({
        forecastLevelLabel: "SKU",
        forecastLevelPlural: "SKUs",
        setForecastLevel: (raw) => {
          const label = formatForecastLevel(raw);
          set({ forecastLevelLabel: label, forecastLevelPlural: pluralizeLevel(label) });
        },
        setForecastLevelLabel: (label) =>
          set({ forecastLevelLabel: label, forecastLevelPlural: pluralizeLevel(label) }),
      }),
      { name: "forecast-level" },
    ),
    { name: "forecast-level-store" },
  ),
);

/** Convenience selector hook → `{ label, plural }`. */
export function useForecastLevel(): { label: string; plural: string } {
  const label = useForecastLevelStore((s) => s.forecastLevelLabel);
  const plural = useForecastLevelStore((s) => s.forecastLevelPlural);
  return { label, plural };
}
