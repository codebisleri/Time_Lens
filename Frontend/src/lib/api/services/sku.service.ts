import { http } from "../client";
import { endpoints } from "../endpoints";
import type { Paginated } from "@/types/api";
import type {
  Sku,
  SkuListParams,
  SkuUpdatePayload,
  SkuBulkActionPayload,
} from "@/types/sku";

export const skuService = {
  list(params?: SkuListParams): Promise<Paginated<Sku>> {
    return http.get<Paginated<Sku>>(endpoints.skus.list(), params);
  },

  getById(id: string): Promise<Sku> {
    return http.get<Sku>(endpoints.skus.detail(id));
  },

  update(id: string, payload: SkuUpdatePayload): Promise<Sku> {
    return http.patch<Sku>(endpoints.skus.detail(id), payload);
  },

  bulkAction(payload: SkuBulkActionPayload): Promise<{ affected: number }> {
    return http.post<{ affected: number }>(endpoints.skus.bulk(), payload);
  },
};
