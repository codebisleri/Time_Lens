"use client";

import { useCallback, useState } from "react";
import { normalizeError, type ApiError } from "@/lib/api/error";

/**
 * Imperative async action hook (create/update/delete). Mirrors TanStack Query's
 * useMutation shape ({mutate, isPending, error}) so adoption later is additive.
 */
export function useMutation<TArgs, TResult>(
  fn: (args: TArgs) => Promise<TResult>,
  callbacks: {
    onSuccess?: (result: TResult, args: TArgs) => void;
    onError?: (error: ApiError, args: TArgs) => void;
  } = {},
) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const mutate = useCallback(
    async (args: TArgs) => {
      setIsPending(true);
      setError(null);
      try {
        const result = await fn(args);
        callbacks.onSuccess?.(result, args);
        return result;
      } catch (err) {
        const apiError = normalizeError(err);
        setError(apiError);
        callbacks.onError?.(apiError, args);
        throw apiError;
      } finally {
        setIsPending(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fn],
  );

  return { mutate, isPending, error };
}
