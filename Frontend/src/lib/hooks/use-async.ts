"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AsyncState } from "@/types/api";
import { normalizeError } from "@/lib/api/error";

/**
 * Minimal data-fetching hook for the current (no-TanStack-Query) phase.
 *
 * Returns the same {data, status, error} surface that maps 1:1 onto
 * useQuery({queryFn})'s {data, isLoading, error}. When TanStack Query is later
 * adopted, swap call sites from useAsync(fn) to useQuery(key, fn) without
 * touching the service layer or the consuming component's render logic.
 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[] = [],
  options: { immediate?: boolean } = { immediate: true },
) {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    status: "idle",
    error: null,
  });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const execute = useCallback(async () => {
    setState((s) => ({ ...s, status: "loading", error: null }));
    try {
      const data = await fn();
      if (mounted.current) setState({ data, status: "success", error: null });
      return data;
    } catch (err) {
      const error = normalizeError(err);
      if (mounted.current) setState({ data: null, status: "error", error });
      throw error;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (options.immediate) void execute().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {
    ...state,
    isLoading: state.status === "loading",
    isSuccess: state.status === "success",
    isError: state.status === "error",
    refetch: execute,
  };
}
