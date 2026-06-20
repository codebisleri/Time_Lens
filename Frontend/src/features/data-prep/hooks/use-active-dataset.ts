"use client";

import { useAsync } from "@/lib/hooks";
import { dataService, skuService } from "@/lib/api/services";
import type { Dataset } from "@/types/dataset";

/**
 * Resolves the dataset to prepare: the most recently uploaded one (the live
 * bridge returns datasets newest-first). Returns null when none exist.
 */
export function useActiveDataset() {
  return useAsync<Dataset | null>(async () => {
    const datasets = await dataService.listDatasets();
    return datasets[0] ?? null;
  }, []);
}

/** Distinct category labels for the active dataset (from the profiled SKUs). */
export function useDatasetCategories() {
  return useAsync<string[]>(async () => {
    const res = await skuService.list({ page: 1, pageSize: 500 });
    return Array.from(new Set(res.items.map((s) => s.category))).sort();
  }, []);
}
