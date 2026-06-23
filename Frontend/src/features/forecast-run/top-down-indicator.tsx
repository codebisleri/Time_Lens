"use client";

import { Layers } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Phase Y.2 — status pill reflecting the planner's Top-Down choice (read from
 * the forecast store). Green when enabled, gray when disabled. Reused by the
 * forecast-mode summary card and the results-strategy header.
 */
export function TopDownBadge({
  enabled,
  className,
}: {
  enabled: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold",
        enabled
          ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
          : "border-border bg-muted text-muted-foreground",
        className,
      )}
    >
      <Layers className="size-3.5" aria-hidden />
      {enabled ? "Top-Down Enabled" : "Top-Down Disabled"}
    </span>
  );
}
