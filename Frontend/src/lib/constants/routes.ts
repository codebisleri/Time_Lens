/**
 * Single registry of application routes. Use these helpers everywhere instead
 * of hardcoding path strings — keeps navigation, middleware, and breadcrumbs
 * consistent when paths change.
 */
export const routes = {
  // Auth
  login: "/login",

  // App
  overview: "/overview",
  userManual: "/user-manual",
  dashboard: "/dashboard",
  data: "/data",
  dataPrepare: "/data/prepare",
  eda: "/eda",
  skus: "/skus",
  sku: (skuId: string) => `/skus/${skuId}`,
  profile: "/profile",
  // Canonical Streamlit-parity modules (8-stage workflow).
  forecast: "/forecast",
  forecastSubmission: "/forecast-submission",
  report: "/report",
  // Legacy routes retained for deep links / breadcrumbs (delinked from sidebar).
  forecasts: "/forecasts",
  forecastDetail: (forecastId: string) => `/forecasts/${forecastId}`,
  forecastConfigure: "/forecasts/configure",
  forecastReview: "/forecasts/review",
  performance: "/performance",
  scenarios: "/scenarios",
  scenarioNew: "/scenarios/new",
  scenario: (scenarioId: string) => `/scenarios/${scenarioId}`,
  scenarioCompare: "/scenarios/compare",
  reports: "/reports",
} as const;

/** Routes reachable without an authenticated session. */
export const PUBLIC_ROUTES = [routes.login] as const;

/** Where to land after a successful login. Single-workflow mode: the journey
 *  starts at Data Upload, not a dashboard. */
export const DEFAULT_AUTHENTICATED_ROUTE = routes.overview;

/** Name of the httpOnly session cookie the backend will eventually set. */
export const SESSION_COOKIE_NAME = "tl_session";

/** Human-readable labels for path segments, used to build breadcrumbs. */
export const ROUTE_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  data: "Data",
  prepare: "Data Preparation",
  eda: "EDA",
  skus: "SKU Management",
  profile: "Profile & Route",
  forecast: "Forecast",
  "forecast-submission": "Forecast Submission",
  report: "Report",
  forecasts: "Forecast Results",
  configure: "Forecast Configuration",
  review: "Forecast Review",
  performance: "Performance",
  scenarios: "Scenarios",
  compare: "Scenario Comparison",
  new: "New Scenario",
  reports: "Reports",
};
