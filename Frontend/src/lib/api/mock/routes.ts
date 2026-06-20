import type { RequestSpec } from "../client";
import type { Paginated, ListParams } from "@/types/api";
import type { ComparisonResult } from "@/types/comparison";
import { ApiError } from "../error";

import { mockSkus } from "./fixtures/skus";
import { mockForecasts, mockForecastSummaries } from "./fixtures/forecasts";
import { mockScenarios, mockScenarioSummaries } from "./fixtures/scenarios";
import { mockReports } from "./fixtures/reports";
import { mockDatasets, mockSettings } from "./fixtures/datasets";
import { mockDashboard } from "./fixtures/dashboard";

type PathParams = Record<string, string>;
type Handler = (spec: RequestSpec, params: PathParams) => unknown;

interface MockRoute {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

/** Build a regex with named groups from a path template like "/skus/:id". */
function route(method: string, template: string, handler: Handler): MockRoute {
  const pattern = new RegExp(
    "^" +
      template.replace(/:[A-Za-z]+/g, (m) => `(?<${m.slice(1)}>[^/]+)`) +
      "$",
  );
  return { method, pattern, handler };
}

/** Type-safe comparison for arbitrary fixture field values. */
function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/** Generic in-memory pagination + search over a fixture array. */
function paginate<T>(
  items: T[],
  params: ListParams = {},
  searchFields: (keyof T)[] = [],
): Paginated<T> {
  let rows = [...items];
  const { search, page = 1, pageSize = 20, sortBy, sortDir = "asc" } = params;

  if (search && searchFields.length) {
    const q = String(search).toLowerCase();
    rows = rows.filter((row) =>
      searchFields.some((f) => String(row[f] ?? "").toLowerCase().includes(q)),
    );
  }
  if (sortBy) {
    const sortKey = sortBy as keyof T;
    rows.sort((a, b) => {
      const cmp = compareValues(a[sortKey], b[sortKey]);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }

  const total = rows.length;
  const start = (page - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);
  return {
    items: slice,
    total,
    page,
    pageSize,
    hasNextPage: start + pageSize < total,
  };
}

function buildComparison(scenarioIds: string[], baseId: string): ComparisonResult {
  const selected = mockScenarios.filter((s) => scenarioIds.includes(s.id));
  // Synthesize 13 weekly comparison points from each scenario's delta.
  const series = Array.from({ length: 13 }, (_, i) => {
    const date = new Date(2026, 5, 1);
    date.setDate(date.getDate() + i * 7);
    const values: Record<string, number> = {};
    for (const s of selected) {
      const delta = s.summary?.unitsDeltaPct ?? 0;
      values[s.id] = Math.round((1000 + i * 40) * (1 + delta));
    }
    return { date: date.toISOString(), values };
  });

  const deltas = selected.map((s) => ({
    scenarioId: s.id,
    scenarioName: s.name,
    totalUnits: s.summary?.totalProjectedUnits ?? 0,
    totalRevenue: s.summary?.totalProjectedRevenue,
    unitsDeltaPct: s.summary?.unitsDeltaPct ?? 0,
    revenueDeltaPct: s.summary?.revenueDeltaPct,
    isBaseline: s.id === baseId,
  }));

  return {
    baselineScenarioId: baseId,
    scenarioIds,
    series,
    deltas,
    generatedAt: "2026-06-16T08:00:00.000Z",
  };
}

function notFound(entity: string): never {
  throw new ApiError({ status: 404, code: "NOT_FOUND", message: `${entity} not found` });
}

export const mockRoutes: MockRoute[] = [
  // Auth is served exclusively by the live backend (real bcrypt/HMAC); there is
  // no mock auth route, mock user, or demo credential in this codebase.

  // ── Dashboard ─────────────────────────────────────────────────────────────
  route("GET", "/dashboard/summary", () => mockDashboard),

  // ── Data & Settings ───────────────────────────────────────────────────────
  route("GET", "/datasets", () => mockDatasets),
  route("GET", "/settings/forecast", () => mockSettings),
  route("PUT", "/settings/forecast", (spec) => ({
    ...mockSettings,
    ...(spec.data as object),
  })),

  // ── SKUs ──────────────────────────────────────────────────────────────────
  route("GET", "/skus", (spec) =>
    paginate(mockSkus, spec.params as ListParams, ["code", "name", "category"]),
  ),
  route("GET", "/skus/:id", (_spec, { id }) =>
    mockSkus.find((s) => s.id === id) ?? notFound("SKU"),
  ),

  // ── Forecasts ─────────────────────────────────────────────────────────────
  route("GET", "/forecasts", (spec) =>
    paginate(mockForecastSummaries, spec.params as ListParams, [
      "skuCode",
      "skuName",
    ]),
  ),
  route("GET", "/forecasts/:id", (_spec, { id }) =>
    mockForecasts.find((f) => f.id === id) ?? notFound("Forecast"),
  ),
  route("POST", "/forecasts/run", (spec) => ({
    id: "job_001",
    status: "queued",
    progress: 0,
    skuIds: (spec.data as { skuIds?: string[] })?.skuIds ?? [],
    startedAt: "2026-06-16T08:00:00.000Z",
  })),

  // ── Scenarios ─────────────────────────────────────────────────────────────
  route("GET", "/scenarios", () => mockScenarioSummaries),
  route("GET", "/scenarios/:id", (_spec, { id }) =>
    mockScenarios.find((s) => s.id === id) ?? notFound("Scenario"),
  ),
  route("POST", "/scenarios", (spec) => {
    const body = spec.data as { name?: string };
    return {
      ...mockScenarios[0],
      id: "scn_new",
      name: body?.name ?? "Untitled Scenario",
    };
  }),

  // ── Comparison ────────────────────────────────────────────────────────────
  route("POST", "/scenarios/compare", (spec) => {
    const body = spec.data as { scenarioIds?: string[]; baselineScenarioId?: string };
    const ids = body?.scenarioIds ?? mockScenarios.map((s) => s.id);
    return buildComparison(ids, body?.baselineScenarioId ?? ids[0]!);
  }),

  // ── Reports ───────────────────────────────────────────────────────────────
  route("GET", "/reports", () => mockReports),
  route("GET", "/reports/:id", (_spec, { id }) =>
    mockReports.find((r) => r.id === id) ?? notFound("Report"),
  ),
  route("POST", "/reports", (spec) => ({
    id: "rpt_new",
    status: "generating",
    createdAt: "2026-06-16T08:00:00.000Z",
    ...(spec.data as object),
  })),
];
