"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import type { ThemeMode } from "./theme-config";

/**
 * SSR-safe wrapper over next-themes. Returns `mounted` so consumers (e.g. charts,
 * the theme toggle) can avoid hydration mismatches by deferring theme-dependent
 * rendering until after mount.
 */
export function useThemeMode() {
  const { theme, setTheme, resolvedTheme, systemTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  return {
    mounted,
    mode: (theme ?? "dark") as ThemeMode,
    resolvedMode: (resolvedTheme ?? "dark") as "light" | "dark",
    systemTheme,
    setMode: setTheme,
    isDark: (resolvedTheme ?? "dark") === "dark",
  };
}
