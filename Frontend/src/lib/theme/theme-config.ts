/**
 * Theme metadata that lives outside CSS — mode options and the ordered list of
 * chart series tokens. Visual values themselves stay in globals.css as CSS vars;
 * this file only names and orders them so TS code can reference them safely.
 */
export type ThemeMode = "light" | "dark" | "system";

export const THEME_MODES: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export const DEFAULT_THEME: ThemeMode = "dark";

/** CSS variable names for the chart series palette, in render order. */
export const CHART_SERIES_VARS = [
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--chart-6",
  "--chart-7",
  "--chart-8",
] as const;

/** Resolve an `hsl(var(--token))` string from a raw HSL triplet at runtime. */
export function readCssVar(name: string): string {
  if (typeof window === "undefined") return "";
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value ? `hsl(${value})` : "";
}
