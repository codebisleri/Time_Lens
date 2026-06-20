"use client";

import { useAsync } from "@/lib/hooks";
import { segmentationService } from "@/lib/api/services";
import type {
  SegmentationResult,
  SegmentationRun,
  SegmentationThresholds,
} from "@/types/segmentation";

/** Current segmentation for the active dataset; re-fetches when thresholds change. */
export function useSegmentation(thresholds?: SegmentationThresholds) {
  return useAsync<SegmentationResult>(
    () => segmentationService.get(thresholds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(thresholds ?? {})],
  );
}

/** Audit trail of persisted segmentation runs. */
export function useSegmentationRuns() {
  return useAsync<SegmentationRun[]>(() => segmentationService.runs(10), []);
}
