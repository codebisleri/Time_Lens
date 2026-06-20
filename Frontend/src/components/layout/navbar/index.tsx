"use client";

import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUiStore } from "@/lib/stores";
import { NavBreadcrumbs } from "./nav-breadcrumbs";
import { CommandTrigger } from "./command-trigger";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";

/**
 * Sticky top bar. Left: mobile menu button + breadcrumbs. Center/right: command
 * palette trigger, theme toggle, user menu. Backdrop blur + bottom border give
 * the Stripe/Vercel chrome feel.
 */
export function Navbar() {
  const setMobileNavOpen = useUiStore((s) => s.setMobileNavOpen);

  return (
    <header className="sticky top-12 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur-md">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={() => setMobileNavOpen(true)}
        aria-label="Open navigation"
      >
        <Menu className="size-4" />
      </Button>

      <NavBreadcrumbs />

      <div className="ml-auto flex items-center gap-2">
        <div className="hidden sm:block">
          <CommandTrigger />
        </div>
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
