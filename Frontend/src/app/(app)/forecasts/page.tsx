import type { Metadata } from "next";
import { ForecastResultsView } from "@/features/forecast/forecast-results-view";

export const metadata: Metadata = { title: "Forecast Results" };

export default function ForecastsPage() {
  return <ForecastResultsView />;
}
