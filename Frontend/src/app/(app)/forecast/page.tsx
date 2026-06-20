import type { Metadata } from "next";
import { ForecastView } from "@/features/forecast-run/forecast-view";

export const metadata: Metadata = { title: "Forecast" };

export default function ForecastPage() {
  return <ForecastView />;
}
