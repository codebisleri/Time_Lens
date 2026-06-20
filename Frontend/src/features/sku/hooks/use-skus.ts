"use client";

import { useAsync } from "@/lib/hooks";
import { skuService } from "@/lib/api/services";

/**
 * Loads the SKU catalog. Fetches a large page so the whole master catalog is
 * resolved client-side — searching, filtering, sorting, and pagination all run
 * in the table against this set (the mock layer holds 48 SKUs). When the
 * backend scales, lift these to server params on skuService.list().
 */
export function useSkus() {
  return useAsync(() => skuService.list({ page: 1, pageSize: 500 }), []);
}
