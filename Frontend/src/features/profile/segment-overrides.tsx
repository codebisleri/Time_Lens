"use client";

import { useMemo } from "react";
import { RotateCcw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/utils/format";
import { modelName, visibleSegments } from "@/lib/utils/routing-summary";
import { Select } from "@/features/data/controls";
import { SearchableMultiSelect } from "@/components/common/searchable-multi-select";
import { useForecastStore } from "@/lib/stores/forecast-store";
import type { ForecastAlgorithms } from "@/types/forecast";
import type { SegmentSummary } from "@/types/segmentation";

const AUTO = "__auto__";

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

/**
 * Per-Segment Models (Phase Y.12) — one card per active segment: title · SKU
 * count · severity badge · description · Primary Model (single-select) · Secondary
 * Models (searchable multi-select dropdown). Feature tags were removed for a
 * cleaner config surface.
 *
 * Selections persist in the forecast store (segmentOverrides). Secondary models
 * become ADDITIONAL candidates in the next run's WMAPE competition — the primary
 * stays preferred and champion selection (lowest WMAPE) is unchanged. No model is
 * retrained here; nothing runs until the user launches a forecast.
 */
export function SegmentOverrides({
  segments,
  algorithms,
  levelPlural,
}: {
  segments: SegmentSummary[];
  algorithms: ForecastAlgorithms | null;
  levelPlural: string;
}) {
  const overrides = useForecastStore((s) => s.segmentOverrides);
  const setPrimary = useForecastStore((s) => s.setSegmentPrimary);
  const setExtras = useForecastStore((s) => s.setSegmentExtras);
  const reset = useForecastStore((s) => s.resetSegmentOverrides);

  const rows = visibleSegments(segments);

  // Model choice list — auto-routed strategies first, then additional/benchmark
  // algos, de-duped by key.
  const choices = useMemo(() => {
    const list = [
      ...(algorithms?.strategyInfo ?? []).map((a) => ({ ...a, kind: "auto" as const })),
      ...(algorithms?.additionalAlgorithms ?? []).map((a) => ({ ...a, kind: "extra" as const })),
    ];
    const seen = new Set<string>();
    return list.filter((a) => (seen.has(a.key) ? false : (seen.add(a.key), true)));
  }, [algorithms]);

  const labelOf = useMemo(() => {
    const m = new Map(choices.map((c) => [c.key, c]));
    return (k: string) => {
      const c = m.get(k);
      return c ? `${c.icon ? `${c.icon} ` : ""}${c.name}` : modelName(k);
    };
  }, [choices]);

  if (!rows.length || !choices.length) return null;

  const primaryOptions = [
    { value: AUTO, label: "(use auto-routed)" },
    ...choices.map((c) => ({ value: c.key, label: `${labelOf(c.key)}${c.kind === "auto" ? " (auto)" : ""}` })),
  ];

  const anyOverride = rows.some((s) => overrides[s.segment]?.primary || overrides[s.segment]?.extras?.length);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold tracking-tight text-foreground">
          Per-Segment Models <span className="text-xs font-normal text-muted-foreground">· optional</span>
        </h3>
        {anyOverride ? (
          <Button variant="outline" size="sm" onClick={reset}>
            <RotateCcw className="size-3.5" /> Reset
          </Button>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((seg) => {
          const ov = overrides[seg.segment];
          const color = seg.color ?? "#64748b";
          const primaryValue = ov?.primary ?? AUTO;
          const effectivePrimary = ov?.primary ?? seg.architecture.primaryKey;
          const extras = ov?.extras ?? [];
          // Secondary options exclude whatever is currently primary.
          const secondaryOptions = choices
            .filter((c) => c.key !== effectivePrimary)
            .map((c) => ({ value: c.key, label: labelOf(c.key) }));

          return (
            <Card key={seg.segment} className="min-h-[200px] p-0" style={{ borderLeft: `4px solid ${color}` }}>
              <CardContent className="space-y-3 p-4">
                {/* Title + count + badge */}
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h4 className="text-sm font-semibold text-foreground">{seg.segment}</h4>
                    <p className="text-xs tabular-nums text-muted-foreground">
                      {formatNumber(seg.skuCount)} {levelPlural}
                    </p>
                  </div>
                  {seg.priority ? (
                    <Badge variant={PRIORITY_VARIANT[seg.priority] ?? "secondary"}>{seg.priority}</Badge>
                  ) : null}
                </div>

                {/* Description */}
                {seg.strategy ? (
                  <p className="text-xs leading-snug text-muted-foreground">{seg.strategy}</p>
                ) : null}

                {/* Primary model — single-select (unchanged behavior). */}
                <div className="space-y-1">
                  <p className="text-[0.68rem] font-medium uppercase tracking-wide text-muted-foreground">
                    Primary Model
                  </p>
                  <Select
                    ariaLabel={`Primary model for ${seg.segment}`}
                    value={primaryValue}
                    onChange={(v) => setPrimary(seg.segment, v === AUTO ? null : v)}
                    options={primaryOptions}
                  />
                </div>

                {/* Secondary models — searchable multi-select dropdown (Phase Y.12). */}
                <div className="space-y-1">
                  <p className="text-[0.68rem] font-medium uppercase tracking-wide text-muted-foreground">
                    Secondary Models
                  </p>
                  <SearchableMultiSelect
                    ariaLabel={`Secondary models for ${seg.segment}`}
                    placeholder="Add secondary models…"
                    options={secondaryOptions}
                    value={extras}
                    onChange={(next) => setExtras(seg.segment, next)}
                  />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
