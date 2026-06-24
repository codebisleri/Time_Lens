import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils/format";
import { FEATURE_LABELS, modelName } from "@/lib/utils/routing-summary";
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

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[0.66rem] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

function Chip({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span
      className="inline-flex items-center rounded-full border px-1.5 py-0.5 text-[0.66rem] font-medium leading-none text-foreground/90"
      style={{ borderColor: `${color}55`, background: `${color}12` }}
    >
      {children}
    </span>
  );
}

/**
 * Segment routing card (Phase Y.8 — simplified). Each card shows ONLY: the
 * segment header (name + priority + count + contribution share), its Primary
 * Models, Secondary Models, and the engineered Feature Tags. The routing
 * rationale and the CI / reconciliation / residual footer were removed for a
 * cleaner read. Equal-height flex column with the feature tags anchored to the
 * bottom (spacer) so every card aligns in the grid. READ-ONLY: every value comes
 * from the segment's stored `architecture` recipe; no routing/forecast logic runs.
 */
function ArchitectureCard({
  seg,
  levelPlural,
  revLabel,
}: {
  seg: SegmentSummary;
  levelPlural: string;
  revLabel: string;
}) {
  const color = seg.color ?? "#64748b";
  const arch = seg.architecture;
  const dim = seg.skuCount === 0;
  const features = arch.features.map((f) => FEATURE_LABELS[f] ?? f);
  const secondary = arch.blend.map(modelName);

  return (
    <Card className={cn("overflow-hidden p-0", dim && "opacity-60")}>
      <div className="space-y-3 p-4" style={{ borderLeft: `4px solid ${color}` }}>
        {/* Header — segment name + priority */}
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold leading-snug text-foreground">{seg.segment}</h3>
          {seg.priority ? (
            <Badge variant={PRIORITY_VARIANT[seg.priority] ?? "secondary"}>{seg.priority}</Badge>
          ) : null}
        </div>

        {/* Metrics — item count + contribution share */}
        <div className="space-y-0.5">
          <p className="text-2xl font-semibold tabular-nums" style={{ color }}>
            {formatNumber(seg.skuCount)}
          </p>
          <p className="text-xs font-medium tabular-nums text-muted-foreground">
            {seg.revenueSharePct != null ? seg.revenueSharePct.toFixed(1) : "0.0"}% {revLabel} ·{" "}
            {formatNumber(seg.skuCount)} {levelPlural}
          </p>
        </div>

        {/* Primary models */}
        <div className="space-y-1">
          <FieldLabel>Primary Models</FieldLabel>
          <p className="text-sm font-semibold text-foreground">{modelName(arch.primaryKey)}</p>
        </div>

        {/* Secondary models */}
        {secondary.length ? (
          <div className="space-y-1">
            <FieldLabel>Secondary Models</FieldLabel>
            <div className="flex flex-wrap gap-1">
              {secondary.map((m) => (
                <Chip key={m} color={color}>
                  {m}
                </Chip>
              ))}
            </div>
          </div>
        ) : null}

        {/* Feature tags — appear immediately after the secondary models. Phase
            Y.18: no spacer / forced height — the card height follows its content. */}
        {features.length ? (
          <div className="space-y-1">
            <FieldLabel>Feature Tags</FieldLabel>
            <div className="flex flex-wrap gap-1">
              {features.map((f) => (
                <Chip key={f} color={color}>
                  {f}
                </Chip>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * Profile & Route segment cards. ALL segments — the Volatility × Contribution
 * matrix, lifecycle overrides and the CV-NULL triage bucket — render in ONE
 * continuous 4-column grid. Phase Y.18: cards size to their CONTENT (no forced
 * equal height / footer anchoring), so heights may differ and there is no empty
 * vertical space. Matrix cards are always shown (the playbook stays visible even
 * at zero count); lifecycle / triage cards appear when populated. Responsive:
 * 1 col (mobile) → 2 (tablet) → 4 (desktop).
 */
export function SegmentArchitecture({
  segments,
  levelPlural = "Items",
  revenueBasis = "revenue",
}: {
  segments: SegmentSummary[];
  levelPlural?: string;
  revenueBasis?: "revenue" | "volume";
}) {
  const revLabel = revenueBasis === "revenue" ? "rev" : "vol";
  const matrix = segments.filter((s) => s.group === "matrix");
  const lifecycle = segments.filter((s) => s.group === "lifecycle" && s.skuCount > 0);
  const triage = segments.filter((s) => s.group === "triage" && s.skuCount > 0);
  const cards = [...matrix, ...lifecycle, ...triage];

  return (
    <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((s) => (
        <ArchitectureCard key={s.segment} seg={s} levelPlural={levelPlural} revLabel={revLabel} />
      ))}
    </div>
  );
}
