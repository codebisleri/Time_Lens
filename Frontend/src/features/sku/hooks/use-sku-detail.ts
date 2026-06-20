"use client";

import { useAsync } from "@/lib/hooks";
import { skuService } from "@/lib/api/services";
import { toSkuRow, type SkuRow } from "../derive";

/**
 * Loads a single SKU's detail for the drawer. Fetches fresh via
 * skuService.getById (exercising the real loading state / skeleton) and enriches
 * it with the derived presentation fields. Returns null when no SKU is open.
 */
export function useSkuDetail(skuId: string | null) {
  return useAsync<SkuRow | null>(async () => {
    if (!skuId) return null;
    const sku = await skuService.getById(skuId);
    return toSkuRow(sku);
  }, [skuId]);
}
