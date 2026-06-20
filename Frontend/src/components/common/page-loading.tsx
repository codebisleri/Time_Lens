import { Skeleton } from "@/components/ui/skeleton";

/** Generic route-level loading skeleton used by loading.tsx files. */
export function PageLoading() {
  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-6 px-6 py-6">
      <div className="space-y-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
      <Skeleton className="h-80 w-full" />
    </div>
  );
}
