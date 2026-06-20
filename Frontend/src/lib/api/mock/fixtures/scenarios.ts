import type { Scenario, ScenarioSummary } from "@/types/scenario";
import { mockForecasts } from "./forecasts";

export const mockScenarios: Scenario[] = [
  {
    id: "scn_001",
    name: "Summer Promotion +15%",
    description: "Modeling a 15% demand uplift from a 4-week summer promotion.",
    status: "active",
    horizon: "weekly",
    baselineForecastId: mockForecasts[0]?.id,
    levers: [
      {
        id: "lvr_001",
        type: "promotion",
        label: "Summer promo uplift",
        value: 0.15,
        unit: "percent",
      },
    ],
    summary: {
      totalProjectedUnits: 18420,
      totalProjectedRevenue: 92100,
      unitsDeltaPct: 0.15,
      revenueDeltaPct: 0.11,
    },
    createdBy: "Avery Chen",
    createdAt: "2026-05-20T10:00:00.000Z",
    updatedAt: "2026-06-08T14:30:00.000Z",
  },
  {
    id: "scn_002",
    name: "Price Increase 5%",
    description: "Evaluate elasticity impact of a 5% list price increase.",
    status: "draft",
    horizon: "weekly",
    levers: [
      {
        id: "lvr_002",
        type: "price_change",
        label: "List price +5%",
        value: 0.05,
        unit: "percent",
      },
      {
        id: "lvr_003",
        type: "demand_uplift",
        label: "Elasticity drag",
        value: -0.03,
        unit: "percent",
      },
    ],
    summary: {
      totalProjectedUnits: 15510,
      totalProjectedRevenue: 96200,
      unitsDeltaPct: -0.03,
      revenueDeltaPct: 0.02,
    },
    createdBy: "Avery Chen",
    createdAt: "2026-06-01T09:00:00.000Z",
    updatedAt: "2026-06-11T11:15:00.000Z",
  },
  {
    id: "scn_003",
    name: "Supply Constraint",
    description: "30% supply cap on top categories for Q3.",
    status: "draft",
    horizon: "monthly",
    levers: [
      {
        id: "lvr_004",
        type: "supply_constraint",
        label: "Q3 supply cap",
        value: -0.3,
        unit: "percent",
      },
    ],
    summary: {
      totalProjectedUnits: 11200,
      unitsDeltaPct: -0.3,
    },
    createdBy: "Jordan Patel",
    createdAt: "2026-06-05T16:00:00.000Z",
    updatedAt: "2026-06-12T09:45:00.000Z",
  },
];

export const mockScenarioSummaries: ScenarioSummary[] = mockScenarios.map(
  (s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    horizon: s.horizon,
    leverCount: s.levers.length,
    unitsDeltaPct: s.summary?.unitsDeltaPct,
    updatedAt: s.updatedAt,
  }),
);
