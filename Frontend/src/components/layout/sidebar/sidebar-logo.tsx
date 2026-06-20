import { LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Sidebar workspace header. Branding (DhishaAI | Time Lens logos + product name)
 * lives ONLY in the global enterprise header — this rail does NOT repeat the
 * logo or product title. Instead it labels the planning workspace, matching
 * enterprise tools (SAP IBP / Kinaxis) where the rail is a workspace, not a
 * second brand mark.
 */
export function SidebarLogo({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="relative border-b border-sidebar-border/70">
      <span
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-brand-accent/70 via-brand/40 to-transparent"
        aria-hidden
      />
      <div
        className={cn(
          "flex h-16 items-center gap-3 px-4",
          collapsed && "justify-center px-0",
        )}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-sidebar-border bg-sidebar-accent text-brand-accent">
          <LayoutGrid className="size-4" />
        </span>
        <span
          className={cn(
            "flex min-w-0 flex-col leading-tight transition-opacity",
            collapsed && "pointer-events-none w-0 opacity-0",
          )}
        >
          <span className="truncate text-sm font-semibold tracking-tight text-white">
            Demand Planning
          </span>
          <span className="truncate text-[10px] font-medium uppercase tracking-[0.16em] text-sidebar-foreground/60">
            Forecast Operations
          </span>
        </span>
      </div>
    </div>
  );
}
