import type { Metadata } from "next";
import { PagePlaceholder } from "@/components/common/page-placeholder";

export const metadata: Metadata = { title: "Scenario Comparison" };

export default function ScenarioComparePage() {
  return (
    <PagePlaceholder
      title="Scenario Comparison"
      description="Compare scenarios side by side against a pinned baseline."
    />
  );
}
