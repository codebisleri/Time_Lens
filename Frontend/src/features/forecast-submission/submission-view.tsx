"use client";

import { ClipboardCheck } from "lucide-react";
import { PageShell } from "@/components/layout/page-shell";
import { routes } from "@/lib/constants/routes";
import { WorkflowHero, HeroStatusPill } from "@/features/workflow/workflow-hero";
import { WorkflowLock } from "@/features/workflow/workflow-lock";
import { useWorkflowStatus } from "@/features/workflow/use-workflow-status";
import { SubmissionWorksheet } from "./submission-worksheet";

/**
 * Forecast Submission — the planner worksheet (Step 5). Mirrors Streamlit's
 * render_submission_tab: cascading filters, KPI strip, bulk actions, an editable
 * month-level grid, submit + CSV + audit trail. The worksheet content lives in
 * SubmissionWorksheet so it can ALSO render inline in the post-forecast workflow.
 */
export function ForecastSubmissionView() {
  const workflow = useWorkflowStatus();
  const gated =
    !workflow.isLoading && workflow.data && !workflow.data.forecastCompleted;

  if (gated) {
    return (
      <PageShell
        title="Forecast Submission"
        description="Step 5 — review, adjust, and submit the final forecast plan."
      >
        <WorkflowLock
          title="No forecast to submit"
          message="Run a forecast first."
          href={routes.forecast}
          ctaLabel="Go to Forecast"
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Forecast Submission"
      description="Review · adjust · submit — edit any forecast month, log the business reason, and lock in the final plan."
    >
      <WorkflowHero
        step="Step 5 · Forecast Submission"
        title="Demand Plan Review & Sign-off"
        subtitle="Adjust any forecast month, log the business rationale, and lock in the consensus plan."
        icon={ClipboardCheck}
        variant="timeline"
        status={
          <>
            <HeroStatusPill tone="accent">Consensus plan</HeroStatusPill>
            <HeroStatusPill>Review &amp; sign-off</HeroStatusPill>
          </>
        }
      />
      <SubmissionWorksheet />
    </PageShell>
  );
}
