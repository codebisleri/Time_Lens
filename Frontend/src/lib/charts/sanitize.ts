import type { EChartsOption } from "echarts";

/**
 * Defensive ECharts option sanitizer — the last line of defense before any
 * `setOption()`. zrender's animator (`interpolate1DArray` → `Track.step`, kicked
 * by the animation loop on hover/update) dereferences `.length` on a keyframe
 * value and throws "Cannot read properties of undefined (reading 'length')" when
 * a series data point is `undefined`, `NaN`, or `Infinity`. Those values must
 * never reach ECharts.
 *
 * Guarantees, applied to every series' `data` (and dataset `source`):
 *   - `undefined`            → `null`   (ECharts treats null as a gap; undefined breaks the animator)
 *   - `NaN` / `±Infinity`    → `null`
 *   - finite numbers         → kept as-is
 *   - strings (axis labels)  → kept     (so [label, value] tuples survive)
 *   - array items ([x,y], [x,y,v], boxplot [min,q1,median,q3,max]) → same length,
 *     each element cleaned the same way (cardinality is preserved → no length
 *     mismatch is ever introduced)
 *   - `{ value, itemStyle, ... }` object items → `value` cleaned, styling kept
 *
 * `null` is deliberately preserved: it's the valid "no point here" marker for
 * line gaps and sparse scatter overlays.
 */

function cleanScalar(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return v; // strings (labels), null, dates, etc.
}

function cleanItem(item: unknown): unknown {
  if (item === undefined) return null;
  if (item === null) return null;
  if (typeof item === "number") return Number.isFinite(item) ? item : null;
  if (typeof item === "string") return item;
  if (Array.isArray(item)) {
    // Preserve length (cardinality) — only clean each element.
    return item.map((el) => (Array.isArray(el) ? cleanItem(el) : cleanScalar(el)));
  }
  if (typeof item === "object") {
    const obj = item as Record<string, unknown>;
    if ("value" in obj) {
      const value = obj.value;
      return {
        ...obj,
        value: Array.isArray(value)
          ? value.map((el) => cleanScalar(el))
          : cleanScalar(value),
      };
    }
    return item;
  }
  return item;
}

function cleanData(data: unknown): unknown {
  return Array.isArray(data) ? data.map(cleanItem) : data;
}

const SAFE_STOP = "transparent";

/**
 * Harden a style object's `color` against zrender's
 * `CanvasGradient.addColorStop` crash ("The value provided ('') is not a valid
 * color"). Any gradient stop whose color is not a non-empty string is replaced
 * with a safe fallback; an empty solid color is dropped so ECharts falls back to
 * the series/theme default. Returns a NEW object only when something changed
 * (never mutates the memo'd option).
 */
function fixStyleColor(style: unknown): unknown {
  if (!style || typeof style !== "object") return style;
  const s = style as Record<string, unknown>;
  const color = s.color;
  if (color && typeof color === "object") {
    const g = color as Record<string, unknown>;
    if (Array.isArray(g.colorStops)) {
      const stops = (g.colorStops as Record<string, unknown>[]).map((st) =>
        st && typeof st === "object" && typeof st.color === "string" && st.color.trim()
          ? st
          : { ...(st as object), color: SAFE_STOP },
      );
      return { ...s, color: { ...g, colorStops: stops } };
    }
    return style;
  }
  if (color === "" || color === null) {
    const rest = { ...s };
    delete rest.color;
    return rest;
  }
  return style;
}

const STYLE_KEYS = ["itemStyle", "areaStyle", "lineStyle"] as const;

function fixSeriesColors(sObj: Record<string, unknown>): Record<string, unknown> {
  let out = sObj;
  for (const key of STYLE_KEYS) {
    if (out[key]) {
      const fixed = fixStyleColor(out[key]);
      if (fixed !== out[key]) out = out === sObj ? { ...sObj, [key]: fixed } : { ...out, [key]: fixed };
    }
  }
  return out;
}

/**
 * §3 — DEEP gradient guard. zrender calls `CanvasGradient.addColorStop(offset,
 * color)` for ANY gradient object anywhere in the option (series styles, but also
 * markArea/markLine/markPoint, visualMap, backgroundColor, custom render, …). If
 * a stop's `color` is undefined / "" / non-string, the canvas API throws
 * ("value provided ('undefined') could not be parsed as a color"), crashing the
 * chart on hover/render. This walks the WHOLE option tree and replaces every bad
 * colorStop color with a safe transparent fallback. Clone-on-write: a node is
 * rebuilt only when a descendant changed, and functions (tooltip formatters,
 * toolbox onclick, …) are passed through by reference untouched.
 */
function fixGradientsDeep(node: unknown): unknown {
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((c) => {
      const f = fixGradientsDeep(c);
      if (f !== c) changed = true;
      return f;
    });
    return changed ? out : node;
  }
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const k in obj) {
    const v = obj[k];
    if (typeof v === "function") {
      out[k] = v;
      continue;
    }
    const f = fixGradientsDeep(v);
    if (f !== v) changed = true;
    out[k] = f;
  }
  // Repair a gradient definition at THIS level (after children are processed).
  if (Array.isArray(out.colorStops)) {
    const stops = (out.colorStops as unknown[]).map((st) =>
      st && typeof st === "object" &&
      typeof (st as Record<string, unknown>).color === "string" &&
      ((st as Record<string, unknown>).color as string).trim()
        ? st
        : { ...(st as object), color: SAFE_STOP },
    );
    if (stops.some((s, i) => s !== (out.colorStops as unknown[])[i])) {
      out.colorStops = stops;
      changed = true;
    }
  }
  return changed ? out : node;
}

/**
 * Returns a shallow-cloned option with sanitized series/dataset data. The input
 * is never mutated (it usually comes from a `useMemo`, and a tooltip formatter
 * must never see a mutated reference).
 */
export function sanitizeEChartsOption(option: EChartsOption): EChartsOption {
  if (!option || typeof option !== "object") return option;
  const next = { ...(option as Record<string, unknown>) } as EChartsOption;

  // ── series ──
  const series = (next as Record<string, unknown>).series;
  if (Array.isArray(series)) {
    (next as Record<string, unknown>).series = series.map((s) => {
      if (!s || typeof s !== "object") return s;
      let sObj = s as Record<string, unknown>;
      if ("data" in sObj) sObj = { ...sObj, data: cleanData(sObj.data) };
      return fixSeriesColors(sObj);
    });
  } else if (series && typeof series === "object") {
    let sObj = series as Record<string, unknown>;
    if ("data" in sObj) sObj = { ...sObj, data: cleanData(sObj.data) };
    (next as Record<string, unknown>).series = fixSeriesColors(sObj);
  }

  // ── dataset.source (dataset transforms) ──
  const dataset = (next as Record<string, unknown>).dataset;
  const cleanDataset = (d: unknown) => {
    if (!d || typeof d !== "object") return d;
    const dObj = d as Record<string, unknown>;
    return "source" in dObj && Array.isArray(dObj.source)
      ? { ...dObj, source: (dObj.source as unknown[]).map(cleanItem) }
      : dObj;
  };
  if (Array.isArray(dataset)) {
    (next as Record<string, unknown>).dataset = dataset.map(cleanDataset);
  } else if (dataset) {
    (next as Record<string, unknown>).dataset = cleanDataset(dataset);
  }

  // §3 — final deep pass: guarantee no undefined/empty gradient stop survives
  // anywhere in the option (covers markArea/visualMap/etc. the per-series pass
  // above does not reach). The hover crash cannot recur after this.
  return fixGradientsDeep(next) as EChartsOption;
}
