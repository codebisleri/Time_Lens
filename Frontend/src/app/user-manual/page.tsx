import type { Metadata } from "next";
import { AppHeader } from "@/components/layout/app-header";

export const metadata: Metadata = { title: "Time Lens — User Manual" };

/**
 * Standalone User Manual (F.9 Part 4). Lives OUTSIDE the (app) shell so it renders
 * full-bleed in the separate application window opened via window.open(...,'popup').
 * Static reference content — no app data or logic.
 *
 * Uses the SAME shared AppHeader as the rest of the application (in `minimal`
 * mode) so the DhishaAI branding, Time Lens identity, live animated clock,
 * styling and animations are identical — no separate manual header remains.
 */

const SECTIONS: { heading: string; body: string[] }[] = [
  {
    heading: "1. Input Data & Configuration",
    body: [
      "Upload your sales-history file (CSV/Excel). Map the Date, Forecasting Level (the entity each forecast represents, e.g. Product_ID), and Demand columns. Segment is optional.",
      "Set the Forecast Frequency (Monthly, Weekly, …), Forecast Horizon, and an optional Start Date (leave empty to use the full history). Choose the Forecast Level: the level item, a Custom Group, or Enterprise Level (one portfolio-wide series).",
      "Optionally enable Top-Down forecasting for new/sparse/noisy items, and upload an Event Calendar of promotions/holidays.",
    ],
  },
  {
    heading: "2. EDA (Exploratory Data Analysis)",
    body: [
      "Review data quality, demand distribution, trend, seasonality, seasonal decomposition, and correlation/autocorrelation before modelling.",
    ],
  },
  {
    heading: "3. Profile & Route",
    body: [
      "Each item is classified by its demand pattern (Smooth, Intermittent, Erratic, Lumpy) using ADI and CV², then auto-routed to a best-fit model family. The Algorithm Portfolio shows which models will run and how many items each covers.",
    ],
  },
  {
    heading: "4. Forecast",
    body: [
      "Run a multi-model competition. Each item's champion is chosen by hold-out accuracy (WMAPE). Review per-item diagnostics, quality bands, and export the results. The Forecast Horizon is inherited from Input Configuration.",
    ],
  },
  {
    heading: "5. Scenario Planning",
    body: [
      "Model what-if changes (price, promotion, supply) against the baseline forecast and compare the impact.",
    ],
  },
  {
    heading: "6. Reports",
    body: [
      "Generate executive demand-plan and accuracy reports for review and sign-off.",
    ],
  },
];

export default function UserManualPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <AppHeader minimal />

      <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            Time Lens — User Manual
          </h1>
          <p className="text-xs text-muted-foreground">
            Enterprise Forecast Intelligence Platform
          </p>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Time Lens guides you through a single demand-forecasting workflow, from raw
          sales history to reviewed demand plans. Follow the steps in order.
        </p>
        {SECTIONS.map((s) => (
          <section key={s.heading} className="space-y-2">
            <h2 className="text-base font-semibold tracking-tight text-foreground">{s.heading}</h2>
            {s.body.map((p, i) => (
              <p key={i} className="text-sm leading-relaxed text-muted-foreground">{p}</p>
            ))}
          </section>
        ))}
        <p className="border-t border-border pt-4 text-xs text-muted-foreground">
          Powered by DhishaAI. For the full glossary of terms, see Terminology
          Knowledge on the Overview page.
        </p>
      </main>
    </div>
  );
}
