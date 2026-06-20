"use client";

import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";

/**
 * D.1 — custom native window controls (minimize / maximize-restore / close) for
 * the frameless Electron shell. Rendered at the top-right of the global header
 * (and the login screen), outside the drag region (`app-no-drag`). Hidden in the
 * browser — it only mounts when the Electron preload bridge (`window.desktop`)
 * is present.
 */

interface DesktopBridge {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizeChange: (cb: (isMax: boolean) => void) => () => void;
}

function getBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { desktop?: DesktopBridge }).desktop ?? null;
}

export function WindowControls() {
  const [bridge, setBridge] = useState<DesktopBridge | null>(null);
  const [maximized, setMaximized] = useState(false);

  // Mount-only detection avoids an SSR/CSR hydration mismatch (window.desktop
  // exists only in the Electron renderer, never during SSR).
  useEffect(() => {
    const b = getBridge();
    setBridge(b);
    if (!b) return;
    b.isMaximized().then(setMaximized).catch(() => {});
    return b.onMaximizeChange(setMaximized);
  }, []);

  if (!bridge) return null;

  const btn =
    "app-no-drag flex h-9 w-11 items-center justify-center text-white/70 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:bg-white/10";

  return (
    <div className="app-no-drag flex items-stretch self-stretch">
      <button type="button" aria-label="Minimize" className={btn} onClick={() => bridge.minimize()}>
        <Minus className="size-4" />
      </button>
      <button
        type="button"
        aria-label={maximized ? "Restore" : "Maximize"}
        className={btn}
        onClick={() => bridge.maximize()}
      >
        {maximized ? <Copy className="size-3.5 -scale-x-100" /> : <Square className="size-3.5" />}
      </button>
      <button
        type="button"
        aria-label="Close"
        className="app-no-drag flex h-9 w-11 items-center justify-center text-white/70 outline-none transition-colors hover:bg-[#e81123] hover:text-white focus-visible:bg-[#e81123]"
        onClick={() => bridge.close()}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
