/** Planner review decision for a single forecast. Stored locally (the bridge
 *  has no approval persistence yet) so the workflow is demonstrable end-to-end. */
export type ReviewDecision = "pending" | "approved" | "rejected";

export interface ReviewRecord {
  decision: ReviewDecision;
  /** Manual override of the total forecast units (null = use model output). */
  overrideUnits?: number | null;
  notes?: string;
  updatedAt?: string;
}

export type ReviewMap = Record<string, ReviewRecord>;

export const REVIEW_STORAGE_KEY = "tl-forecast-reviews";

export const DECISION_LABEL: Record<ReviewDecision, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
};

export const DECISION_VARIANT: Record<
  ReviewDecision,
  "secondary" | "success" | "destructive"
> = {
  pending: "secondary",
  approved: "success",
  rejected: "destructive",
};
