"use client";

import { ErrorState } from "@/components/feedback/error-state";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <div className="p-6">
      <ErrorState
        title="Couldn’t load the dashboard"
        message={error.message}
        onRetry={reset}
      />
    </div>
  );
}
