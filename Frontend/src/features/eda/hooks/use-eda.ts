"use client";

import { useAsync } from "@/lib/hooks";
import { edaService, skuService } from "@/lib/api/services";
import type { EdaResult } from "@/types/eda";

/**
 * EDA payload for the portfolio aggregate, or a single SKU when `sku` is set.
 *
 * F.19 §1 — `immediate` defaults to FALSE: EDA must NOT auto-run on page load /
 * mount / route change. The EDA page triggers it explicitly via `refetch()` only
 * when the user clicks "Run EDA".
 */
export function useEda(sku: string | null, immediate = false) {
  return useAsync<EdaResult>(
    () => edaService.get(sku ? { sku } : undefined),
    [sku],
    { immediate },
  );
}

/** SKU codes for the single-series drill-down selector. */
export function useEdaSkuList() {
  return useAsync<string[]>(async () => {
    const res = await skuService.list({ page: 1, pageSize: 500 });
    return res.items.map((s) => s.code);
  }, []);
}
