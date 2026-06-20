import { AxiosError } from "axios";
import type { ApiErrorShape } from "@/types/api";

/**
 * Normalized error type the whole UI consumes. Services never leak raw Axios
 * errors — they throw ApiError, so components/hooks deal with one shape.
 */
export class ApiError extends Error implements ApiErrorShape {
  status: number;
  code: string;
  fieldErrors?: Record<string, string[]>;
  details?: unknown;

  constructor(shape: ApiErrorShape) {
    super(shape.message);
    this.name = "ApiError";
    this.status = shape.status;
    this.code = shape.code;
    this.fieldErrors = shape.fieldErrors;
    this.details = shape.details;
  }

  get isUnauthorized() {
    return this.status === 401;
  }
  get isForbidden() {
    return this.status === 403;
  }
  get isNotFound() {
    return this.status === 404;
  }
  get isValidation() {
    return this.status === 422 || Boolean(this.fieldErrors);
  }
}

/** Convert any thrown value (Axios or otherwise) into a stable ApiError. */
export function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  if (error instanceof AxiosError) {
    const status = error.response?.status ?? 0;
    const payload = error.response?.data as
      | Partial<ApiErrorShape>
      | { detail?: string }
      | undefined;

    return new ApiError({
      status,
      code: (payload as Partial<ApiErrorShape>)?.code ?? mapStatusToCode(status),
      message:
        (payload as Partial<ApiErrorShape>)?.message ??
        (payload as { detail?: string })?.detail ??
        error.message ??
        "Request failed",
      fieldErrors: (payload as Partial<ApiErrorShape>)?.fieldErrors,
      details: payload,
    });
  }

  return new ApiError({
    status: 0,
    code: "UNKNOWN",
    message: error instanceof Error ? error.message : "Unexpected error",
  });
}

function mapStatusToCode(status: number): string {
  switch (status) {
    case 0:
      return "NETWORK";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 422:
      return "VALIDATION";
    case 500:
      return "SERVER_ERROR";
    default:
      return "ERROR";
  }
}
