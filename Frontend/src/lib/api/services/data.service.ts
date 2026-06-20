import { http } from "../client";
import { endpoints } from "../endpoints";
import type {
  DataConfig,
  Dataset,
  DatasetPreview,
  ForecastSettings,
} from "@/types/dataset";

export const dataService = {
  listDatasets(): Promise<Dataset[]> {
    return http.get<Dataset[]>(endpoints.data.datasets());
  },

  getDataset(id: string): Promise<Dataset> {
    return http.get<Dataset>(endpoints.data.dataset(id));
  },

  /** Persist the Data-page configuration; the bridge re-derives schema metadata. */
  updateConfig(id: string, payload: Partial<DataConfig>): Promise<Dataset> {
    return http.patch<Dataset>(endpoints.data.config(id), payload);
  },

  preview(id: string, rows = 12): Promise<DatasetPreview> {
    return http.get<DatasetPreview>(endpoints.data.preview(id), { rows });
  },

  /** Real CSV exports (validation / quality / cleaned / prepared) — returns raw text. */
  exportCsv(id: string, kind: string): Promise<string> {
    return http.get<string>(endpoints.data.export(id, kind));
  },

  /** Configuration export — returns the JSON object to serialize client-side. */
  exportConfig(id: string): Promise<unknown> {
    return http.get<unknown>(endpoints.data.export(id, "config"));
  },

  /** Future-events calendar template (CSV text). */
  eventsTemplate(): Promise<string> {
    return http.get<string>(endpoints.data.eventsTemplate());
  },

  getSettings(): Promise<ForecastSettings> {
    return http.get<ForecastSettings>(endpoints.data.settings());
  },

  updateSettings(payload: Partial<ForecastSettings>): Promise<ForecastSettings> {
    return http.put<ForecastSettings>(endpoints.data.settings(), payload);
  },

  /**
   * Uploads a sales file as multipart/form-data. The live bridge
   * (POST /datasets/upload) parses + registers it and returns the created
   * Dataset (id, fileName, rowCount, skuCount, status, dateRange).
   */
  uploadDataset(file: File): Promise<Dataset> {
    const form = new FormData();
    form.append("file", file);
    return http.post<Dataset>(endpoints.data.upload(), form);
  },
};
