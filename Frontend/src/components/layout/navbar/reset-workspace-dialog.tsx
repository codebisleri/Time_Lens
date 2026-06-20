"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
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
  "uploaded datasets",
  "EDA results",
  "forecast results",
  "candidate & champion models",
  "submissions & reconciliation",
  "filters, selections & charts",
  "cached state",
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
      onOpenChange(false);
      // Full document load → fresh client state + empty dataset re-fetch.
      window.location.assign(routes.data);
      // (Stay "busy" until the navigation tears the page down.)
      return;
    } catch (err) {
      // Surface the REAL error (F.18A) instead of swallowing it.
      console.error("WORKSPACE RESET ERROR:", err);
      toast.error(
        err instanceof Error ? err.message : "Couldn’t reset the workspace. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-card p-6 shadow-[var(--shadow-lg)] focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          onEscapeKeyDown={(e) => busy && e.preventDefault()}
          onInteractOutside={(e) => busy && e.preventDefault()}
        >
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-accent/15 text-brand-accent">
              <RotateCcw className="size-5" />
            </span>
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold text-foreground">
                Start New Forecast Session?
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted-foreground">
                This will permanently remove:
              </Dialog.Description>
            </div>
          </div>

          <ul className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
            {CLEARS.map((c) => (
              <li key={c} className="flex items-center gap-2 text-sm text-foreground">
                <span className="size-1.5 shrink-0 rounded-full bg-brand-accent" aria-hidden />
                {c}
              </li>
            ))}
          </ul>

          <p className="mt-4 flex items-center gap-1.5 text-xs font-medium text-brand-accent">
            <AlertTriangle className="size-3.5" />
            This action cannot be undone.
          </p>

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={confirm}
              className="bg-brand-accent text-white hover:bg-brand-accent/90"
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
