import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type Method,
} from "axios";
import { env } from "@/lib/constants/env";
import { normalizeError } from "./error";
import { mockAdapter } from "./mock/adapter";
import { clearToken, getToken } from "./auth-token";

/**
 * Single HTTP transport for the whole app.
 *
 * Design goals:
 *  - Services depend ONLY on the typed `request()` helper, never on axios.
 *  - `withCredentials` so the eventual httpOnly session cookie flows automatically.
 *  - A 401 interceptor centralizes session-expiry handling.
 *  - When env.useMocks is on, requests are served by the mock adapter with the
 *    same `RequestSpec` contract — so flipping NEXT_PUBLIC_USE_MOCKS swaps the
 *    data source with zero changes in services or pages.
 *  - `request()` returns the unwrapped payload (Promise<T>), which is exactly
 *    the shape a TanStack Query `queryFn` expects — adding Query later is purely
 *    additive (wrap these calls), no refactor of the transport.
 */

export interface RequestSpec {
  method: Method;
  url: string;
  params?: object;
  data?: unknown;
  config?: AxiosRequestConfig;
}

/**
 * Endpoints served by the live FastAPI bridge (Backend/api.py). When mocks are
 * OFF, ONLY these route prefixes hit the network; every other endpoint (auth,
 * dashboard, scenarios, reports, settings) still resolves through the mock
 * adapter, so those pages keep working until their backend exists. This is what
 * lets us integrate Data Upload / SKU Management / Forecast Results without
 * touching any other feature.
 */
const LIVE_API_PREFIXES = [
  "/auth",
  "/datasets",
  "/skus",
  "/forecasts",
  "/workflow",
  // F.18A — /workspace/reset is a LIVE backend route; without this prefix the
  // transport sent it to the mock adapter (no such mock → threw before any
  // network call, so the reset "failed" with no request in the Network tab).
  "/workspace",
  "/eda",
  "/segmentation",
  "/reports",
  "/scenarios",
] as const;

function isLiveRoute(url: string): boolean {
  return LIVE_API_PREFIXES.some(
    (p) => url === p || url.startsWith(`${p}/`),
  );
}

const axiosInstance: AxiosInstance = axios.create({
  baseURL: env.apiBaseUrl,
  withCredentials: true, // send/receive the httpOnly session cookie
  timeout: 30_000,
  headers: { "Content-Type": "application/json" },
});

// ── Interceptors ──────────────────────────────────────────────────────────
axiosInstance.interceptors.response.use(
  (response) => response,
  (error) => {
    // Hook point for global session handling. On the client, a 401 means the
    // session expired — surface it so the auth store can clear and redirect.
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      // Clear the (now-invalid) token + presence cookie BEFORE notifying, so the
      // middleware doesn't bounce the user straight back into a protected route.
      clearToken();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("auth:unauthorized"));
      }
    }
    return Promise.reject(error);
  },
);

/**
 * The one function services call. Returns the unwrapped data of type T and
 * throws a normalized ApiError on failure.
 */
export async function request<T>(spec: RequestSpec): Promise<T> {
  try {
    // Mocks ON → everything mocked. Mocks OFF → only the live-bridge routes hit
    // the network; all other endpoints still fall back to the mock adapter.
    if (env.useMocks || !isLiveRoute(spec.url)) {
      return await mockAdapter<T>(spec);
    }

    // Let axios compute the multipart boundary for file uploads instead of the
    // instance default (application/json), which would corrupt the body.
    const isFormData =
      typeof FormData !== "undefined" && spec.data instanceof FormData;

    // Attach the bearer token (from localStorage) on live requests.
    const token = getToken();
    const authHeaders: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};
    const contentHeaders: Record<string, string> = isFormData
      ? { "Content-Type": "multipart/form-data" }
      : {};
    const headers = { ...authHeaders, ...contentHeaders };

    const response = await axiosInstance.request<{ data: T } | T>({
      method: spec.method,
      url: spec.url,
      params: spec.params,
      data: spec.data,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...spec.config,
    });

    // Unwrap { data } envelope if present, else return the body directly.
    const body = response.data as { data?: T };
    return (body?.data ?? response.data) as T;
  } catch (error) {
    throw normalizeError(error);
  }
}

/**
 * Thin verb helpers for ergonomic service code. Query params are typed as
 * `object` so typed param interfaces (SkuListParams, ForecastListParams, …) pass
 * through directly — interfaces lack an index signature and so are not assignable
 * to Record<string, unknown>, but every interface is assignable to `object`.
 * (A generic param can't help here: services supply an explicit `T`, which makes
 * TS use a second type parameter's default rather than inferring it.)
 */
export const http = {
  get: <T>(url: string, params?: object) =>
    request<T>({ method: "GET", url, params }),
  post: <T>(url: string, data?: unknown) =>
    request<T>({ method: "POST", url, data }),
  put: <T>(url: string, data?: unknown) =>
    request<T>({ method: "PUT", url, data }),
  patch: <T>(url: string, data?: unknown) =>
    request<T>({ method: "PATCH", url, data }),
  delete: <T>(url: string, params?: object) =>
    request<T>({ method: "DELETE", url, params }),
};

export { axiosInstance };
