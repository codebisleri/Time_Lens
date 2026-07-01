import { http } from "../client";
import { endpoints } from "../endpoints";
import type {
  SegmentationResult,
  SegmentationRun,
  SegmentationRunPayload,
  SegmentationSource,
  SegmentationThresholds,
  SegmentTrace,
} from "@/types/segmentation";

/** Drop undefined/null keys so they don't become "undefined" query strings. */
function compact(obj?: object): Record<string, unknown> {
  if (!obj) return {};
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null),
  );
}

/** Profile & Route — retail segmentation (volatility × contribution). */
export const segmentationService = {
  /** Current/preview segmentation; optional threshold knobs recompute the matrix.
   *  `source` selects uploaded vs generated (omit ⇒ the ACTIVE source). */
  get(
    params?: { datasetId?: string; source?: SegmentationSource | "active" } & SegmentationThresholds,
  ): Promise<SegmentationResult> {
    return http.get<SegmentationResult>(endpoints.segmentation.get(), compact(params));
  },

  /** Validate & Save: recompute with thresholds, persist an audit run (validator + notes). */
  run(payload?: SegmentationRunPayload): Promise<SegmentationResult> {
    return http.post<SegmentationResult>(endpoints.segmentation.run(), payload ?? {});
  },

  runs(limit = 10): Promise<SegmentationRun[]> {
    return http.get<SegmentationRun[]>(endpoints.segmentation.runs(), { limit });
  },

  trace(
    sku: string,
    params?: { datasetId?: string } & SegmentationThresholds,
  ): Promise<SegmentTrace> {
    return http.get<SegmentTrace>(endpoints.segmentation.trace(), {
      sku,
      ...compact(params),
    });
  },
};
