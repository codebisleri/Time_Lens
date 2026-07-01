"use client";

import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Layers, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/utils/format";
import type { SegmentSummary } from "@/types/segmentation";

/**
 * "Generated Segmentation Summary" popup (Workflow B/C — an uploaded Segments
 * column exists). Shown immediately after Run Segmentation completes. It lists the
 * freshly-generated segment counts, then a SINGLE opt-in checkbox:
 *
 *   ☐ Use newly generated Segments
 *
 * Proceed WITHOUT ticking ⇒ keep the uploaded segmentation active (Workflow B).
 * Proceed WITH the tick    ⇒ activate the newly generated segmentation (Workflow C).
 * Neither source is overwritten — this only selects which one is active.
 */
export function GeneratedSegmentationDialog({
  open,
  segments,
  levelPlural,
  onProceed,
  onOpenChange,
}: {
  open: boolean;
  /** The freshly generated segmentation's segment cards (counts shown). */
  segments: SegmentSummary[];
  levelPlural: string;
  /** `useGenerated` reflects the checkbox: true ⇒ generated, false ⇒ uploaded. */
  onProceed: (useGenerated: boolean) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [useGenerated, setUseGenerated] = useState(false);
  // Default is ALWAYS unticked (keep uploaded) each time the popup opens.
  useEffect(() => {
    if (open) setUseGenerated(false);
  }, [open]);

  // Only segments that actually received items, in the canonical grid order.
  const rows = segments.filter((s) => s.skuCount > 0);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[82vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-lg)] focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          {/* Header */}
          <div className="flex shrink-0 items-start gap-3 border-b border-border/60 p-5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-accent/15 text-brand-accent">
              <Layers className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-lg font-semibold text-foreground">
                Generated Segmentation Summary
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted-foreground">
                TimeLens generated a new segmentation from your thresholds. Review the counts, then
                choose whether to use it. Your uploaded Segments are kept intact either way.
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

          {/* Summary */}
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {rows.length ? (
              <div className="divide-y divide-border/60 rounded-lg border border-border">
                {rows.map((s) => (
                  <div key={s.segment} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                    <span className="text-sm font-medium text-foreground">{s.segment}</span>
                    <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                      {formatNumber(s.skuCount)} {levelPlural}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No segments were produced.</p>
            )}

            {/* Single opt-in checkbox — default unticked (keep uploaded). */}
            <label className="mt-4 flex cursor-pointer items-center gap-2.5 rounded-lg border border-border p-3.5 hover:bg-secondary/40">
              <input
                type="checkbox"
                checked={useGenerated}
                onChange={(e) => setUseGenerated(e.target.checked)}
                className="size-4 accent-[hsl(var(--primary))]"
                aria-label="Use newly generated Segments"
              />
              <span className="text-sm font-medium text-foreground">Use newly generated Segments</span>
            </label>
          </div>

          {/* Footer — mandatory Proceed. */}
          <div className="flex shrink-0 justify-end border-t border-border/60 p-4">
            <Button onClick={() => onProceed(useGenerated)} className="sm:w-40">
              Proceed
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
