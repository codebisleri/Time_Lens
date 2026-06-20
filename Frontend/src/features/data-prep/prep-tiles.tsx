import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type TileTone = "neutral" | "success" | "warning" | "destructive";

/** Compact metric tile shared by the Data Preparation sections. */
export function PrepTile({
  icon: Icon,
  label,
  value,
  meta,
  tone = "neutral",
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  meta?: string;
  tone?: TileTone;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon
          className={cn(
            "size-4",
            tone === "success" && "text-success",
            tone === "warning" && "text-warning",
            tone === "destructive" && "text-destructive",
            tone === "neutral" && "text-primary",
          )}
        />
        {label}
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-foreground">
        {value}
      </p>
      {meta ? <p className="mt-1 text-xs text-muted-foreground">{meta}</p> : null}
    </Card>
  );
}

export function PrepTilesSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} className="p-5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-3 h-7 w-20" />
          <Skeleton className="mt-2 h-3 w-24" />
        </Card>
      ))}
    </div>
  );
}
