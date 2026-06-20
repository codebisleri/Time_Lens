import { Target } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils/format";
import type { SegmentSummary } from "@/types/segmentation";

const PRIORITY_VARIANT: Record<string, "destructive" | "warning" | "success" | "secondary" | "default"> = {
  Critical: "destructive",
  High: "warning",
  Medium: "secondary",
  Low: "secondary",
  Triage: "secondary",
  Launch: "default",
  "Phase-out": "secondary",
  Borrow: "default",
};

/** One segment card — count, revenue/volume share, strategy, and a tinted
 *  "Recommended model" band (mirrors the Streamlit kpi-card). */
function SegmentCard({
  seg,
  revLabel,
}: {
  seg: SegmentSummary;
  revLabel: string;
}) {
  const color = seg.color ?? "#64748b";
  const dim = seg.skuCount === 0;
  return (
    <Card className={cn("overflow-hidden p-0", dim && "opacity-70")}>
      <div className="p-4" style={{ borderLeft: `4px solid ${color}` }}>
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">{seg.segment}</h3>
          {seg.priority ? (
            <Badge variant={PRIORITY_VARIANT[seg.priority] ?? "secondary"}>
              {seg.priority}
            </Badge>
          ) : null}
        </div>
        <div className="mt-2 flex items-baseline justify-between">
          <span className="text-2xl font-semibold tabular-nums" style={{ color }}>
            {formatNumber(seg.skuCount)}
          </span>
          <span className="text-sm font-semibold text-muted-foreground tabular-nums">
            {seg.revenueSharePct != null ? seg.revenueSharePct.toFixed(1) : "0.0"}% {revLabel}
          </span>
        </div>
        {seg.strategy ? (
          <p className="mt-2 text-xs leading-snug text-muted-foreground">{seg.strategy}</p>
        ) : null}
      </div>
      <div
        className="border-t px-4 py-2.5"
        style={{
          borderTopColor: `${color}55`,
          background: `linear-gradient(90deg, ${color}1a 0%, ${color}0a 100%)`,
        }}
      >
        <div
          className="flex items-center gap-1 text-[0.62rem] font-bold uppercase tracking-[0.08em]"
          style={{ color }}
        >
          <Target className="size-3" /> Recommended model
        </div>
        <p className="mt-0.5 text-xs font-medium leading-snug text-foreground">
          {seg.forecast ?? seg.recommendedModel}
        </p>
      </div>
    </Card>
  );
}

/**
 * Full Volatility × Contribution matrix — ALL canonical segments are shown
 * (even zero-count), in Streamlit order: Stable H/M/L, Volatile H/M/L, then the
 * lifecycle overrides, then the CV NULL/0 triage bucket if present.
 */
export function SegmentGrid({
  segments,
  revenueBasis,
}: {
  segments: SegmentSummary[];
  revenueBasis: "revenue" | "volume";
}) {
  const revLabel = revenueBasis === "revenue" ? "rev" : "vol";
  const matrix = segments.filter((s) => s.group === "matrix");
  const lifecycle = segments.filter((s) => s.group === "lifecycle");
  const triage = segments.filter((s) => s.group === "triage");

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {matrix.map((s) => (
          <SegmentCard key={s.segment} seg={s} revLabel={revLabel} />
        ))}
      </div>

      {lifecycle.length ? (
        <div className="space-y-2">
          <div className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
            Lifecycle overrides (priority over volatility × contribution)
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {lifecycle.map((s) => (
              <SegmentCard key={s.segment} seg={s} revLabel={revLabel} />
            ))}
          </div>
        </div>
      ) : null}

      {triage.length ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {triage.map((s) => (
            <SegmentCard key={s.segment} seg={s} revLabel={revLabel} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SegmentGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i} className="p-5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-3 h-7 w-24" />
          <Skeleton className="mt-3 h-3 w-full" />
          <Skeleton className="mt-1.5 h-3 w-3/4" />
        </Card>
      ))}
    </div>
  );
}
