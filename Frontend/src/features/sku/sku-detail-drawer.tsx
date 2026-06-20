"use client";

import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/feedback/error-state";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils/format";
import { SKU_STATUS_VARIANT, type SkuRow } from "./derive";
import { formatAccuracy } from "./sku-columns";
import { useSkuDetail } from "./hooks/use-sku-detail";

const CONTENT_CLASS =
  "w-full p-0 sm:max-w-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right data-[state=open]:fade-in data-[state=closed]:fade-out duration-200";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right text-sm font-medium text-foreground">
        {value}
      </dd>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <dl className="divide-y divide-border/60">{children}</dl>
    </div>
  );
}

function DetailBody({ sku }: { sku: SkuRow }) {
  return (
    <div className="space-y-6">
      <Section title="General Information">
        <Field
          label="SKU Code"
          value={<span className="font-mono text-xs">{sku.code}</span>}
        />
        <Field label="Product Name" value={sku.name} />
        <Field label="Category" value={sku.category} />
        <Field
          label="Status"
          value={
            <Badge
              variant={SKU_STATUS_VARIANT[sku.status]}
              className="capitalize"
            >
              {sku.status}
            </Badge>
          }
        />
        <Field
          label="Price"
          value={
            sku.unitPrice != null ? formatCurrency(sku.unitPrice) : "—"
          }
        />
      </Section>

      <Section title="Forecast Information">
        <Field
          label="Forecast Method"
          value={
            sku.forecastModel ? (
              <Badge variant="secondary">{sku.forecastMethodLabel}</Badge>
            ) : (
              "—"
            )
          }
        />
        <Field label="Accuracy" value={formatAccuracy(sku.forecastAccuracy)} />
        <Field
          label="Last Forecast Date"
          value={
            sku.lastForecastDate ? formatDate(sku.lastForecastDate) : "—"
          }
        />
      </Section>

      <Section title="Metadata">
        <Field label="Created Date" value={formatDate(sku.updatedAt)} />
        <Field label="Updated Date" value={formatDateTime(sku.updatedAt)} />
      </Section>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6">
      {Array.from({ length: 3 }).map((_, s) => (
        <div key={s} className="space-y-3">
          <Skeleton className="h-3 w-32" />
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, r) => (
              <div key={r} className="flex items-center justify-between">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Read-only SKU detail drawer. Opens over the catalog (no navigation) and
 * fetches the SKU fresh by id so its loading skeleton is genuinely exercised.
 * Drawer open/close is owned by the parent view (local feature state).
 */
export function SkuDetailDrawer({
  skuId,
  fallbackName,
  open,
  onOpenChange,
}: {
  skuId: string | null;
  fallbackName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const detail = useSkuDetail(skuId);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className={CONTENT_CLASS}>
        <div className="flex h-full flex-col">
          <SheetHeader className="flex-row items-start justify-between border-b border-border p-5">
            <div className="space-y-1">
              <SheetTitle>{detail.data?.name ?? fallbackName ?? "SKU detail"}</SheetTitle>
              <SheetDescription>
                {detail.data?.code ?? "Read-only SKU overview"}
              </SheetDescription>
            </div>
            <SheetClose
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors",
                "hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
              aria-label="Close"
            >
              <X className="size-4" />
            </SheetClose>
          </SheetHeader>

          <ScrollArea className="flex-1">
            <div className="p-5">
              {detail.isLoading ? (
                <DetailSkeleton />
              ) : detail.isError ? (
                <ErrorState
                  title="Couldn’t load SKU"
                  message={detail.error?.message}
                  onRetry={() => void detail.refetch().catch(() => {})}
                />
              ) : detail.data ? (
                <DetailBody sku={detail.data} />
              ) : null}
            </div>
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  );
}
