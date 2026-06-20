import { http } from "../client";
import { endpoints } from "../endpoints";

/** F.18 — full per-user workspace reset (server-side purge + workflow reset). */
export const workspaceService = {
  reset(): Promise<{ ok: boolean; datasetsRemoved: number }> {
    return http.post<{ ok: boolean; datasetsRemoved: number }>(
      endpoints.workspace.reset(),
      {},
    );
  },
};
