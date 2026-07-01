"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import type { ThemeMode } from "./theme-config";

/**
 * SSR-safe wrapper over next-themes — and the SINGLE source of truth for the
 * *active* theme across the app.
 *
 * Why this reads the DOM instead of `resolvedTheme` directly:
 *
 * next-themes (v0.4.x) applies the `dark` class to <html> inside a `useEffect`
 * on the ThemeProvider, which is an ANCESTOR of every page/chart. React flushes
 * effects bottom-up (descendants first, ancestors last), so on a live toggle a
 * deep component's effects/memos run BEFORE next-themes flips the class. Any code
 * that reads CSS custom properties via `getComputedStyle` at that moment (the
 * ECharts theme builder and every `chartColors()` / `readCssVar()` option memo)
 * would read the PREVIOUS theme's values — which is exactly why charts only
 * updated after a refresh.
 *
 * The fix: derive `resolvedMode` from the class that is ACTUALLY applied to
 * <html>, tracked with a MutationObserver. `resolvedMode` therefore changes only
 * *after* the DOM (and thus every CSS variable) is live, so every consumer keyed
 * on it — chart option memos, the registered ECharts theme, axis/legend/grid/
 * tooltip colours — recomputes against the correct, already-applied theme. No
 * page reload, no remount, no route change: the toggle propagates reactively.
 *
 * next-themes stays the controller (it writes the class + persists the choice);
 * this hook simply reports the live result of that write.
 */
export function useThemeMode() {
  const { theme, setTheme, resolvedTheme, systemTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  // The theme currently applied to <html>. Seeded from next-themes' resolved
  // value for the very first client render, then kept in lockstep with the real
  // DOM class so it can never lag the applied stylesheet.
  const [appliedMode, setAppliedMode] = useState<"light" | "dark">(
    (resolvedTheme ?? "dark") as "light" | "dark",
  );

  useEffect(() => {
    setMounted(true);
    if (typeof document === "undefined") return;
    const el = document.documentElement;
    const read = () =>
      setAppliedMode(el.classList.contains("dark") ? "dark" : "light");
    read(); // sync immediately on mount
    const observer = new MutationObserver(read);
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  // Before mount, fall back to next-themes' value (SSR/hydration safe); after
  // mount, the observed DOM class is authoritative.
  const resolvedMode = mounted
    ? appliedMode
    : ((resolvedTheme ?? "dark") as "light" | "dark");

  return {
    mounted,
    mode: (theme ?? "dark") as ThemeMode,
    resolvedMode,
    systemTheme,
    setMode: setTheme,
    isDark: resolvedMode === "dark",
  };
}