import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Per-page wrapper giving every screen a consistent header zone (title,
 * description, actions slot) and content rhythm. Server component — pages pass
 * their interactive bits as children. This is what standardizes the Linear/
 * Vercel spacing across all eight pages.
 */
interface PageShellProps {
  title: string;
  description?: string;
  /** Right-aligned action buttons (e.g. "New Scenario", "Run Forecast"). */
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function PageShell({
  title,
  description,
  actions,
  children,
  className,
}: PageShellProps) {
  return (
    <div className={cn("mx-auto w-full max-w-[1400px] px-6 py-6", className)}>
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          {/* Brand accent — blue→orange rail marks every module header. */}
          <span
            className="mt-0.5 h-8 w-1 shrink-0 rounded-full bg-gradient-to-b from-brand to-brand-accent"
            aria-hidden
          />
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              {title}
            </h1>
            {description ? (
              <p className="text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
        </div>
        {actions ? (
          <div className="flex items-center gap-2">{actions}</div>
        ) : null}
      </header>
      <div className="space-y-6">{children}</div>
    </div>
  );
}
