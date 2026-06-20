import type { ForecastPoint } from "@/types/forecast";

/** Deterministic-ish series generator for mock forecasts. Produces historical
 *  actuals followed by forecast points with a confidence band. */
export function makeSeries(opts: {
  history: number;
  horizon: number;
  base: number;
  trend?: number;
  seasonalAmplitude?: number;
  startDate?: Date;
}): ForecastPoint[] {
  const {
    history,
    horizon,
    base,
    trend = 0.5,
    seasonalAmplitude = 0.15,
    startDate = new Date(2025, 0, 1),
  } = opts;

  const points: ForecastPoint[] = [];
  const total = history + horizon;

  for (let i = 0; i < total; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i * 7); // weekly cadence
    const seasonal =
      1 + seasonalAmplitude * Math.sin((i / 13) * Math.PI * 2);
    const value = (base + trend * i) * seasonal;

    if (i < history) {
      // Actuals carry a little noise around the model line.
      const noise = 1 + (((i * 37) % 11) - 5) / 100;
      points.push({ date: date.toISOString(), actual: Math.round(value * noise) });
    } else {
      const spread = value * 0.12;
      points.push({
        date: date.toISOString(),
        forecast: Math.round(value),
        lowerBound: Math.round(value - spread),
        upperBound: Math.round(value + spread),
      });
    }
  }
  return points;
}
