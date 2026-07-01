"use client";

import { useAsync } from "@/lib/hooks";
import { segmentationService } from "@/lib/api/services";
import type {
  SegmentationResult,
  SegmentationSource,
  SegmentationThresholds,
  SegmentationRun,
} from "@/types/segmentation";

/**
 * Segmentation for the active dataset; re-fetches when thresholds OR the selected
 * source change. Omit `source` to fetch the ACTIVE segmentation (what downstream
 * modules consume); pass "uploaded"/"generated" to render a specific source.
 */
export function useSegmentation(
  thresholds?: SegmentationThresholds,
  source?: SegmentationSource,
) {
  return useAsync<SegmentationResult>(
    () => segmentationService.get({ ...thresholds, source }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(thresholds ?? {}), source ?? ""],
  );
}

/** Audit trail of persisted segmentation runs. */
export function useSegmentationRuns() {
  return useAsync<SegmentationRun[]>(() => segmentationService.runs(10), []);
}
