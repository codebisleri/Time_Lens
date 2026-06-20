import type { Metadata } from "next";
import { SkuManagementView } from "@/features/sku/sku-management-view";

export const metadata: Metadata = { title: "SKU Management" };

export default function SkusPage() {
  return <SkuManagementView />;
}
