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

/**
 * Resolve a theme token to a concrete `hsl(...)` colour at runtime.
 *
 * shadcn/Tailwind store HSL as a SPACE-separated triplet (`"213 58% 14%"`). The
 * browser's CSS engine accepts the space syntax, but ECharts/zrender's colour
 * parser splits the function arguments on COMMAS — so a space-syntax string
 * collapses to a single argument and parses to BLACK in every context that has to
 * interpolate the colour (visualMap colour scales, canvas gradients, alpha
 * blending). That is what made the correlation heatmap render black and broke
 * chart gradients.
 *
 * Emitting the COMMA syntax (`hsl(213, 58%, 14%)`) is valid for both the browser
 * (solid fills) AND zrender (interpolation), so it is safe everywhere and fixes
 * the interpolated contexts globally.
 */
export function readCssVar(name: string): string {
  if (typeof window === "undefined") return "";
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  if (!value) return "";
  // Already comma/alpha syntax? Leave it. Otherwise convert the HSL triplet's
  // whitespace separators to commas.
  const hsl = value.includes(",") ? value : value.split(/\s+/).join(", ");
  return `hsl(${hsl})`;
}
