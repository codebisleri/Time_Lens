"use client";

import { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * D.6 — auto-update dialog for the Electron shell. Subscribes to the main-process
 * update lifecycle (`window.updater`), auto-opens to NOTIFY when an update is
 * available/downloaded, and can be opened manually via the `timelens:check-updates`
 * window event (dispatched by the "Check for Updates" menu item). Desktop-only:
 * renders nothing in the browser. Time Lens branding (navy surface, orange accent).
 */

type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error";

interface UpdateStatus {
  state: UpdateState;
  version?: string;
  lastChecked?: string;
  message?: string;
}
interface UpdateProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}
interface DesktopUpdater {
  appVersion: () => Promise<string>;
  check: () => Promise<unknown>;
  download: () => Promise<unknown>;
  install: () => void;
  onStatus: (cb: (s: UpdateStatus) => void) => () => void;
  onProgress: (cb: (p: UpdateProgress) => void) => () => void;
}

export const CHECK_UPDATES_EVENT = "timelens:check-updates";

function getUpdater(): DesktopUpdater | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { updater?: DesktopUpdater }).updater ?? null;
}

const fmtMBps = (bps: number) => `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
const fmtChecked = (iso?: string) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "—";
  }
};

export function UpdateDialog() {
  const [updater, setUpdater] = useState<DesktopUpdater | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const [progress, setProgress] = useState<UpdateProgress | null>(null);

  useEffect(() => {
    const u = getUpdater();
    setUpdater(u);
    if (!u) return;
    u.appVersion().then(setAppVersion).catch(() => {});
    const offStatus = u.onStatus((s) => {
      setStatus(s);
      if (s.state !== "downloading") setProgress(null);
      // Auto-notify: surface the dialog when an update is found / ready, even if
      // the check ran silently in the background.
      if (s.state === "available" || s.state === "downloaded") setOpen(true);
    });
    const offProgress = u.onProgress((p) => {
      setProgress(p);
      setStatus((s) => (s.state === "downloaded" ? s : { ...s, state: "downloading" }));
    });
    const onManual = () => {
      setStatus({ state: "checking" });
      setOpen(true);
      void u.check();
    };
    window.addEventListener(CHECK_UPDATES_EVENT, onManual);
    return () => {
      offStatus();
      offProgress();
      window.removeEventListener(CHECK_UPDATES_EVENT, onManual);
    };
  }, []);

  const close = useCallback(() => setOpen(false), []);
  if (!updater) return null;

  const pct = Math.max(0, Math.min(100, Math.round(progress?.percent ?? 0)));

  const title =
    status.state === "downloaded"
      ? "Update ready"
      : status.state === "downloading"
        ? "Downloading update"
        : status.state === "available"
          ? "Update available"
          : status.state === "error"
            ? "Update error"
            : status.state === "not-available"
              ? "You're up to date"
              : "Checking for updates";

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border p-6 shadow-[var(--shadow-lg)] focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          style={{ background: "#071B34" }}
        >
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-accent/15 text-brand-accent">
              {status.state === "downloaded" ? (
                <RotateCcw className="size-5" />
              ) : status.state === "not-available" ? (
                <CheckCircle2 className="size-5" />
              ) : status.state === "error" ? (
                <AlertTriangle className="size-5" />
              ) : status.state === "checking" || status.state === "downloading" ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                <Download className="size-5" />
              )}
            </span>
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold text-white">{title}</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-white/65">
                {status.state === "checking" && "Checking for updates…"}
                {status.state === "available" &&
                  `Version ${status.version ?? ""} is available.`}
                {status.state === "downloading" && "Downloading the latest version…"}
                {status.state === "downloaded" &&
                  `Version ${status.version ?? ""} downloaded — restart Time Lens to install.`}
                {status.state === "not-available" && "You're running the latest version."}
                {status.state === "error" &&
                  (status.message || "Unable to check for updates. Please try again later.")}
                {status.state === "idle" && "Up to date."}
              </Dialog.Description>
            </div>
          </div>

          {/* Download progress */}
          {status.state === "downloading" ? (
            <div className="mt-4 space-y-1.5">
              <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-brand-accent transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-white/60">
                <span className="tabular-nums">{pct}%</span>
                {progress?.bytesPerSecond ? (
                  <span className="tabular-nums">{fmtMBps(progress.bytesPerSecond)}</span>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Info strip */}
          <div className="mt-4 space-y-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-xs text-white/60">
            <div className="flex justify-between">
              <span>Application version</span>
              <span className="tabular-nums text-white/85">{appVersion || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span>Last checked</span>
              <span className="text-white/85">{fmtChecked(status.lastChecked)}</span>
            </div>
            <div className="flex justify-between">
              <span>Status</span>
              <span className="capitalize text-white/85">{status.state.replace("-", " ")}</span>
            </div>
          </div>

          {/* Actions */}
          <div className="mt-6 flex justify-end gap-2">
            {status.state === "available" ? (
              <>
                <Button variant="outline" onClick={close}>Later</Button>
                <Button
                  onClick={() => void updater.download()}
                  className="bg-brand-accent text-white hover:bg-brand-accent/90"
                >
                  <Download className="size-4" /> Download
                </Button>
              </>
            ) : status.state === "downloaded" ? (
              <>
                <Button variant="outline" onClick={close}>Later</Button>
                <Button
                  onClick={() => updater.install()}
                  className="bg-brand-accent text-white hover:bg-brand-accent/90"
                >
                  <RotateCcw className="size-4" /> Restart Now
                </Button>
              </>
            ) : status.state === "downloading" ? (
              <Button variant="outline" onClick={close}>Hide</Button>
            ) : status.state === "checking" ? (
              <Button variant="outline" onClick={close}>Close</Button>
            ) : (
              <>
                <Button variant="outline" onClick={close}>Close</Button>
                <Button
                  onClick={() => {
                    setStatus({ state: "checking" });
                    void updater.check();
                  }}
                  className="bg-brand-accent text-white hover:bg-brand-accent/90"
                >
                  <RefreshCw className="size-4" /> Check again
                </Button>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
