/**
 * Central registry of API paths. Services reference these builders instead of
 * inlining strings, so the backend's eventual URL scheme changes in one place.
 * Paths are relative to env.apiBaseUrl.
 */
export const endpoints = {
  auth: {
    register: () => "/auth/register",
    login: () => "/auth/login",
    logout: () => "/auth/logout",
    me: () => "/auth/me",
  },
  dashboard: {
    summary: () => "/dashboard/summary",
  },
  data: {
    datasets: () => "/datasets",
    upload: () => "/datasets/upload",
    dataset: (id: string) => `/datasets/${id}`,
    levelAttributes: (id: string) => `/datasets/${id}/level-attributes`,
    config: (id: string) => `/datasets/${id}/config`,
    preview: (id: string) => `/datasets/${id}/preview`,
    export: (id: string, kind: string) => `/datasets/${id}/export/${kind}`,
    eventsTemplate: () => "/datasets/events/template",
    settings: () => "/settings/forecast",
  },
  skus: {
    list: () => "/skus",
    detail: (id: string) => `/skus/${id}`,
    bulk: () => "/skus/bulk",
  },
  forecasts: {
    list: () => "/forecasts",
    detail: (id: string) => `/forecasts/${id}`,
    run: () => "/forecasts/run",
    job: (id: string) => `/forecasts/jobs/${id}`,
    algorithms: () => "/forecasts/algorithms",
    metrics: () => "/forecasts/metrics",
    reconciliation: () => "/forecasts/reconciliation",
    export: (kind: string) => `/forecasts/export/${kind}`,
    // Single-SKU Multi-Model Competition (dedicated single-series engine).
    singleSkuRun: () => "/forecasts/single-sku/run",
    singleSkuResult: () => "/forecasts/single-sku/result",
    // Forecast Submission (Phase D) — planner worksheet, bulk ops, submit, audit.
    submission: () => "/forecasts/submission",
    submissionSubmit: () => "/forecasts/submission/submit",
    submissionAudit: () => "/forecasts/submission/audit",
    submissionExport: () => "/forecasts/submission/export",
  },
  scenarios: {
    list: () => "/scenarios",
    detail: (id: string) => `/scenarios/${id}`,
    create: () => "/scenarios",
    // What-If scenario engine (live backend, Phase F.10).
    run: () => "/scenarios/run",
    save: () => "/scenarios/save",
    remove: (id: string) => `/scenarios/${id}`,
    // Causal Effect Estimation (DoWhy) — Phase Y.A parity.
    causalFeatures: () => "/scenarios/causal/features",
    causalRun: () => "/scenarios/causal/run",
    causalDrivers: () => "/scenarios/causal/drivers",
  },
  comparison: {
    compare: () => "/scenarios/compare",
  },
  reports: {
    summary: () => "/reports/summary",
    list: () => "/reports",
    generate: () => "/reports/generate",
    detail: (id: string) => `/reports/${id}`,
    download: (id: string) => `/reports/${id}/download`,
  },
  workflow: {
    status: () => "/workflow/status",
    complete: () => "/workflow/complete",
  },
  workspace: {
    reset: () => "/workspace/reset",
  },
  eda: {
    get: () => "/eda",
    anomalies: () => "/eda/anomalies",
  },
  segmentation: {
    get: () => "/segmentation",
    run: () => "/segmentation/run",
    runs: () => "/segmentation/runs",
    trace: () => "/segmentation/trace",
  },
  explainability: {
    // Phase X.W — forecast-level only; the portfolio `global` endpoint was removed.
    local: (level: string) => `/explainability/local/${encodeURIComponent(level)}`,
    horizon: (level: string) => `/explainability/horizon/${encodeURIComponent(level)}`,
  },
} as const;
