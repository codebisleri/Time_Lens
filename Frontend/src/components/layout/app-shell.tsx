"use client";

import { cn } from "@/lib/utils";
import { AppHeader } from "./app-header";
import { GlobalLoadingBar } from "./global-loading-bar";
import { UpdateDialog } from "@/components/desktop/update-dialog";
import { AssistantWidget } from "@/features/assistant/assistant-widget";
import { Sidebar, useSidebarWidth } from "./sidebar";

/**
 * Authenticated product chrome: ONE persistent 72px enterprise header (the sole
 * branding + product-identity + controls bar), the fixed planning sidebar rail,
 * and a scrollable content column on the subtle app canvas. The content column
 * offsets by the sidebar width (tracks collapsed/expanded). Rendered by
 * (app)/layout.tsx.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const sidebarPad = useSidebarWidth();

  return (
    <div className="min-h-screen bg-background">
      <GlobalLoadingBar />
      <UpdateDialog />
      <AppHeader />
      <Sidebar />
      <div
        className={cn(
          "bg-app flex min-h-[calc(100vh-72px)] flex-col transition-[padding] duration-200",
          sidebarPad,
        )}
      >
        <main className="flex-1">{children}</main>
      </div>
      <AssistantWidget />
    </div>
  );
}
