import type { Metadata } from "next";
import { OverviewView } from "@/features/overview/overview-view";

export const metadata: Metadata = { title: "Overview" };

// F.9 Part 4 — post-login landing: what Time Lens is, the forecasting workflow,
// the user-manual launcher, and a searchable terminology glossary.
export default function OverviewPage() {
  return <OverviewView />;
}
