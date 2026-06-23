/**
 * Centralized, typed access to environment configuration.
 * Never read process.env directly elsewhere — import from here so every flag
 * has one definition and one default.
 */
export const env = {
  appName: process.env.NEXT_PUBLIC_APP_NAME ?? "Time Lens",
  apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api",
  useMocks:
    (process.env.NEXT_PUBLIC_USE_MOCKS ?? "true").toLowerCase() === "true",
  mockLatency: Number(process.env.NEXT_PUBLIC_MOCK_LATENCY ?? "400"),
  isProduction: process.env.NODE_ENV === "production",
  // Product-identity metadata for the enterprise header / login chrome.
  productSuite:
    process.env.NEXT_PUBLIC_PRODUCT_SUITE ??
    "Enterprise Forecast Intelligence Platform",
  productTagline:
    process.env.NEXT_PUBLIC_PRODUCT_TAGLINE ?? "Forecast Planning Suite",
  appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? "1.0.0",
  // Deployment environment badge — defaults from NODE_ENV, override explicitly.
  environment:
    process.env.NEXT_PUBLIC_ENVIRONMENT ??
    (process.env.NODE_ENV === "production" ? "Production" : "Preview"),
} as const;

export type Env = typeof env;
