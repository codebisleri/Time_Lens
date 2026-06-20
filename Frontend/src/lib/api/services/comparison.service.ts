import { http } from "../client";
import { endpoints } from "../endpoints";
import type { ComparisonRequest, ComparisonResult } from "@/types/comparison";

export const comparisonService = {
  compare(payload: ComparisonRequest): Promise<ComparisonResult> {
    return http.post<ComparisonResult>(endpoints.comparison.compare(), payload);
  },
};
