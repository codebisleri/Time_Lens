import { CHART_SERIES_VARS, readCssVar } from "@/lib/theme/theme-config";

/**
 * Theme-bound chart colours (Issue 4). Resolve the application's CSS theme tokens
 * at render time so on-screen charts track Light/Dark exactly — call this INSIDE a
 * `resolvedMode`-keyed `useMemo` so the colours re-resolve on a theme switch. Each
 * token has a brand-safe (navy / orange / neutral grey) fallback so a missing CSS
 * variable can never produce an invisible or off-palette colour.
 *
 * Use `palette` for categorical series; the semantic slots (`positive` / `negative`
 * / `neutral`) for diverging bars — all map onto the navy + orange + grey brand
 * system rather than hardcoded blue / green / red.
 */
/**
 * Apply an alpha (0–1) to ANY colour string and return a VALID CSS/canvas colour.
 *
 * The old pattern `` `${color}e6` `` only works when `color` is a 6-digit hex —
 * appending hex-alpha onto an `hsl(...)`/`rgb(...)` string yields garbage such as
 * `hsl(213 14% 55%)e6`, which crashes canvas `addColorStop` ("could not be parsed
 * as a color") and silently breaks ECharts gradients. This helper handles hex
 * (→ 8-digit hex) and functional `hsl()`/`rgb()` (→ comma-syntax `hsla()`/`rgba()`,
 * which zrender parses), so theme-bound colours work in every chart context.
 */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const c = (color ?? "").trim();
  if (!c) return c;
  if (/^#[0-9a-fA-F]{6}$/.test(c)) {
    return c + Math.round(a * 255).toString(16).padStart(2, "0");
  }
  if (/^#[0-9a-fA-F]{3}$/.test(c)) {
    const r = c[1]!, g = c[2]!, b = c[3]!;
    return `#${r}${r}${g}${g}${b}${b}` + Math.round(a * 255).toString(16).padStart(2, "0");
  }
  const m = c.match(/^(hsl|rgb)\(([^)]+)\)$/i);
  if (m) return `${m[1]!.toLowerCase()}a(${m[2]!.trim()}, ${a})`;
  return c; // hsla()/rgba()/named colours — already valid, leave untouched
}

export function chartColors() {
  const v = (name: string, fallback: string) => readCssVar(name) || fallback;
  const palette = CHART_SERIES_VARS.map((name, i) =>
    v(name, ["#1f3a5f", "#ef7602", "#8d99a6", "#f6a04a", "#ef7602", "#3a5573", "#8d99a6", "#b4560a"][i] ?? "#8d99a6"),
  );
  return {
    palette,
    /** Gains / up / forecast — brand orange. */
    positive: v("--chart-2", "#ef7602"),
    /** Losses / down — brand navy (strong contrast against orange). */
    negative: v("--chart-1", "#1f3a5f"),
    /** Base / flat / neutral — brand grey. */
    neutral: v("--chart-3", "#8d99a6"),
    /** Primary navy (totals, actuals, history). */
    primary: v("--chart-1", "#1f3a5f"),
    /** Accent orange (highlights, forecast). */
    accent: v("--chart-2", "#ef7602"),
    /** Muted foreground (secondary series, last-year overlays). */
    muted: v("--muted-foreground", "#8d99a6"),
  };
}