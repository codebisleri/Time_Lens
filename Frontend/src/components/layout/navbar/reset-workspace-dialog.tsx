"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { resetWorkspace } from "@/lib/utils/session";
import { routes } from "@/lib/constants/routes";

/**
 * F.18 — "Start New Forecast Session?" confirmation. On confirm it runs the full
 * workspace reset (server purge + client stores + localStorage), then HARD-loads
 * the empty Data page. Auth + theme are preserved. Buttons disable + show a
 * "Starting New Session…" spinner to prevent double clicks.
 *
 * F.18B — navigation is a full document load (window.location), NOT router.push:
 * the reset is triggered from the global header, so a same-route client push to
 * /data would NOT remount the page and the cached `useDatasets()` result would
 * still paint the old hero stats (SKUs/observations/frequency/time-span). A hard
 * load re-initializes all client state + re-fetches the now-empty dataset list.
 */

const CLEARS = [
  "Uploaded datasets",
  "EDA results",
  "Forecast results",
  "Candidate & champion models",
  "Submissions & reconciliation",
  "Filters and chart selections",
  "Cached workspace state",
];

export function ResetWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await resetWorkspace();
      toast.success("Workspace reset successfully.");
      onOpenChange(false);
      // Full document load → fresh client state + empty dataset re-fetch. A brief
      // delay lets the success toast render before the page tears down; we stay
      // "busy" until the navigation so the action can't be re-triggered.
      window.setTimeout(() => window.location.assign(routes.data), 700);
      return;
    } catch (err) {
      // Never crash — surface a clear message and log the real error for debugging.
      console.error("WORKSPACE RESET ERROR:", err);
      toast.error("Unable to reset workspace.");
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-lg)] focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-[760px]"
          onEscapeKeyDown={(e) => busy && e.preventDefault()}
          onInteractOutside={(e) => busy && e.preventDefault()}
        >
          {/* Header */}
          <div className="flex items-start gap-4 p-7 pb-5">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-brand-accent/15 text-brand-accent">
              <RotateCcw className="size-6" />
            </span>
            <div className="min-w-0 space-y-1.5">
              <Dialog.Title className="text-xl font-semibold tracking-tight text-foreground">
                Start New Forecast Session?
              </Dialog.Title>
              <Dialog.Description className="text-sm leading-relaxed text-muted-foreground">
                Starting a new session will permanently remove the current workspace.
              </Dialog.Description>
            </div>
          </div>

          {/* Body — scrolls on very short screens so nothing clips. */}
          <div className="flex-1 space-y-5 overflow-y-auto px-7">
            <div className="rounded-xl border border-border/70 bg-secondary/30 p-5">
              <p className="text-sm font-medium text-foreground">
                The following items will be cleared:
              </p>
              <ul className="mt-4 grid grid-cols-1 gap-3">
                {CLEARS.map((c) => (
                  <li
                    key={c}
                    className="flex items-center gap-3 text-sm leading-relaxed text-foreground"
                  >
                    <CheckCircle2 className="size-4 shrink-0 text-brand-accent" aria-hidden />
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Warning box — light-orange, clearly separated. */}
            <div className="flex items-center gap-3 rounded-xl border border-brand-accent/30 bg-brand-accent/10 px-4 py-3.5">
              <AlertTriangle className="size-5 shrink-0 text-brand-accent" aria-hidden />
              <p className="text-sm font-medium text-foreground">
                This action cannot be undone.
              </p>
            </div>
          </div>

          {/* Footer — equal-height buttons, right-aligned (stacks on mobile). */}
          <div className="mt-6 flex flex-col-reverse gap-3 border-t border-border/60 p-7 pt-5 sm:flex-row sm:justify-end">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
              className="sm:min-w-28"
            >
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={confirm}
              className="bg-brand-accent text-white hover:bg-brand-accent/90 sm:min-w-44"
            >
              {busy ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Starting New Session…
                </>
              ) : (
                <>
                  <RotateCcw className="size-4" /> Start Fresh
                </>
              )}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
