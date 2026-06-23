import type { Metadata } from "next";
import { ExplainabilityView } from "@/features/explainability/explainability-view";

export const metadata: Metadata = { title: "Forecast Explainability" };

export default function ExplainabilityPage() {
  return <ExplainabilityView />;
}
