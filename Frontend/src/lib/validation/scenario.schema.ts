import { z } from "zod";

export const leverSchema = z.object({
  type: z.enum([
    "price_change",
    "promotion",
    "demand_uplift",
    "seasonality",
    "market_growth",
    "supply_constraint",
  ]),
  label: z.string().min(1, "Label is required"),
  value: z.number(),
  unit: z.enum(["percent", "absolute"]),
  effectiveFrom: z.string().optional(),
  effectiveTo: z.string().optional(),
  appliesTo: z.array(z.string()).optional(),
});

export const createScenarioSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  description: z.string().max(500).optional(),
  horizon: z.enum(["weekly", "monthly", "quarterly"]),
  baselineForecastId: z.string().optional(),
  levers: z.array(leverSchema).min(1, "Add at least one assumption"),
});

export type CreateScenarioFormValues = z.infer<typeof createScenarioSchema>;
export type LeverFormValues = z.infer<typeof leverSchema>;
