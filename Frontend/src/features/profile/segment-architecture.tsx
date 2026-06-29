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
    <Card className={cn("h-full overflow-hidden p-0", dim && "opacity-60")}>
      <div className="flex h-full flex-col space-y-3 p-4" style={{ borderLeft: `4px solid ${color}` }}>
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

/** Muted placeholder so every slot shows a card even at zero count — the 3×3
 *  grid never collapses and all dimensions stay equal. */
function PlaceholderCard({ name, levelPlural }: { name: string; levelPlural: string }) {
  return (
    <Card className="h-full overflow-hidden p-0 opacity-60">
      <div className="flex h-full flex-col gap-2 p-4" style={{ borderLeft: "4px solid #64748b" }}>
        <h3 className="text-sm font-semibold leading-snug text-foreground">{name}</h3>
        <p className="text-2xl font-semibold tabular-nums text-muted-foreground">0</p>
        <p className="text-xs text-muted-foreground">
          No {levelPlural.toLowerCase()} routed to this segment.
        </p>
      </div>
    </Card>
  );
}

// Fixed 3×3 layout: the Volatility × Contribution matrix (rows 1–2) + the three
// lifecycle buckets (row 3). Every slot ALWAYS renders — a real card when the
// segment is present (even at zero count), a placeholder otherwise.
const MATRIX_SLOTS: { name: string; vol: string; lvl: string }[] = [
  { name: "Stable High contributors", vol: "stable", lvl: "high" },
  { name: "Stable Mid contributors", vol: "stable", lvl: "mid" },
  { name: "Stable Low contributors", vol: "stable", lvl: "low" },
  { name: "Volatile High contributors", vol: "volatile", lvl: "high" },
  { name: "Volatile Mid contributors", vol: "volatile", lvl: "mid" },
  { name: "Volatile Low contributors", vol: "volatile", lvl: "low" },
];
const LIFECYCLE_SLOTS: { name: string; match: string }[] = [
  { name: "Churned", match: "churn" },
  { name: "New Product", match: "new" },
  { name: "Short History", match: "short" },
];

/**
 * Profile & Route segment cards in a STABLE 3×3 grid (responsive 1 → 2 → 3).
 * Equal width (grid columns) and equal height (row stretch + h-full cards).
 * Empty segments still render a placeholder so the grid never collapses.
 * READ-ONLY: real cards come from the segment's stored `architecture` recipe;
 * no routing / forecast logic runs.
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
  const find = (pred: (name: string) => boolean) =>
    segments.find((s) => pred(s.segment.toLowerCase())) ?? null;

  const slots = [
    ...MATRIX_SLOTS.map((m) => ({
      key: m.name,
      name: m.name,
      seg: find((n) => n.includes(m.vol) && n.includes(m.lvl)),
    })),
    ...LIFECYCLE_SLOTS.map((l) => ({
      key: l.name,
      name: l.name,
      seg: find((n) => n.includes(l.match)),
    })),
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {slots.map((slot) =>
        slot.seg ? (
          <ArchitectureCard key={slot.key} seg={slot.seg} levelPlural={levelPlural} revLabel={revLabel} />
        ) : (
          <PlaceholderCard key={slot.key} name={slot.name} levelPlural={levelPlural} />
        ),
      )}
    </div>
  );
}
