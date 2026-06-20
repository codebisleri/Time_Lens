import { http } from "../client";
import { endpoints } from "../endpoints";
import type { Paginated } from "@/types/api";
import type {
  ForecastDetail,
  ForecastSummary,
  ForecastListParams,
  RunForecastPayload,
  ForecastJob,
  ForecastAlgorithms,
  ForecastRunMetrics,
  ReconciliationResult,
  RunSingleSkuPayload,
  SingleSkuResult,
} from "@/types/forecast";

export const forecastService = {
  list(params?: ForecastListParams): Promise<Paginated<ForecastSummary>> {
    return http.get<Paginated<ForecastSummary>>(
      endpoints.forecasts.list(),
      params,
    );
  },

  getById(id: string): Promise<ForecastDetail> {
    return http.get<ForecastDetail>(endpoints.forecasts.detail(id));
  },

  /** Kicks off the (async) forecasting engine; returns a job handle to poll. */
  run(payload: RunForecastPayload): Promise<ForecastJob> {
    return http.post<ForecastJob>(endpoints.forecasts.run(), payload);
  },

  getJob(jobId: string): Promise<ForecastJob> {
    return http.get<ForecastJob>(endpoints.forecasts.job(jobId));
  },

  /** Real algorithm registries for the configuration multiselect. */
  algorithms(): Promise<ForecastAlgorithms> {
    return http.get<ForecastAlgorithms>(endpoints.forecasts.algorithms());
  },

  /** Run summary + per-SKU rows + quality bands for the results view. */
  metrics(params?: { datasetId?: string; runId?: string }): Promise<ForecastRunMetrics> {
    return http.get<ForecastRunMetrics>(endpoints.forecasts.metrics(), params);
  },

  /** Brand-level reconciliation payload (table + reconciled charts). 422 when the
   *  run was not reconciled. */
  reconciliation(params?: { datasetId?: string; runId?: string }): Promise<ReconciliationResult> {
    return http.get<ReconciliationResult>(endpoints.forecasts.reconciliation(), params);
  },

  /** Real CSV exports: forecasts | all-models | reconciliation | sku-adjusted. */
  exportCsv(kind: string, params?: { datasetId?: string; runId?: string }): Promise<string> {
    return http.get<string>(endpoints.forecasts.export(kind), params);
  },

  /** Kick off the dedicated single-SKU multi-model competition (job to poll). */
  runSingleSku(payload: RunSingleSkuPayload): Promise<ForecastJob> {
    return http.post<ForecastJob>(endpoints.forecasts.singleSkuRun(), payload);
  },

  /** Latest single-SKU competition result for the active dataset. */
  singleSkuResult(params?: { datasetId?: string }): Promise<SingleSkuResult> {
    return http.get<SingleSkuResult>(endpoints.forecasts.singleSkuResult(), params);
  },
};
