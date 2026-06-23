"use client";

import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Layers, Play, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Check, Field, Select } from "@/features/data/controls";
import {
  useForecastStore,
  TOP_DOWN_AGGREGATION_LEVELS,
  TOP_DOWN_WEIGHTING,
} from "@/lib/stores";

export interface TopDownCandidate {
  sku: string;
  segment: string;
  /** Hold-out WMAPE as a percent (e.g. 28.4). */
  wmape: number;
  reason: string;
}

/**
 * Phase Y.1 / Y.3 / X.J — Top-Down Forecasting RECOMMENDATION dialog.
 *
 * Shown after "Run forecasts" ONLY when the run contains items that may benefit
 * from Top-Down (new / cold-start / short-history / intermittent / highly
 * variable — see `qualifying`). When none qualify the caller skips this dialog
 * and runs directly.
 *   • "Continue Without Top-Down" → top_down_enabled = false → close → run().
 *   • "Enable Top-Down" → expand the settings (aggregation / weighting / apply-to)
 *     → "Run Forecast" saves them, sets top_down_enabled = true, closes and runs.
 * Labels use the dataset's Forecast Level term (Item No / Product ID / SKU…).
 */
export function TopDownDialog({
  open,
  qualifying,
  levelLabel,
  levelPlural,
  onEnable,
  onContinueWithout,
  onOpenChange,
}: {
  open: boolean;
  qualifying: TopDownCandidate[];
  levelLabel: string;
  levelPlural: string;
  onEnable: () => void;
  onContinueWithout: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const options = useForecastStore((s) => s.topDownOptions);
  const setOptions = useForecastStore((s) => s.setTopDownOptions);

  useEffect(() => {
    if (!open) setExpanded(false); // always reopen collapsed
  }, [open]);

  const opt = (xs: readonly string[]) => xs.map((x) => ({ value: x, label: x }));

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={`fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-lg)] focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 ${expanded ? "max-w-2xl" : "max-w-xl"}`}
        >
          {/* Header (fixed) */}
          <div className="flex shrink-0 items-start gap-3 border-b border-border/60 p-5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-accent/15 text-brand-accent">
              <Layers className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-lg font-semibold text-foreground">
                Top-Down Forecasting Recommended
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted-foreground">
                These {levelPlural.toLowerCase()} have high forecast error (WMAPE &gt; 20%) and
                volatile/intermittent/short-history demand — Top-Down may forecast them more reliably.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </Dialog.Close>
          </div>

          {/* Body (scrollable) — table + optional settings */}
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
            {qualifying.length ? (
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-secondary/60 text-xs uppercase tracking-wide text-muted-foreground backdrop-blur">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-medium">{levelLabel}</th>
                      <th className="px-3 py-1.5 text-left font-medium">Segment</th>
                      <th className="px-3 py-1.5 text-right font-medium">WMAPE</th>
                      <th className="px-3 py-1.5 text-left font-medium">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {qualifying.map((q) => (
                      <tr key={q.sku} className="border-t border-border/60">
                        <td className="px-3 py-1.5 font-mono text-xs">{q.sku}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">{q.segment}</td>
                        <td className="px-3 py-1.5 text-right font-medium tabular-nums text-destructive">
                          {q.wmape.toFixed(1)}%
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground">{q.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {/* Settings — only after the planner enables Top-Down. */}
            {expanded ? (
              <div className="grid grid-cols-1 gap-4 border-t border-border/60 pt-5 sm:grid-cols-2">
                <Field label="Aggregation level">
                  <Select
                    value={options.aggregationLevel}
                    onChange={(v) => setOptions({ aggregationLevel: v })}
                    options={opt(TOP_DOWN_AGGREGATION_LEVELS)}
                    ariaLabel="Aggregation level"
                  />
                </Field>
                <Field label="Weighting / contribution method">
                  <Select
                    value={options.weighting}
                    onChange={(v) => setOptions({ weighting: v })}
                    options={opt(TOP_DOWN_WEIGHTING)}
                    ariaLabel="Weighting method"
                  />
                </Field>
                <Field label={`Apply Top-Down to which ${levelPlural}?`} className="sm:col-span-2">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Check label={`New / cold-start ${levelPlural}`} checked={options.applyTo.cold}
                      onChange={(v) => setOptions({ applyTo: { ...options.applyTo, cold: v } })} />
                    <Check label={`Short-history ${levelPlural}`} checked={options.applyTo.short}
                      onChange={(v) => setOptions({ applyTo: { ...options.applyTo, short: v } })} />
                    <Check label={`Lumpy / intermittent ${levelPlural}`} checked={options.applyTo.lumpy}
                      onChange={(v) => setOptions({ applyTo: { ...options.applyTo, lumpy: v } })} />
                    <Check label={`Noisy (high variability) ${levelPlural}`} checked={options.applyTo.noisy}
                      onChange={(v) => setOptions({ applyTo: { ...options.applyTo, noisy: v } })} />
                  </div>
                </Field>
              </div>
            ) : null}
          </div>

          {/* Footer (sticky, always visible) */}
          <div className="flex shrink-0 flex-col gap-2 border-t border-border/60 p-4 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={onContinueWithout}>
              Continue Without Top-Down
            </Button>
            {expanded ? (
              <Button onClick={onEnable} className="bg-brand-accent text-white hover:bg-brand-accent/90">
                <Play className="size-4" /> Run Forecast
              </Button>
            ) : (
              <Button onClick={() => setExpanded(true)} className="bg-brand-accent text-white hover:bg-brand-accent/90">
                <Sparkles className="size-4" /> Enable Top-Down Forecasting
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
