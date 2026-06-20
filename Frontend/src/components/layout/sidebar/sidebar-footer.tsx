"use client";

import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useUiStore } from "@/lib/stores";

/** Collapse toggle pinned to the bottom of the sidebar rail. */
export function SidebarFooter({ collapsed }: { collapsed: boolean }) {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  return (
    <div className="mt-auto border-t border-sidebar-border p-3">
      {!collapsed ? (
        <p className="px-2 pb-2 text-[10px] font-medium uppercase tracking-[0.14em] text-sidebar-foreground/45">
          Powered by{" "}
          <span className="text-sidebar-foreground/70">DhishaAI</span>
        </p>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        onClick={toggleSidebar}
        className={cn(
          "w-full justify-start gap-3 text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-white",
          collapsed && "justify-center",
        )}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? (
          <PanelLeftOpen className="size-4" />
        ) : (
          <>
            <PanelLeftClose className="size-4" />
            <span>Collapse</span>
          </>
        )}
      </Button>
    </div>
  );
}
