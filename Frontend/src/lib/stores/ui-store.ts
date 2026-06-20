import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

/**
 * Global UI/chrome state. Persisted slices (sidebar collapse) survive reloads.
 * Command palette + mobile nav are ephemeral. No server data lives here.
 */
interface UiState {
  sidebarCollapsed: boolean;
  mobileNavOpen: boolean;
  commandOpen: boolean;

  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setMobileNavOpen: (open: boolean) => void;
  setCommandOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()(
  devtools(
    persist(
      (set) => ({
        sidebarCollapsed: false,
        mobileNavOpen: false,
        commandOpen: false,

        toggleSidebar: () =>
          set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
        setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
        setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),
        setCommandOpen: (commandOpen) => set({ commandOpen }),
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
