import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { User } from "@/types/auth";
import { authService } from "@/lib/api/services";
import type { LoginCredentials } from "@/types/auth";
import { normalizeError } from "@/lib/api/error";

/**
 * Session/client auth state. The actual session lives in an httpOnly cookie;
 * this store only mirrors the *user* and auth status for the UI. It never holds
 * a token. All side effects go through authService so swapping mock→real auth
 * touches nothing here.
 */
interface AuthState {
  user: User | null;
  status: "unknown" | "authenticated" | "unauthenticated";
  isLoading: boolean;
  error: string | null;

  login: (credentials: LoginCredentials) => Promise<boolean>;
  logout: () => Promise<void>;
  /** Rehydrate from cookie on app load (calls /auth/me). */
  hydrate: () => Promise<void>;
  reset: () => void;
}

export const useAuthStore = create<AuthState>()(
  devtools(
    (set) => ({
      user: null,
      status: "unknown",
      isLoading: false,
      error: null,

      login: async (credentials) => {
        set({ isLoading: true, error: null });
        try {
          const { user } = await authService.login(credentials);
          set({ user, status: "authenticated", isLoading: false });
          return true;
        } catch (err) {
          set({
            isLoading: false,
            status: "unauthenticated",
            error: normalizeError(err).message,
          });
          return false;
        }
      },

      logout: async () => {
        try {
          await authService.logout();
        } finally {
          set({ user: null, status: "unauthenticated", error: null });
        }
      },

      hydrate: async () => {
        try {
          const user = await authService.me();
          set({ user, status: "authenticated" });
        } catch {
          set({ user: null, status: "unauthenticated" });
        }
      },

      reset: () => set({ user: null, status: "unauthenticated", error: null }),
    }),
    { name: "auth-store" },
  ),
);
