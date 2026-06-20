import { z } from "zod";

/** Forecast/global settings form on the Data & Settings page. */
export const forecastSettingsSchema = z.object({
  defaultHorizon: z.enum(["weekly", "monthly", "quarterly"]),
  defaultModel: z.string().min(1),
  confidenceLevel: z.number().min(0.5).max(0.99),
  aggregation: z.enum(["sum", "average"]),
  outlierHandling: z.enum(["none", "clip", "remove"]),
  currency: z.string().length(3),
  fiscalYearStartMonth: z.number().int().min(1).max(12),
});

export type ForecastSettingsValues = z.infer<typeof forecastSettingsSchema>;
