"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useScrollSpy } from "@/lib/hooks/use-scroll-spy";
import type { NavItem } from "@/lib/constants/navigation";

/** Determines active state for a nav item, honoring nested-route prefixes. */
function useIsActive(item: NavItem) {
  const pathname = usePathname();
  if (pathname === item.href) return true;
  // When an item declares matchPrefixes, those are authoritative — this lets
  // sibling routes under a shared base (e.g. /scenarios vs /scenarios/compare)
  // own their own active state without overlap.
  if (item.matchPrefixes) {
    return item.matchPrefixes.some((p) => pathname.startsWith(p));
  }
  // Otherwise treat nested routes under the item's href as active.
  return item.href !== "/" && pathname.startsWith(`${item.href}/`);
}

export function SidebarItem({
  item,
  collapsed,
}: {
  item: NavItem;
  collapsed: boolean;
}) {
  const active = useIsActive(item);
  const Icon = item.icon;

  // F.17B §3 — scroll-spy: while this item is the active route, highlight the
  // in-page sub-section currently in view (only attaches listeners when active).
  const spyAnchors =
    active && item.sections?.length ? item.sections.map((s) => s.anchor) : [];
  const activeAnchor = useScrollSpy(spyAnchors);

  const link = (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors",
        // Active = navy-accent fill + white label + an orange left indicator bar.
        active
          ? "bg-sidebar-accent text-white before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-brand-accent before:content-['']"
          : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-white",
        collapsed && "justify-center px-0",
      )}
    >
      <Icon
        className={cn(
          "size-4 shrink-0",
          active
            ? "text-brand-accent"
            : "text-sidebar-foreground/65 group-hover:text-white",
        )}
      />
      {!collapsed && <span className="truncate">{item.label}</span>}
      {!collapsed && item.badge ? (
        <span className="ml-auto rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
          {item.badge}
        </span>
      ) : null}
    </Link>
  );

  if (!collapsed) {
    // Sub-navigation (F.9 Part 9): in-page section links, shown under the active
    // item. Hash links smooth-scroll to the section (scroll-mt clears the header).
    const sections = active && item.sections?.length ? item.sections : null;
    return (
      <div>
        {link}
        {sections ? (
          <div className="mb-1 ml-7 mt-0.5 flex flex-col border-l border-sidebar-border/70 pl-3">
            {sections.map((s) => {
              const isCurrent = s.anchor === activeAnchor;
              return (
                <Link
                  key={s.anchor}
                  href={`${item.href}#${s.anchor}`}
                  aria-current={isCurrent ? "true" : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded px-2 py-1 text-[13px] transition-all duration-200",
                    isCurrent
                      ? "bg-brand-accent/15 font-semibold text-white"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-white",
                  )}
                >
                  {/* Orange active indicator dot. */}
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 shrink-0 rounded-full transition-colors",
                      isCurrent ? "bg-brand-accent" : "bg-transparent",
                    )}
                  />
                  {s.label}
                </Link>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }

  // Collapsed: show the label in a tooltip.
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}
