import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils/format";
import type { BrandSegmentMatrix } from "@/types/segmentation";

/** Short header label for long canonical segment names. */
function shortSegment(name: string): string {
  return name
    .replace("contributors", "")
    .replace("Stable ", "S·")
    .replace("Volatile ", "V·")
    .trim();
}

/**
 * Brand × Segment crosstab — actual matrix of SKU counts per brand per segment
 * (Streamlit's `pd.crosstab(brand, segment)`), with row/column totals. Cells are
 * heat-shaded by intensity relative to the busiest cell.
 */
export function BrandSegmentMatrixTable({ matrix }: { matrix: BrandSegmentMatrix }) {
  const max = Math.max(1, ...matrix.counts.flat());
  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium text-muted-foreground">
              Brand
            </th>
            {matrix.segments.map((s) => (
              <th key={s} className="px-2 py-2 text-center font-medium text-muted-foreground" title={s}>
                {shortSegment(s)}
              </th>
            ))}
            <th className="px-3 py-2 text-center font-semibold text-foreground">Total</th>
          </tr>
        </thead>
        <tbody>
          {matrix.brands.map((brand, r) => (
            <tr key={brand} className="border-t border-border/60">
              <td className="sticky left-0 z-10 max-w-[10rem] truncate bg-card px-3 py-1.5 text-foreground" title={brand}>
                {brand}
              </td>
              {(matrix.counts[r] ?? []).map((c, ci) => {
                const intensity = c / max;
                return (
                  <td
                    key={ci}
                    className={cn(
                      "px-2 py-1.5 text-center tabular-nums",
                      c === 0 ? "text-muted-foreground/40" : "text-foreground",
                    )}
                    style={c > 0 ? { background: `rgba(99,102,241,${0.08 + intensity * 0.4})` } : undefined}
                  >
                    {c === 0 ? "·" : formatNumber(c)}
                  </td>
                );
              })}
              <td className="px-3 py-1.5 text-center font-semibold tabular-nums text-foreground">
                {formatNumber(matrix.rowTotals[r] ?? 0)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border">
            <td className="sticky left-0 z-10 bg-card px-3 py-2 font-semibold text-foreground">Total</td>
            {matrix.colTotals.map((t, i) => (
              <td key={i} className="px-2 py-2 text-center font-semibold tabular-nums text-foreground">
                {formatNumber(t)}
              </td>
            ))}
            <td className="px-3 py-2 text-center font-semibold tabular-nums text-foreground">
              {formatNumber(matrix.rowTotals.reduce((a, b) => a + b, 0))}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
