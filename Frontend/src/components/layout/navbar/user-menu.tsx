"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DownloadCloud, LogOut, RotateCcw } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useAuthStore } from "@/lib/stores";
import { routes } from "@/lib/constants/routes";
import { CHECK_UPDATES_EVENT } from "@/components/desktop/update-dialog";
import { ResetWorkspaceDialog } from "./reset-workspace-dialog";

/** Avatar dropdown: identity + workspace reset + (desktop) update check + logout. */
export function UserMenu() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [resetOpen, setResetOpen] = useState(false);
  // "Check for Updates" is desktop-only (Electron preload bridge present).
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    setIsDesktop(
      typeof window !== "undefined" &&
        !!(window as unknown as { updater?: unknown }).updater,
    );
  }, []);

  const initials =
    user?.name
      ?.split(" ")
      .map((n) => n[0])
      .slice(0, 2)
      .join("") ?? "TL";

  async function handleLogout() {
    await logout();
    router.replace(routes.login);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex size-9 items-center justify-center rounded-full bg-white text-xs font-bold text-[hsl(var(--brand))] shadow-sm outline-none ring-1 ring-black/10 transition hover:ring-2 hover:ring-brand-accent focus-visible:ring-2 focus-visible:ring-brand-accent"
          aria-label="Account menu"
          title="Account"
        >
          {initials}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <div className="flex flex-col">
            <span className="text-sm font-medium text-foreground">
              {user?.name ?? "Guest"}
            </span>
            <span className="text-xs text-muted-foreground">
              {user?.email ?? "—"}
            </span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/* D.6 — manual update check (desktop only). Opens the update dialog. */}
        {isDesktop ? (
          <DropdownMenuItem
            onSelect={() => window.dispatchEvent(new CustomEvent(CHECK_UPDATES_EVENT))}
          >
            <DownloadCloud /> Check for Updates
          </DropdownMenuItem>
        ) : null}
        {/* F.18 — Reset Workspace (NOT logout): erases the whole forecasting
            session. Sits above Log out. */}
        <DropdownMenuItem onSelect={() => setResetOpen(true)}>
          <RotateCcw /> Reset Workspace
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            void handleLogout();
          }}
          className="text-destructive focus:text-destructive"
        >
          <LogOut /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>

      <ResetWorkspaceDialog open={resetOpen} onOpenChange={setResetOpen} />
    </DropdownMenu>
  );
}
