"use client";

import { useEffect } from "react";

/**
 * Register a global keyboard shortcut. Used for the ⌘K / Ctrl-K command palette
 * and other app-level shortcuts.
 *
 * @example useHotkey("k", () => openCommand(), { meta: true })
 */
export function useHotkey(
  key: string,
  handler: (e: KeyboardEvent) => void,
  options: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {},
) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const matchesKey = e.key.toLowerCase() === key.toLowerCase();
      const matchesMeta = options.meta ? e.metaKey || e.ctrlKey : true;
      const matchesCtrl = options.ctrl ? e.ctrlKey : true;
      const matchesShift = options.shift ? e.shiftKey : true;
      if (matchesKey && matchesMeta && matchesCtrl && matchesShift) {
        e.preventDefault();
        handler(e);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key, handler, options.meta, options.ctrl, options.shift]);
}
