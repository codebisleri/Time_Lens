import { env } from "@/lib/constants/env";
import type { RequestSpec } from "../client";
import { ApiError } from "../error";
import { mockRoutes } from "./routes";

/**
 * Mock transport. Matches a RequestSpec against the registered mock routes and
 * returns fixture data after a simulated latency. Mirrors the real client's
 * contract (returns Promise<T>, throws ApiError) so services are source-agnostic.
 *
 * Routes live in ./routes.ts keyed by `METHOD url-pattern`. Add a backend and
 * flip NEXT_PUBLIC_USE_MOCKS=false to retire this entirely.
 */
export async function mockAdapter<T>(spec: RequestSpec): Promise<T> {
  await delay(env.mockLatency);

  const handler = matchRoute(spec);
  if (!handler) {
    throw new ApiError({
      status: 404,
      code: "MOCK_NOT_FOUND",
      message: `No mock handler for ${spec.method} ${spec.url}`,
    });
  }

  return handler(spec) as T;
}

function matchRoute(spec: RequestSpec) {
  const method = spec.method.toUpperCase();
  // Strip query string; params arrive via spec.params.
  const path = spec.url.split("?")[0] ?? spec.url;

  for (const route of mockRoutes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(path);
    if (match) {
      // Expose path params (e.g. :id) on the spec for the handler.
      return (s: RequestSpec) =>
        route.handler(s, match.groups ?? {});
    }
  }
  return null;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
