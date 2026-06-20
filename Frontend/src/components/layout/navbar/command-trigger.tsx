"use client";

import { Search } from "lucide-react";
import { useUiStore } from "@/lib/stores";
import { useHotkey } from "@/lib/hooks";

/**
 * ⌘K / Ctrl-K command palette trigger. The palette dialog itself (cmdk) is
 * mounted at the app shell level and reads `commandOpen` from the UI store; this
 * is just the search-box-styled launcher in the navbar.
 */
export function CommandTrigger() {
  const setCommandOpen = useUiStore((s) => s.setCommandOpen);
  useHotkey("k", () => setCommandOpen(true), { meta: true });

  return (
    <button
      type="button"
      onClick={() => setCommandOpen(true)}
      // F.17 §1 — premium floating glass (lighter, stronger blur, subtle border).
      className="flex h-9 w-full max-w-72 items-center gap-2 rounded-lg border border-white/12 bg-white/[0.05] px-3 text-sm text-white/70 backdrop-blur-xl transition-colors hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
    >
      <Search className="size-4" />
      <span className="flex-1 text-left">Search…</span>
      <kbd className="hidden rounded border border-white/15 bg-white/10 px-1.5 font-mono text-[10px] text-white/70 sm:inline">
        ⌘K
      </kbd>
    </button>
  );
}
