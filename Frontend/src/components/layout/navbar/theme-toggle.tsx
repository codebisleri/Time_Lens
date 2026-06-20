"use client";

import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useThemeMode } from "@/lib/theme/use-theme-mode";

export function ThemeToggle() {
  const { mounted, isDark, setMode } = useThemeMode();

  // Avoid hydration mismatch: render a stable placeholder until mounted.
  if (!mounted) {
    return <Button variant="ghost" size="icon" aria-hidden className="opacity-0" />;
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setMode(isDark ? "light" : "dark")}
      aria-label="Toggle theme"
    >
      {isDark ? <Moon className="size-4" /> : <Sun className="size-4" />}
    </Button>
  );
}
