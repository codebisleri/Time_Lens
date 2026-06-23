import { useEdaStore } from "@/lib/stores/eda-store";
import { useFilterStore } from "@/lib/stores/filter-store";
import { useSkuStore } from "@/lib/stores/sku-store";
import { useUploadStore } from "@/lib/stores/upload-store";
import { useScenarioStore } from "@/lib/stores/scenario-store";
import { useComparisonStore } from "@/lib/stores/comparison-store";
import { workspaceService } from "@/lib/api/services/workspace.service";

/**
 * §1 — clear all CACHED frontend session state so the app opens clean after a
 * sign-in: no stale EDA results, selections, filters, or in-flight forecast-job
 * handle are auto-restored. Backend datasets (per-user, server-side) are NOT
 * touched — they load only when the user navigates to a module that fetches them.
 *
 * Chrome/theme preferences (ui-store) are intentionally preserved.
 */
const ACTIVE_FORECAST_JOB_KEY = "tl_active_forecast_job";

// Persisted store keys to purge so a hard reload after a reset is also clean.
// Includes the newer planning/preference stores (Phase Y.0) so a workspace reset
// leaves no stale SKU/segment/brand/model selections referencing purged datasets.
const PERSISTED_KEYS = [
  "tl-eda-state",
  "tl-filters",
  "tl-sku-view",
  "scenario-planning", // scenario-planning-store (what-if + causal selections)
  "explainability-filters", // explainability-filter-store (brand/segment filters)
  "forecast-prefs", // forecast-store (segment overrides / secondary models / benchmarks)
  "forecast-filters", // forecast-filters-store
  "forecast-level", // forecast-level-store (terminology, dataset-derived)
  ACTIVE_FORECAST_JOB_KEY,
];

/** Reset every forecasting-workspace Zustand store (NOT ui-store/auth). */
function resetWorkspaceStores(): void {
  try {
    useEdaStore.getState().reset();
    useFilterStore.getState().reset();
    useSkuStore.getState().reset();
    useUploadStore.getState().reset();
    useScenarioStore.getState().reset();
    useComparisonStore.getState().clear();
  } catch {
    /* stores may be mid-hydration — ignore */
  }
}

export function resetCachedSessionState(): void {
  resetWorkspaceStores();
  try {
    window.localStorage.removeItem(ACTIVE_FORECAST_JOB_KEY);
  } catch {
    /* storage unavailable — ignore */
  }
}

/**
 * F.18 — COMPLETE workspace reset (NOT logout/refresh/upload-reset). Erases the
 * entire forecasting session both server-side (this user's datasets + all
 * dependent forecast/submission/report/scenario state + workflow) and client-side
 * (every workspace store + persisted localStorage). Theme/sidebar prefs and the
 * authenticated session are preserved. Throws if the server purge fails.
 */
export async function resetWorkspace(): Promise<void> {
  // 1. Server-side purge first — so a re-fetch on /data returns nothing.
  await workspaceService.reset();
  // 2. Client stores.
  resetWorkspaceStores();
  // 3. Persisted localStorage (clean even across a hard reload).
  for (const k of PERSISTED_KEYS) {
    try {
      window.localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
}
