"use client";

import { useAsync } from "@/lib/hooks";
import { dataService } from "@/lib/api/services";

/** Loads uploaded datasets for the hero stats and upload history table. */
export function useDatasets() {
  return useAsync(() => dataService.listDatasets(), []);
}
