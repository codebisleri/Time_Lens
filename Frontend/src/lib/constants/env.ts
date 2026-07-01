/**
 * Centralized, typed access to environment configuration.
 * Never read process.env directly elsewhere — import from here so every flag
 * has one definition and one default.
 */
export const env = {
  appName: process.env.NEXT_PUBLIC_APP_NAME ?? "Time Lens",
  // Default to the local FastAPI bridge so the app talks to the REAL backend out
  // of the box (dev + desktop). Override with NEXT_PUBLIC_API_BASE_URL.
  apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000",
  // Real backend by DEFAULT — the mock adapter is OPT-IN. It only activates when
  // NEXT_PUBLIC_USE_MOCKS is explicitly "true". This prevents live routes (e.g.
  // /auth/login, /datasets/upload, /workspace/reset) from silently entering the
  // mock layer in dev (which threw "No mock handler …").
  useMocks:
    (process.env.NEXT_PUBLIC_USE_MOCKS ?? "false").toLowerCase() === "true",
  mockLatency: Number(process.env.NEXT_PUBLIC_MOCK_LATENCY ?? "400"),
  isProduction: process.env.NODE_ENV === "production",
  // Product-identity metadata for the enterprise header / login chrome.
  productSuite:
    process.env.NEXT_PUBLIC_PRODUCT_SUITE ??
    "Enterprise Forecast Intelligence Platform",
  productTagline:
    process.env.NEXT_PUBLIC_PRODUCT_TAGLINE ?? "Forecast Planning Suite",
  appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? "1.2.0",
  // Deployment environment badge — defaults from NODE_ENV, override explicitly.
  environment:
    process.env.NEXT_PUBLIC_ENVIRONMENT ??
    (process.env.NODE_ENV === "production" ? "Production" : "Preview"),
} as const;

export type Env = typeof env;
