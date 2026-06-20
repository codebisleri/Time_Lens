"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Download, PackageSearch, Plus, SearchX } from "lucide-react";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { formatCurrency, formatDate } from "@/lib/utils/format";
import { toSkuRow, type SkuRow } from "./derive";
import { useSkus } from "./hooks/use-skus";
import { SkuKpiSection, SkuKpiSectionSkeleton } from "./sku-kpis";
import {
  ALL,
  DEFAULT_SKU_FILTERS,
  SkuFilterBar,
  type SkuFilters,
} from "./sku-filter-bar";
import { SkuTable, SkuTableSkeleton } from "./sku-table";
import { SkuDetailDrawer } from "./sku-detail-drawer";

/** Mock CSV export of the currently filtered catalog (no backend round-trip). */
function exportSkusCsv(rows: SkuRow[]) {
  if (typeof document === "undefined") return;
  const header = [
    "SKU Code",
    "Product Name",
    "Category",
    "Price",
    "Forecast Method",
    "Status",
    "Last Updated",
  ];
  const body = rows.map((r) => [
    r.code,
    r.name,
    r.category,
    r.unitPrice != null ? formatCurrency(r.unitPrice) : "",
    r.forecastMethodLabel,
    r.status,
    formatDate(r.updatedAt),
  ]);
  const csv = [header, ...body]
    .map((cells) => cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");

  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "skus.csv";
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * SKU Management — the enterprise master catalog. Composes KPI header, filter
 * bar, the TanStack-powered catalog table, and a read-only detail drawer. The
 * full catalog is loaded once (mock service); search / category / status
 * filtering, sorting, pagination, column visibility, and selection all run
 * client-side. Each section resolves its own loading / empty / error state.
 */
export function SkuManagementView() {
  const skus = useSkus();
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [filters, setFilters] = useState<SkuFilters>(DEFAULT_SKU_FILTERS);

  // Drawer state is local to the feature — clicking a row never navigates away.
  const [activeSku, setActiveSku] = useState<SkuRow | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (skus.data) setRefreshedAt(new Date().toISOString());
  }, [skus.data]);

  const rows = useMemo<SkuRow[]>(
    () => (skus.data?.items ?? []).map(toSkuRow),
    [skus.data],
  );

  const categories = useMemo(
    () => Array.from(new Set(rows.map((r) => r.category))).sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filters.status !== ALL && r.status !== filters.status) return false;
      if (filters.category !== ALL && r.category !== filters.category)
        return false;
      if (
        q &&
        !`${r.code} ${r.name} ${r.category}`.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [rows, filters]);

  const openSku = useCallback((sku: SkuRow) => {
    setActiveSku(sku);
    setDrawerOpen(true);
  }, []);

  const handleExport = useCallback((toExport: SkuRow[]) => {
    exportSkusCsv(toExport);
    toast.success(`Exported ${toExport.length} SKUs to CSV`);
  }, []);

  // Mock action — SKU creation (forms / inline editing) is future scope.
  const handleAddSku = useCallback(() => {
    toast.info("Add SKU", { description: "SKU creation is coming soon." });
  }, []);

  const isEmptyCatalog = !skus.isLoading && !skus.isError && rows.length === 0;
  const isNoResults = filtered.length === 0 && rows.length > 0;

  return (
    <PageShell
      title="SKU Management"
      description="Master SKU catalog for demand planning — browse, filter, and inspect forecast readiness."
      actions={
        <>
          <Button
            variant="outline"
            onClick={() => handleExport(filtered)}
            disabled={skus.isLoading || rows.length === 0}
          >
            <Download className="size-4" /> Export
          </Button>
          <Button onClick={handleAddSku}>
            <Plus className="size-4" /> Add SKU
          </Button>
        </>
      }
    >
      {/* KPI header */}
      {skus.isLoading ? (
        <SkuKpiSectionSkeleton />
      ) : skus.isError ? null : (
        <SkuKpiSection skus={rows} refreshedAt={refreshedAt} />
      )}

      {/* Catalog */}
      {skus.isError ? (
        <ErrorState
          title="Couldn’t load SKUs"
          message={skus.error?.message}
          onRetry={() => void skus.refetch().catch(() => {})}
        />
      ) : skus.isLoading ? (
        <Card>
          <CardContent className="pt-6">
            <SkuTableSkeleton />
          </CardContent>
        </Card>
      ) : isEmptyCatalog ? (
        <EmptyState
          icon={PackageSearch}
          title="No SKUs yet"
          description="Upload sales history or add a SKU to start building your catalog."
          action={
            <Button onClick={handleAddSku}>
              <Plus className="size-4" /> Add SKU
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <SkuFilterBar
              filters={filters}
              categories={categories}
              onChange={setFilters}
            />

            {isNoResults ? (
              <EmptyState
                icon={SearchX}
                title="No matching SKUs"
                description="No SKUs match your search and filters. Try adjusting them."
                action={
                  <Button
                    variant="outline"
                    onClick={() => setFilters(DEFAULT_SKU_FILTERS)}
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <SkuTable data={filtered} onRowClick={openSku} />
            )}
          </CardContent>
        </Card>
      )}

      <SkuDetailDrawer
        skuId={drawerOpen ? activeSku?.id ?? null : null}
        fallbackName={activeSku?.name}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
      />
    </PageShell>
  );
}
