import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

/**
 * Global UI/chrome state. Persisted slices (sidebar collapse) survive reloads.
 * Mobile nav is ephemeral. No server data lives here.
 */
interface UiState {
  sidebarCollapsed: boolean;
  mobileNavOpen: boolean;

  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setMobileNavOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()(
  devtools(
    persist(
      (set) => ({
        sidebarCollapsed: false,
        mobileNavOpen: false,

        toggleSidebar: () =>
          set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
        setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
        setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),
      }),
      {
        name: "tl-ui",
        // Only persist durable preferences, not transient overlay state.
        partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed }),
      },
    ),
    { name: "ui-store" },
  ),
);
