import { Check } from "lucide-react";
import { Card } from "@/components/ui/card";
import { formatNumber } from "@/lib/utils/format";
import { FEATURE_LABELS, modelName, visibleSegments } from "@/lib/utils/routing-summary";
import type { SegmentSummary } from "@/types/segmentation";

/** Compact Segment Model Architecture card (Phase X.K · Tasks 4–6). Clear visual
 *  hierarchy: the segment name, item count, primary model and secondary/blend are
 *  the primary focus; the feature list is small and muted (secondary focus).
 *  Aggregation / CI / Hierarchy metadata is intentionally NOT shown. The item
 *  count uses the dynamic forecast-level term (e.g. "Items", "Item Nos"). */
function ArchitectureCard({ seg, levelPlural }: { seg: SegmentSummary; levelPlural: string }) {
  const color = seg.color ?? "#64748b";
  const arch = seg.architecture;
  const features: string[] = [
    ...arch.features.map((f) => FEATURE_LABELS[f] ?? f),
    ...(arch.residualBooster ? [`${arch.residualBooster.toUpperCase()} residual`] : []),
  ];

  return (
    <Card className="p-3.5" style={{ borderLeft: `4px solid ${color}` }}>
      {/* Primary focus — segment name + item count */}
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="truncate text-sm font-semibold text-foreground">{seg.segment}</h3>
        <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
          {formatNumber(seg.skuCount)} {levelPlural}
        </span>
      </div>

      {/* Primary focus — primary model + secondary / blend (label muted, value
          emphasised) */}
      <div className="mt-2.5 space-y-2 text-xs">
        <div>
          <p className="text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">
            Primary Model
          </p>
          <p className="mt-0.5 text-sm font-semibold text-foreground">{modelName(arch.primaryKey)}</p>
        </div>
        {arch.blend.length ? (
          <div>
            <p className="text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">
              Secondary / Blend
            </p>
            <p className="mt-0.5 text-xs font-medium text-foreground/90">
              {arch.blend.map(modelName).join(" · ")}
            </p>
          </div>
        ) : null}
      </div>

      {/* Secondary focus — features in small, muted, low-emphasis typography */}
      {features.length ? (
        <div className="mt-2.5 flex flex-wrap gap-x-2.5 gap-y-0.5 border-t border-border/60 pt-2 text-[0.7rem] text-muted-foreground">
          {features.map((f) => (
            <span key={f} className="inline-flex items-center gap-1">
              <Check className="size-2.5 shrink-0 opacity-70" style={{ color }} />
              {f}
            </span>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

/** Per-Segment Model Architecture — compact card grid. Populated segments first
 *  so the playbook stays visible; denser grid shows more cards per screen. The
 *  `levelPlural` term (forecast level, pluralised) labels each card's item count. */
export function SegmentArchitecture({
  segments,
  levelPlural = "Items",
}: {
  segments: SegmentSummary[];
  levelPlural?: string;
}) {
  // Task 2 — only segments with items are shown (empty segments hidden).
  const ordered = visibleSegments(segments);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {ordered.map((s) => (
        <ArchitectureCard key={s.segment} seg={s} levelPlural={levelPlural} />
      ))}
    </div>
  );
}
