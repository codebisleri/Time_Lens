"use client";

import { cn } from "@/lib/utils";
import { NAV_SECTIONS } from "@/lib/constants/navigation";
import { SidebarItem } from "./sidebar-item";

/** Renders the full navigation tree from NAV_SECTIONS config. */
export function SidebarNav({ collapsed }: { collapsed: boolean }) {
  return (
    <nav className="flex flex-col gap-4 px-3 py-2">
      {NAV_SECTIONS.map((section, i) => (
        <div key={section.title ?? i} className="flex flex-col gap-1">
          {section.title && !collapsed ? (
            <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
              {section.title}
            </p>
          ) : null}
          {section.title && collapsed && i > 0 ? (
            <div className={cn("mx-3 mb-1 mt-2 h-px bg-sidebar-border")} />
          ) : null}
          {section.items.map((item) => (
            <SidebarItem key={item.href} item={item} collapsed={collapsed} />
          ))}
        </div>
      ))}
    </nav>
  );
}
