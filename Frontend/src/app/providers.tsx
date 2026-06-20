"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/lib/theme/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { routes } from "@/lib/constants/routes";

/**
 * Global client providers mounted once at the root. Wraps theme + tooltip
 * context and the toast portal. Also listens for the `auth:unauthorized` event
 * dispatched by the API client on a 401 and bounces to login — central session-
 * expiry handling.
 *
 * When TanStack Query is added later, its QueryClientProvider slots in here with
 * no other changes.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  useEffect(() => {
    const onUnauthorized = () => router.replace(routes.login);
    window.addEventListener("auth:unauthorized", onUnauthorized);
    return () =>
      window.removeEventListener("auth:unauthorized", onUnauthorized);
  }, [router]);

  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
      <Toaster
        position="bottom-right"
        theme="dark"
        toastOptions={{ className: "border border-border" }}
      />
    </ThemeProvider>
  );
}
