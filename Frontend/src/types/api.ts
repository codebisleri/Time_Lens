/**
 * Transport-level contracts shared by every service. These describe the *shape*
 * the frontend expects; the backend (not yet FastAPI) will conform to them, or
 * a mapper in the service layer will adapt to them. Nothing here couples to a
 * specific backend implementation.
 */

/** Standard envelope. The service layer unwraps this and returns `data`. */
export interface ApiResponse<T> {
  data: T;
  message?: string;
  meta?: Record<string, unknown>;
}

/** Cursor/offset pagination envelope. */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}

/** Normalized error surfaced to the UI (see lib/api/error.ts). */
export interface ApiErrorShape {
  status: number;
  code: string;
  message: string;
  /** Field-level validation errors, keyed by field path. */
  fieldErrors?: Record<string, string[]>;
  details?: unknown;
}

/** Common list query parameters. */
export interface ListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
}

/** Async request lifecycle used by custom hooks today; maps cleanly to
 *  TanStack Query's {data,isLoading,error} when it is adopted later. */
export type RequestStatus = "idle" | "loading" | "success" | "error";

export interface AsyncState<T> {
  data: T | null;
  status: RequestStatus;
  error: ApiErrorShape | null;
}

export type ID = string;

/** ISO-8601 timestamp string. */
export type ISODateString = string;
