import type { Metadata } from "next";
import { ForecastConfigView } from "@/features/forecast-config/forecast-config-view";

export const metadata: Metadata = { title: "Forecast Configuration" };

export default function ForecastConfigurePage() {
  return <ForecastConfigView />;
}
