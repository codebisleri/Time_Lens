"use client";

import { ErrorState } from "@/components/feedback/error-state";

/** Root error boundary. Route-level error.tsx files override this per section. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <ErrorState
        title="Unexpected error"
        message={error.message}
        onRetry={reset}
        className="max-w-md"
      />
    </div>
  );
}
