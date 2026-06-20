import type { Metadata } from "next";
import { PagePlaceholder } from "@/components/common/page-placeholder";

export const metadata: Metadata = { title: "New Scenario" };

export default function NewScenarioPage() {
  return (
    <PagePlaceholder
      title="New Scenario"
      description="Scenario builder — pick a baseline and configure assumption levers."
    />
  );
}
