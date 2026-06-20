import type { Metadata } from "next";
import { ForecastReviewView } from "@/features/forecast-review/review-view";

export const metadata: Metadata = { title: "Forecast Review" };

export default function ForecastReviewPage() {
  return <ForecastReviewView />;
}
