"use client";

import { useState } from "react";
import { RefreshCw, Save, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Disclosure } from "@/features/workflow/disclosure";
import type { SegmentationParams, SegmentationThresholds } from "@/types/segmentation";

interface Knob {
  key: keyof SegmentationThresholds;
  param: keyof SegmentationParams;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
}

// Mirrors the Streamlit number-inputs (labels, defaults, ranges, help text).
const CONTRIBUTION_KNOBS: Knob[] = [
  {
    key: "highCumShare", param: "high_cum_share",
    label: "Top contributors cum-share", min: 0.1, max: 0.7, step: 0.05,
    help: "SKUs covering this much cumulative revenue (top-down) become 'High contributors'.",
  },
  {
    key: "midCumShare", param: "mid_cum_share",
    label: "Mid contributors cum-share", min: 0.5, max: 0.99, step: 0.01,
    help: "SKUs covering this much cum-rev become 'Mid'; rest become 'Low'. Must exceed the top-contributors cut-off.",
  },
  {
    key: "minPeriods", param: "min_periods",
    label: "Min periods (history check)", min: 2, max: 24, step: 1,
    help: "SKUs with fewer observations are tagged 'CV NULL/0' (apply NPI proxy).",
  },
];

const LIFECYCLE_KNOBS: Knob[] = [
  {
    key: "newProductMonths", param: "new_product_months",
    label: "New product window (months)", min: 1, max: 24, step: 1,
    help: "SKUs whose first sale falls within this many months of the latest data point are tagged 'New product'.",
  },
  {
    key: "churnMonths", param: "churn_months",
    label: "Churn window (months)", min: 1, max: 24, step: 1,
    help: "SKUs whose last sale is older than this many months are tagged 'Churned product'.",
  },
  {
    key: "shortHistoryMonths", param: "short_history_months",
    label: "Short history threshold (months)", min: 2, max: 24, step: 1,
    help: "SKUs with fewer than this many non-null months (and not new/churned) are tagged 'Short history'.",
  },
];

function paramFor(params: SegmentationParams, knob: Knob): number {
  return params[knob.param];
}

/**
 * Segmentation threshold controls + Validate & Save — replicates the Streamlit
 * threshold number-inputs (contribution cuts, min periods, lifecycle windows),
 * the Preview/recompute action, and the validator + notes audit-persist flow.
 */
export function SegmentThresholds({
  params,
  onPreview,
  onValidate,
  busy,
}: {
  params: SegmentationParams;
  onPreview: (t: SegmentationThresholds) => void;
  onValidate: (t: SegmentationThresholds, validatedBy: string, notes: string) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<SegmentationThresholds>(() => ({
    highCumShare: params.high_cum_share,
    midCumShare: params.mid_cum_share,
    minPeriods: params.min_periods,
    newProductMonths: params.new_product_months,
    churnMonths: params.churn_months,
    shortHistoryMonths: params.short_history_months,
  }));
  const [validator, setValidator] = useState("demo_user");
  const [notes, setNotes] = useState("");

  const setKnob = (key: keyof SegmentationThresholds, value: number) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const renderKnob = (knob: Knob) => (
    <div key={knob.key} className="space-y-1.5">
      <label className="text-xs font-medium text-foreground">{knob.label}</label>
      <Input
        type="number"
        min={knob.min}
        max={knob.max}
        step={knob.step}
        value={draft[knob.key] ?? paramFor(params, knob)}
        onChange={(e) => setKnob(knob.key, Number(e.target.value))}
        aria-label={knob.label}
      />
      <p className="text-[0.7rem] leading-snug text-muted-foreground">{knob.help}</p>
    </div>
  );

  return (
    <Disclosure
      title={
        <span className="inline-flex items-center gap-2">
          <SlidersHorizontal className="size-4 text-primary" /> Segmentation thresholds · tune &amp; validate
        </span>
      }
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
            Contribution &amp; history cuts
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {CONTRIBUTION_KNOBS.map(renderKnob)}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
            Lifecycle override thresholds (priority over volatility × contribution)
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {LIFECYCLE_KNOBS.map(renderKnob)}
          </div>
        </div>

        <Button variant="outline" onClick={() => onPreview(draft)} disabled={busy}>
          <RefreshCw className="size-4" /> Preview with these thresholds
        </Button>

        {/* Validate & Save */}
        <Card>
          <CardContent className="space-y-3 pt-6">
            <p className="text-sm font-medium text-foreground">Validate &amp; Save</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Validator name (for audit log)</label>
                <Input
                  value={validator}
                  onChange={(e) => setValidator(e.target.value)}
                  placeholder="demo_user"
                  aria-label="Validator name"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Notes (optional)</label>
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Run notes…"
                  aria-label="Validation notes"
                />
              </div>
            </div>
            <Button onClick={() => onValidate(draft, validator, notes)} disabled={busy}>
              <Save className="size-4" /> Validate &amp; Save
            </Button>
          </CardContent>
        </Card>
      </div>
    </Disclosure>
  );
}
