import type { Metadata } from "next";
import { ScenarioPlanningView } from "@/features/scenarios/scenario-view";

export const metadata: Metadata = { title: "Scenario Planning" };

// Phase F.10 — the live What-If scenario engine (re-fits the single-series model,
// applies exog adjustments, re-forecasts vs baseline) wired to /scenarios/*.
export default function ScenariosPage() {
  return <ScenarioPlanningView />;
}
