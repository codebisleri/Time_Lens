import { CHART_SERIES_VARS, readCssVar } from "@/lib/theme/theme-config";

/**
 * Builds an Apache ECharts theme object from the live CSS variables, so charts
 * stay in lockstep with the Tailwind/shadcn token system and re-theme on dark/
 * light switch. Call at render time (client only) and pass to <EChartBase>.
 *
 * Decoupled from any concrete chart so every chart inherits consistent axis,
 * grid, tooltip, and palette styling.
 */
export function buildEchartsTheme() {
  // §5 — every token has a hard, mode-aware fallback so axis labels, legends,
  // and tooltips are NEVER invisible even if a CSS variable is missing/unresolved
  // at theme-build time. `readCssVar` returns "" when the variable is absent.
  const isDark =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");
  // F.16 — strict navy + orange + neutral grey fallbacks (no blue/green/purple).
  const fb = {
    grid: isDark ? "rgba(255,255,255,0.10)" : "#dbe3ec",
    axis: isDark ? "rgba(255,255,255,0.65)" : "#5b6b7a",
    foreground: isDark ? "#ffffff" : "#0a1f3a",
    brand: isDark ? "#ef7602" : "#071B34",
    card: isDark ? "#0d2138" : "#ffffff",
    border: isDark ? "#3a2c1e" : "#f0e0cf",
  };
  const FALLBACK_PALETTE = [
    "#d6dee8", "#EF7602", "#94a3b8", "#F6A04A",
    "#EF7602", "#3a5573", "#8d99a6", "#b4560a",
  ];
  const livePalette = CHART_SERIES_VARS.map(readCssVar).filter(Boolean);
  const palette = livePalette.length ? livePalette : FALLBACK_PALETTE;
  const grid = readCssVar("--chart-grid") || fb.grid;
  const axis = readCssVar("--chart-axis") || fb.axis;
  const foreground = readCssVar("--foreground") || fb.foreground;
  const brand = readCssVar("--brand") || fb.brand; // Dhisha Blue — axis lines + titles
  const card = readCssVar("--card") || fb.card;
  const border = readCssVar("--border") || fb.border;

  // Shared axis-readability tokens (enterprise contrast). Labels use the full
  // foreground (high contrast, theme-aware); axis lines are brand blue; grid is
  // intentionally subtle so it supports the data rather than competing with it.
  const axisLabel = { color: foreground, fontSize: 11.5, fontWeight: 500 as const };
  const axisLineStyle = { lineStyle: { color: brand, opacity: 0.5, width: 1 } };
  // Dashed gridlines must stay visible in BOTH themes. The previous flat 0.12
  // opacity made them all-but-invisible in Light Mode (the light grey grid token
  // on a white card). Drive opacity off the mode: a touch stronger in light, kept
  // subtle in dark (where the grid token is white).
  const splitLineStyle = {
    lineStyle: { color: grid, type: "dashed" as const, opacity: isDark ? 0.18 : 0.55 },
  };
  const axisName = { color: brand, fontSize: 11, fontWeight: 600 as const };

  return {
    color: palette,
    backgroundColor: "transparent",
    textStyle: {
      fontFamily: "var(--font-sans), system-ui, sans-serif",
      color: foreground,
    },
    grid: { left: 12, right: 16, top: 30, bottom: 12, containLabel: true },
    categoryAxis: {
      axisLine: axisLineStyle,
      axisTick: { show: false },
      axisLabel: { ...axisLabel, margin: 12 },
      nameTextStyle: axisName,
      splitLine: { show: false },
    },
    valueAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel,
      nameTextStyle: axisName,
      // Subtle dashed gridlines — support the data, don't compete with it.
      splitLine: splitLineStyle,
    },
    // Slightly heavier lines with rounded caps read as demand/forecast curves
    // rather than generic plot lines. Smoothing is intentionally NOT forced here
    // so spiky series stay truthful — charts opt into `smooth` individually.
    line: {
      symbol: "circle",
      symbolSize: 6,
      showSymbol: false,
      lineStyle: { width: 2.5, cap: "round", join: "round" },
    },
    tooltip: {
      backgroundColor: card,
      borderColor: border,
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: foreground, fontSize: 12 },
      // Rounded, softly-shadowed surface — enterprise analytics tooltip feel.
      extraCssText:
        "border-radius:8px;box-shadow:0 8px 24px -6px rgba(2,18,28,0.35);backdrop-filter:saturate(1.1);",
      axisPointer: { lineStyle: { color: axis }, crossStyle: { color: axis } },
    },
    // Legend uses the full foreground (not muted) so it stays clearly legible in
    // both themes (§5 — legends were disappearing at low contrast).
    legend: { textStyle: { color: foreground }, icon: "roundRect", itemHeight: 8, itemWidth: 12 },
  };
}

/** Stable theme registration name used with echarts.registerTheme. */
export const ECHARTS_THEME_NAME = "time-lens";
