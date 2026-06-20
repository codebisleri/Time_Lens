"use client";

import { useEffect } from "react";
import { useAuthStore } from "@/lib/stores";
import { refreshSessionCookie } from "@/lib/api/auth-token";

/**
 * Rehydrates the auth store from the stored token on app entry (calls /auth/me
 * once) and — for the desktop shell — rolls the session presence cookie forward
 * so a regularly-used app stays logged in across restarts (D.2). Route
 * protection itself is handled by middleware; this populates the client-side
 * user for the navbar/menus. Renders nothing.
 */
export function AuthBootstrap() {
  const status = useAuthStore((s) => s.status);
  const hydrate = useAuthStore((s) => s.hydrate);

  useEffect(() => {
    // Keep the routing cookie alive whenever an authenticated session loads.
    refreshSessionCookie();
    if (status === "unknown") void hydrate();
  }, [status, hydrate]);

  return null;
}
