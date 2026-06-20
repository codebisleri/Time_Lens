import type { Metadata } from "next";
import { PerformanceView } from "@/features/performance/performance-view";

export const metadata: Metadata = { title: "Performance Analytics" };

export default function PerformancePage() {
  return <PerformanceView />;
}
