"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Layers, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface TopDownCandidate {
  sku: string;
  segment: string;
  /** Hold-out WMAPE as a percent (e.g. 28.4). */
  wmape: number;
  reason: string;
}

/**
 * Task 19 — Top-Down Forecast RECOMMENDATION dialog.
 *
 * Shown after "Run Forecasts" ONLY when the run contains SKUs eligible for
 * Top-Down — i.e. they belong to a Volatile routing segment AND have hold-out
 * WMAPE > 20%. When none qualify the caller skips this dialog and runs directly.
 *   • "Run Top-Down" → onEnable → Top-Down is applied to EXACTLY these SKUs; the
 *     rest of the run uses the normal workflow.
 *   • "Continue Normally" → onContinueWithout → the whole run uses the normal
 *     workflow (no Top-Down).
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
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-lg)] focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          {/* Header */}
          <div className="flex shrink-0 items-start gap-3 border-b border-border/60 p-5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-accent/15 text-brand-accent">
              <Layers className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-lg font-semibold text-foreground">
                Top-Down Forecast Recommendation
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted-foreground">
                The following {levelPlural.toLowerCase()} are eligible for Top-Down Forecasting because
                they belong to the <strong>Volatile</strong> routing segment and have{" "}
                <strong>WMAPE&nbsp;&gt;&nbsp;20%</strong>.
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

          {/* Eligible SKUs */}
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
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
            <p className="mt-4 text-sm text-foreground">
              Would you like to run Top-Down Forecasting for these {levelPlural.toLowerCase()}? The
              remaining {levelPlural.toLowerCase()} will continue using the normal workflow.
            </p>
          </div>

          {/* Footer — the two spec actions. */}
          <div className="flex shrink-0 flex-col gap-2 border-t border-border/60 p-4 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={onContinueWithout}>
              Continue Normally
            </Button>
            <Button onClick={onEnable} className="bg-brand-accent text-white hover:bg-brand-accent/90">
              <Play className="size-4" /> Run Top-Down
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
