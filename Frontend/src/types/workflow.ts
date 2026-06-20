/** Persisted forecasting-workflow progression (backend `/workflow/status`). */
export interface WorkflowStatus {
  datasetId: string | null;
  datasetUploaded: boolean;
  edaCompleted: boolean;
  profileCompleted: boolean;
  forecastCompleted: boolean;
  reviewCompleted: boolean;
}

export type WorkflowStep = "eda" | "profile" | "forecast" | "review";
