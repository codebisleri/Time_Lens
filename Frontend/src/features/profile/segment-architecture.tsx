import { Boxes, GitMerge, Layers, Route, Target } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatNumber } from "@/lib/utils/format";
import type { SegmentSummary } from "@/types/segmentation";

const FEATURE_LABELS: Record<string, string> = {
  lag_rolling: "Lag + Rolling",
  price: "Price",
  fourier: "Fourier seasonality",
  holiday: "Holidays",
  promo: "Promo / Scheme",
  events: "User events",
  cross_sku: "Cross-SKU pool",
};

/** One Segment Model Architecture card — segment, description, recommended
 *  strategy + models, routing rationale, and the feature/CI/reconcile recipe. */
function ArchitectureCard({ seg }: { seg: SegmentSummary }) {
  const color = seg.color ?? "#64748b";
  const arch = seg.architecture;
  return (
    <Card className="overflow-hidden p-0">
      <div className="p-4" style={{ borderLeft: `4px solid ${color}` }}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-foreground">{seg.segment}</h3>
            <p className="text-xs text-muted-foreground">{formatNumber(seg.skuCount)} SKUs</p>
          </div>
          {seg.priority ? <Badge variant="secondary">{seg.priority}</Badge> : null}
        </div>

        {/* Description */}
        {seg.strategy ? (
          <p className="mt-2 text-xs leading-snug text-muted-foreground">{seg.strategy}</p>
        ) : null}

        {/* Recommended strategy + models */}
        <dl className="mt-3 space-y-2 text-xs">
          <div className="flex items-start gap-2">
            <Target className="mt-0.5 size-3.5 shrink-0" style={{ color }} />
            <div>
              <dt className="font-semibold text-foreground">Recommended strategy</dt>
              <dd className="text-muted-foreground">{arch.primary}</dd>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Layers className="mt-0.5 size-3.5 shrink-0" style={{ color }} />
            <div>
              <dt className="font-semibold text-foreground">Recommended models</dt>
              <dd className="text-muted-foreground">
                {arch.blend.length ? [arch.primary, ...arch.blend].join(" · ") : arch.primary}
              </dd>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Route className="mt-0.5 size-3.5 shrink-0" style={{ color }} />
            <div>
              <dt className="font-semibold text-foreground">Routing rationale</dt>
              <dd className="text-muted-foreground">{arch.tagline ?? seg.forecast ?? "—"}</dd>
            </div>
          </div>
        </dl>
      </div>

      {/* Recipe footer — features, blend method, residual, CI, reconcile */}
      <div
        className="space-y-2 border-t px-4 py-2.5"
        style={{ borderTopColor: `${color}55`, background: `linear-gradient(90deg, ${color}1a 0%, ${color}0a 100%)` }}
      >
        <div className="flex flex-wrap gap-1.5">
          {arch.features.map((f) => (
            <span key={f} className="rounded bg-background/70 px-1.5 py-0.5 text-[0.65rem] text-foreground">
              {FEATURE_LABELS[f] ?? f}
            </span>
          ))}
          {arch.residualBooster ? (
            <span className="rounded bg-background/70 px-1.5 py-0.5 text-[0.65rem] text-foreground">
              {arch.residualBooster.toUpperCase()} residual
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.65rem] text-muted-foreground">
          {arch.blendMethod ? (
            <span className="inline-flex items-center gap-1">
              <GitMerge className="size-3" /> {arch.blendMethod.replace(/_/g, " ")}
            </span>
          ) : null}
          {arch.ciSource ? <span>CI: {arch.ciSource.replace(/_/g, " ")}</span> : null}
          {arch.reconcile ? (
            <span className="inline-flex items-center gap-1">
              <Boxes className="size-3" /> {arch.reconcile.replace(/_/g, " ")}
            </span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/** Per-Segment Model Architecture — curated stack per segment (Streamlit's
 *  "🏗 Per-Segment Model Architecture" section). Matrix + lifecycle + triage. */
export function SegmentArchitecture({ segments }: { segments: SegmentSummary[] }) {
  // Show populated segments first, then the rest, so the playbook stays visible.
  const ordered = [...segments].sort((a, b) => b.skuCount - a.skuCount);
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {ordered.map((s) => (
        <ArchitectureCard key={s.segment} seg={s} />
      ))}
    </div>
  );
}
