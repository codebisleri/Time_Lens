import type { Metadata } from "next";
import { PagePlaceholder } from "@/components/common/page-placeholder";

export const metadata: Metadata = { title: "Reports" };

export default function ReportsPage() {
  return (
    <PagePlaceholder
      title="Reports"
      description="Generate, browse, and export forecasting reports."
    />
  );
}
