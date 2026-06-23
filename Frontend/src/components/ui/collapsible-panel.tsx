"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shared animated accordion panel (Phase X.K · Task 1). A single reusable
 * collapsible used by the workflow-step cards and any future workflow steps so
 * the expand/collapse interaction is implemented once.
 *
 * • Default collapsed (override with `defaultOpen`).
 * • Smooth height animation via the CSS grid 0fr→1fr trick (no JS measuring,
 *   no layout thrash, GPU-friendly).
 * • Each panel owns its own open state, so several may stay open at once.
 * • Toggling the header button never moves the page, so scroll position is
 *   preserved.
 * • The open panel is highlighted with the brand accent border.
 */
export function CollapsiblePanel({
  header,
  children,
  defaultOpen = false,
  highlightWhenOpen = true,
  className,
}: {
  /** Trigger-row content (rendered left of the chevron). */
  header: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  highlightWhenOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      className={cn(
        "h-fit overflow-hidden rounded-xl border bg-card transition-colors duration-200",
        open && highlightWhenOpen ? "border-brand-accent/70" : "border-border",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-4 p-5 text-left transition-colors hover:bg-secondary/30"
      >
        {header}
        <ChevronDown
          aria-hidden
          className={cn(
            "ml-auto size-5 shrink-0 text-muted-foreground transition-transform duration-300",
            open && "rotate-180",
          )}
        />
      </button>

      {/* Animated region: grid-rows 0fr → 1fr gives a smooth, content-driven
          height transition without measuring the DOM. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="px-5 pb-5">{children}</div>
        </div>
      </div>
    </div>
  );
}
