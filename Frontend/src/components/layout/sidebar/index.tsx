"use client";

import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useUiStore } from "@/lib/stores";
import { SidebarLogo } from "./sidebar-logo";
import { SidebarNav } from "./sidebar-nav";
import { SidebarFooter } from "./sidebar-footer";

/**
 * The desktop sidebar rail + a mobile off-canvas Sheet variant. Collapsed/open
 * state is read from the UI store (persisted). Below `lg` the rail is hidden and
 * the Sheet is used instead, opened from the navbar's menu button.
 */
function SidebarInner({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="flex h-full flex-col bg-sidebar">
      <SidebarLogo collapsed={collapsed} />
      <ScrollArea className="flex-1">
        <SidebarNav collapsed={collapsed} />
      </ScrollArea>
      <SidebarFooter collapsed={collapsed} />
    </div>
  );
}

export function Sidebar() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const mobileNavOpen = useUiStore((s) => s.mobileNavOpen);
  const setMobileNavOpen = useUiStore((s) => s.setMobileNavOpen);

  return (
    <TooltipProvider delayDuration={0}>
      {/* Desktop rail */}
      <aside
        className={cn(
          // Sits below the global enterprise header (72px).
          "fixed bottom-0 left-0 top-[72px] z-30 hidden border-r border-sidebar-border transition-[width] duration-200 lg:block",
          collapsed ? "w-16" : "w-64",
        )}
      >
        <SidebarInner collapsed={collapsed} />
      </aside>

      {/* Mobile off-canvas */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-64 p-0">
          <SidebarInner collapsed={false} />
        </SheetContent>
      </Sheet>
    </TooltipProvider>
  );
}

/** Width the main content column must offset by, matching the rail state. */
export function useSidebarWidth() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  return collapsed ? "lg:pl-16" : "lg:pl-64";
}
