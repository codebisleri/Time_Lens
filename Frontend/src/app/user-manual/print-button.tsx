"use client";

import { Printer } from "lucide-react";

/**
 * Print / Save-as-PDF button for the User Manual (Phase X.K · Task 2). Client
 * component so it can call window.print(); hidden in the printed output itself.
 */
export function PrintManualButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-secondary print:hidden"
    >
      <Printer className="size-4" />
      Print / Save as PDF
    </button>
  );
}
