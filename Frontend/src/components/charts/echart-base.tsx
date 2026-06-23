"use client";

import { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";
import { cn } from "@/lib/utils";
import { useThemeMode } from "@/lib/theme/use-theme-mode";
import { sanitizeEChartsOption } from "@/lib/charts/sanitize";
import { buildEchartsTheme, ECHARTS_THEME_NAME } from "@/styles/echarts-theme";

/**
 * The ONLY component that touches an ECharts instance. Every concrete chart
 * (forecast-line, comparison-bar, …) builds an `option` object and hands it to
 * this wrapper. Centralizes: SSR safety (client-only), the resize observer,
 * disposal, and re-theming on dark/light switch — so individual charts stay
 * thin and consistent.
 */
interface EChartBaseProps {
  option: EChartsOption;
  className?: string;
  height?: number | string;
  /** Inject the shared enterprise toolbar (save / zoom / restore / fullscreen +
   *  scroll-zoom) on cartesian charts. Default true. */
  toolbar?: boolean;
  /** Receives the live ECharts instance once initialized (and null on dispose).
   *  Read-only escape hatch for features like PNG export — never mutate state. */
  onReady?: (chart: echarts.ECharts | null) => void;
}

// Expand-arrows icon for the custom fullscreen toolbox button.
const FULLSCREEN_ICON =
  "path://M160 96H32V224h64V160h64V96zM480 96H352v64h64v64h64V96zM96 352H32v128h128v-64H96V352zM416 416H352v64h128V352h-64v64z";

/**
 * Shared enterprise chart controls (Issue 4 — parity with Streamlit/Plotly chart
 * toolbars). Applied to CARTESIAN charts only (those with an x-axis); pie / radar
 * / gauge are skipped. Also forces `animation:false` (Issue 3) which removes the
 * zrender hover/morph animator entirely — the definitive fix for the recurring
 * `interpolate1DArray → undefined.length` crash on hover/seasonal-decomposition.
 */
function withChartControls(
  opt: EChartsOption,
  el: HTMLDivElement | null,
  enableToolbar: boolean,
): EChartsOption {
  const o = { ...(opt as Record<string, unknown>) } as Record<string, unknown>;
  // Issue 3 — kill the animator (no interpolation = no crash). Charts opting in
  // can still set animation, but default-off is the safe, parity-faithful choice.
  if (o.animation === undefined) o.animation = false;

  // Hover stability — disable series emphasis globally so hovering NEVER blanks
  // the line, confidence band, or area fill (ECharts' default emphasis focus
  // dims/redraws non-hovered series, which read as "disappearing"/flicker).
  // Applies to every chart (forecast / demand / scenario / performance) since
  // they all pass through this wrapper. A series can still opt back in by
  // setting its own `emphasis`.
  if (o.series) {
    const disableEmphasis = (s: unknown) => {
      const sr = { ...(s as Record<string, unknown>) };
      if (sr.emphasis === undefined) sr.emphasis = { disabled: true };
      return sr;
    };
    o.series = Array.isArray(o.series)
      ? (o.series as unknown[]).map(disableEmphasis)
      : disableEmphasis(o.series);
  }

  const isCartesian = !!(o.xAxis || o.yAxis);
  if (!enableToolbar || !isCartesian) return o as EChartsOption;

  if (!o.toolbox) {
    o.toolbox = {
      right: 10,
      top: 4,
      itemSize: 13,
      itemGap: 8,
      iconStyle: { borderColor: "#94a3b8" },
      emphasis: { iconStyle: { borderColor: "hsl(var(--brand-accent))" } },
      feature: {
        dataZoom: {
          yAxisIndex: "none",
          title: { zoom: "Zoom (drag a region)", back: "Reset zoom" },
        },
        dataView: {
          title: "Data view",
          readOnly: true,
          lang: ["Data view", "Close", "Refresh"],
          backgroundColor: "hsl(var(--card))",
          textColor: "hsl(var(--foreground))",
          buttonColor: "hsl(var(--brand-accent))",
        },
        restore: { title: "Reset" },
        saveAsImage: { title: "Download", name: "time-lens-chart", pixelRatio: 2 },
        myFullscreen: {
          show: true,
          title: "Fit to Screen",
          icon: FULLSCREEN_ICON,
          onclick: () => {
            try {
              if (document.fullscreenElement) void document.exitFullscreen();
              else void el?.requestFullscreen?.();
            } catch {
              /* fullscreen unsupported — no-op */
            }
          },
        },
      },
    };
  }

  // Phase X.I · Task 4 — mouse-wheel / trackpad-scroll zoom is DISABLED globally
  // so scrolling the page never accidentally rescales a chart. Zoom is
  // user-controlled ONLY via the toolbox "Box zoom" button (toolbox.dataZoom),
  // with "Reset zoom" (toolbox.restore) restoring the original scale. The
  // `inside` zoom is kept (for panning a box-zoomed view) but with wheel/move
  // disabled. Tooltip, hover and click are unaffected; wheel events pass to the
  // page so normal scrolling works.
  const existing = Array.isArray(o.dataZoom)
    ? (o.dataZoom as unknown[])
    : o.dataZoom
      ? [o.dataZoom]
      : [];
  const hasInside = existing.some(
    (d) => (d as Record<string, unknown>)?.type === "inside",
  );
  if (!hasInside) {
    o.dataZoom = [
      ...existing,
      {
        type: "inside",
        zoomOnMouseWheel: false, // ← no wheel zoom
        moveOnMouseWheel: false, // ← no wheel pan (page scroll passes through)
        moveOnMouseMove: false, // keep hover/tooltip working
        throttle: 50,
      },
    ];
  }
  return o as EChartsOption;
}

export function EChartBase({ option, className, height = 320, toolbar = true, onReady }: EChartBaseProps) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const { resolvedMode, mounted } = useThemeMode();

  // Keep the latest callback without retriggering the init effect.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // Always-current option, so the init effect can apply it without depending on
  // `option` (which would force a costly re-init on every data change).
  const optionRef = useRef(option);
  optionRef.current = option;

  // Re-register the theme whenever the resolved mode changes so colors track
  // the CSS variables for the active theme.
  const themeKey = useMemo(() => resolvedMode, [resolvedMode]);

  useEffect(() => {
    if (!mounted || !ref.current) return;
    echarts.registerTheme(ECHARTS_THEME_NAME, buildEchartsTheme());
    const instance = echarts.init(ref.current, ECHARTS_THEME_NAME);
    chartRef.current = instance;
    onReadyRef.current?.(instance);

    // Apply the current option immediately. The instance is created on a later
    // render than the first (mounted flips after mount), by which point the
    // `option` reference may be unchanged — so the separate update effect below
    // would not fire for it. Seeding here guarantees a new instance gets data.
    instance.setOption(
      withChartControls(sanitizeEChartsOption(optionRef.current ?? {}), ref.current, toolbar),
    );

    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(ref.current);

    return () => {
      observer.disconnect();
      instance.dispose();
      chartRef.current = null;
      onReadyRef.current?.(null);
    };
    // Recreate on theme change to pick up the new registered theme.
  }, [mounted, themeKey, toolbar]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !option) return;
    // zrender's animator crashes ("interpolate1DArray → Cannot read properties of
    // undefined (reading 'length')") when it morphs between structurally different
    // options — e.g. tuple/scatter/heatmap series ([x,y] / [x,y,v]) whose point
    // count changed across a re-render. clear() drops the prior graphic state so
    // each update renders fresh (identical end visuals, fresh enter animation)
    // instead of interpolating across mismatched arrays.
    chart.clear();
    chart.setOption(
      withChartControls(sanitizeEChartsOption(option), ref.current, toolbar),
    );
  }, [option, toolbar]);

  return (
    <div
      ref={ref}
      className={cn("w-full", className)}
      style={{ height }}
      role="img"
    />
  );
}
