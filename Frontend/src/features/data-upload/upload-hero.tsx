import { Clock, Database, FileStack, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, formatNumber } from "@/lib/utils/format";
import type { Dataset } from "@/types/dataset";

const CARD =
  "flex items-start gap-4 p-5 transition-colors hover:border-border";
const ICON =
  "flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary/60 text-muted-foreground";

/**
 * Upload hero: total files, last upload, and a processing-status summary.
 * Pure presentation — stats derived from the datasets list.
 */
export function UploadHero({ datasets }: { datasets: Dataset[] }) {
  const total = datasets.length;
  const lastUpload = datasets
    .map((d) => d.uploadedAt)
    .sort((a, b) => b.localeCompare(a))[0];

  const ready = datasets.filter((d) => d.status === "ready").length;
  const inProgress = datasets.filter((d) =>
    ["uploading", "processing", "validating"].includes(d.status),
  ).length;
  const failed = datasets.filter((d) => d.status === "failed").length;

  return (
    <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Card className={CARD}>
        <span className={ICON}>
          <FileStack className="size-5" />
        </span>
        <div className="space-y-0.5">
          <p className="text-sm text-muted-foreground">Total uploaded files</p>
          <p className="text-2xl font-semibold tracking-tight">
            {formatNumber(total)}
          </p>
        </div>
      </Card>

      <Card className={CARD}>
        <span className={ICON}>
          <Clock className="size-5" />
        </span>
        <div className="space-y-0.5">
          <p className="text-sm text-muted-foreground">Last upload</p>
          <p className="text-2xl font-semibold tracking-tight">
            {lastUpload ? formatDate(lastUpload) : "—"}
          </p>
        </div>
      </Card>

      <Card className={CARD}>
        <span className={ICON}>
          <Database className="size-5" />
        </span>
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Processing status</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-success" />
              {ready} ready
            </span>
            <span className="flex items-center gap-1.5">
              {inProgress > 0 ? (
                <Loader2 className="size-3 animate-spin text-warning" />
              ) : (
                <span className="size-2 rounded-full bg-warning" />
              )}
              {inProgress} in progress
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-destructive" />
              {failed} failed
            </span>
          </div>
        </div>
      </Card>
    </section>
  );
}

export function UploadHeroSkeleton() {
  return (
    <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i} className="flex items-start gap-4 p-5">
          <Skeleton className="size-10 rounded-lg" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-7 w-20" />
          </div>
        </Card>
      ))}
    </section>
  );
}
