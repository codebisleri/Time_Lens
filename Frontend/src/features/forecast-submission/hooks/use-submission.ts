"use client";

import { useCallback, useMemo, useState } from "react";
import { useAsync } from "@/lib/hooks";
import { submissionService } from "@/lib/api/services";
import {
  EMPTY_SUBMISSION_FILTERS,
  type SubmissionBulk,
  type SubmissionEdit,
  type SubmissionFilterParams,
  type SubmissionFilterState,
} from "@/types/submission";

/** Map the multi-select UI state to the backend's comma-separated query params. */
export function filtersToParams(
  f: SubmissionFilterState,
): SubmissionFilterParams {
  const p: SubmissionFilterParams = {};
  if (f.category.length) p.category = f.category.join(",");
  if (f.brand.length) p.brand = f.brand.join(",");
  if (f.product.length) p.product = f.product.join(",");
  if (f.segment.length) p.segment = f.segment.join(",");
  if (f.sku.length) p.sku = f.sku.join(",");
  if (f.overriddenOnly) p.overriddenOnly = true;
  if (f.wmapeThreshold > 0) p.wmapeThreshold = f.wmapeThreshold;
  return p;
}

/**
 * Owns all Forecast Submission data + mutations. A single `tick` invalidates the
 * filtered worksheet, the unfiltered whole-plan snapshot (for the submit audit
 * summary), and the audit trail — so every edit/bulk/submit reconciles against
 * the backend's recomputed derived columns rather than guessing locally.
 */
export function useSubmission() {
  const [filters, setFilters] = useState<SubmissionFilterState>(
    EMPTY_SUBMISSION_FILTERS,
  );
  const [tick, setTick] = useState(0);
  const [isMutating, setIsMutating] = useState(false);

  const filterKey = JSON.stringify(filters);
  const params = useMemo(() => filtersToParams(filters), [filterKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Filtered worksheet (the editable grid + scoped KPIs).
  const query = useAsync(
    () => submissionService.get(params),
    [filterKey, tick],
  );
  // Whole-plan snapshot — drives the pre-submit audit summary (always unfiltered,
  // mirroring Streamlit's submit section which summarizes the full frame).
  const plan = useAsync(() => submissionService.get({}), [tick]);
  const audit = useAsync(() => submissionService.audit(), [tick]);

  const bump = useCallback(() => setTick((t) => t + 1), []);

  const run = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T> => {
      setIsMutating(true);
      try {
        const r = await fn();
        bump();
        return r;
      } finally {
        setIsMutating(false);
      }
    },
    [bump],
  );

  const applyEdits = useCallback(
    (edits: SubmissionEdit[]) =>
      run(() => submissionService.patch({ edits })),
    [run],
  );

  const applyBulk = useCallback(
    (bulk: SubmissionBulk) =>
      run(() => submissionService.patch({ bulk, filter: filtersToParams(filters) })),
    [run, filters],
  );

  const submit = useCallback(
    (submitter: string, notes: string) =>
      run(() => submissionService.submit({ submitter, notes })),
    [run],
  );

  return {
    filters,
    setFilters,
    query,
    plan,
    audit,
    isMutating,
    applyEdits,
    applyBulk,
    submit,
  };
}
