"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  Compass,
  Database,
  FileBarChart,
  Layers,
  LineChart,
  Search,
  SlidersHorizontal,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { PageShell } from "@/components/layout/page-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CollapsiblePanel } from "@/components/ui/collapsible-panel";
import { WorkflowHero } from "@/features/workflow/workflow-hero";
import { routes } from "@/lib/constants/routes";
import { env } from "@/lib/constants/env";

// Informational, non-navigating guidance for each workflow stage. These cards
// explain what happens at each step — they are NOT links and carry no routes or
// click handlers (the sidebar drives navigation).
const STEPS: { n: number; label: string; icon: LucideIcon; desc: string; bullets: string[] }[] = [
  {
    n: 1,
    label: "Input Data & Configuration",
    icon: Database,
    desc: "Bring in your historical sales and define how forecasts are structured.",
    bullets: [
      "Upload historical sales data.",
      "Map the item, date, quantity, brand, and category columns.",
      "Configure the forecasting hierarchy.",
      "Define the forecast horizon.",
      "Select the time frequency.",
      "Validate datasets before processing.",
    ],
  },
  {
    n: 2,
    label: "EDA",
    icon: LineChart,
    desc: "Understand demand behaviour before modelling with exploratory analysis.",
    bullets: [
      "Analyze demand distributions.",
      "Identify trends and seasonality.",
      "Detect missing values.",
      "Detect outliers.",
      "Study correlations.",
      "Visualize historical demand patterns.",
    ],
  },
  {
    n: 3,
    label: "Profile & Route",
    icon: Layers,
    desc: "Classify each item's demand pattern and route it to the right model family.",
    bullets: [
      "Calculate ADI and CV².",
      "Classify demand patterns.",
      "Identify Smooth items.",
      "Identify Erratic items.",
      "Identify Intermittent items.",
      "Identify Lumpy items.",
      "Route each item to its best-fit forecasting model.",
    ],
  },
  {
    n: 4,
    label: "Forecast",
    icon: TrendingUp,
    desc: "Run the model competition and generate reviewable demand forecasts.",
    bullets: [
      "Run multiple forecasting models.",
      "Compare model accuracy.",
      "Select champion models.",
      "Generate future demand forecasts.",
      "Review confidence intervals.",
      "Analyze diagnostics.",
    ],
  },
  {
    n: 5,
    label: "Scenario Planning",
    icon: SlidersHorizontal,
    desc: "Explore what-if plans and measure their impact against the baseline.",
    bullets: [
      "Create what-if scenarios.",
      "Simulate pricing changes.",
      "Evaluate promotion impacts.",
      "Analyze supply constraints.",
      "Compare scenarios against baseline forecasts.",
    ],
  },
  {
    n: 6,
    label: "Reports",
    icon: FileBarChart,
    desc: "Produce executive demand plans and accuracy reports for sign-off.",
    bullets: [
      "Generate executive reports.",
      "Review forecast accuracy.",
      "Export forecast plans.",
      "Download reports.",
      "Share planning outputs.",
    ],
  },
];

interface Term {
  term: string;
  definition: string;
}

const GLOSSARY: Term[] = [
  { term: "Forecast Horizon", definition: "The number of future periods the model projects (e.g. 12 months ahead)." },
  { term: "ADI", definition: "Average Demand Interval — the average number of periods between non-zero demand. Higher ADI = more sporadic demand." },
  { term: "CV²", definition: "Squared coefficient of variation of non-zero demand. Measures how variable the demand sizes are." },
  { term: "WMAPE", definition: "Weighted Mean Absolute Percentage Error — total absolute error divided by total actuals. The primary accuracy metric (lower is better)." },
  { term: "MAPE", definition: "Mean Absolute Percentage Error — average of per-period absolute percentage errors." },
  { term: "SMAPE", definition: "Symmetric MAPE — a percentage error that stays defined when actuals are zero." },
  { term: "Bias", definition: "Signed error: positive = over-forecast, negative = under-forecast." },
  { term: "Intermittent Demand", definition: "Demand that occurs sporadically with many zero-demand periods (high ADI, low variability)." },
  { term: "Lumpy Demand", definition: "Intermittent demand that is also highly variable in size (high ADI and high CV²) — the hardest to forecast." },
  { term: "Smooth Demand", definition: "Regular demand with low intermittency and low variability (low ADI, low CV²)." },
  { term: "Erratic Demand", definition: "Frequent but highly variable demand (low ADI, high CV²)." },
  { term: "Enterprise Level", definition: "A single portfolio-wide forecast covering all items summed into one series." },
  { term: "Top-Down Forecasting", definition: "Forecast a stable aggregate (e.g. brand total), then split it back to each item by its historical share — used for new, sparse, or noisy items." },
  { term: "Confidence Band", definition: "The prediction interval (e.g. P10–P90) showing the likely range around the point forecast." },
  { term: "Backtest", definition: "Holding out recent history and forecasting it to measure out-of-sample accuracy." },
  { term: "Reconciliation", definition: "Aligning item-level forecasts so they sum to an independently-forecast group (e.g. brand) total." },
  { term: "Cold-Start", definition: "An item with too little history to fit a standard model; routed to a foundation/zero-shot approach." },
];

// Informational accordion (Phase X.K · Task 1) — collapsed by default; the header
// shows the step number, icon and label, and expanding reveals the description and
// guidance bullets. No link, no navigation arrow (the sidebar drives navigation);
// each panel is independent so several steps can stay open at once.
function StepCard({ step }: { step: (typeof STEPS)[number] }) {
  const header = (
    <>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-primary/10 text-primary">
        <step.icon className="size-5" />
      </span>
      <div className="min-w-0">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-brand-accent">
          Step {step.n}
        </span>
        <p className="text-sm font-semibold text-foreground">{step.label}</p>
      </div>
    </>
  );

  return (
    <CollapsiblePanel header={header}>
      <p className="text-xs leading-relaxed text-muted-foreground">{step.desc}</p>
      <ul className="space-y-1 pt-2">
        {step.bullets.map((b) => (
          <li key={b} className="flex gap-2 text-xs leading-relaxed text-muted-foreground">
            <span
              className="mt-[6px] size-1 shrink-0 rounded-full bg-brand-accent"
              aria-hidden
            />
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </CollapsiblePanel>
  );
}

/** Overview landing (F.9 Part 4) — what Time Lens is, the workflow, the user
 *  manual launcher, and a searchable terminology glossary. */
export function OverviewView() {
  const [query, setQuery] = useState("");
  const terms = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GLOSSARY;
    return GLOSSARY.filter(
      (t) => t.term.toLowerCase().includes(q) || t.definition.toLowerCase().includes(q),
    );
  }, [query]);

  const openManual = () => {
    window.open(
      routes.userManual,
      "TimeLensUserManual",
      "popup,width=960,height=860,noopener,noreferrer",
    );
  };

  return (
    <PageShell
      title="Overview"
      description="Welcome to Time Lens — your enterprise demand forecasting & planning workbench."
    >
      <WorkflowHero
        step="Welcome"
        title="Forecast Intelligence, End to End"
        subtitle="Go from raw sales history to accurate, reviewable demand plans — one guided workflow."
        icon={Compass}
        variant="horizon"
      />

      {/* What is Time Lens */}
      <Card>
        <CardContent className="space-y-3 pt-6">
          <h2 className="text-base font-semibold tracking-tight text-foreground">What is Time Lens?</h2>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Time Lens is an enterprise demand forecasting and planning platform. It
            ingests your sales history, profiles every item&apos;s demand pattern, routes
            each to its best-fit model, runs a multi-model competition with accuracy
            backtesting, and lets you plan scenarios and publish reviewed demand plans
            — all in one place. Powered by DhishaAI.
          </p>
          <div className="flex flex-wrap gap-3 pt-1">
            <Button asChild>
              <Link href={routes.data}>
                Start: Input Data &amp; Configuration <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button variant="outline" onClick={openManual}>
              <BookOpen className="size-4" /> Open User Manual
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Forecasting workflow — informational guidance (cards do not navigate;
          use the sidebar to move between modules). */}
      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold tracking-tight text-foreground">Forecasting Workflow</h2>
          <p className="text-sm text-muted-foreground">
            A guide to what each stage does — work through them in order using the sidebar.
          </p>
        </div>
        <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
          {STEPS.map((s) => (
            <StepCard key={s.n} step={s} />
          ))}
        </div>
      </section>

      {/* Terminology Knowledge */}
      <section className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Terminology Knowledge
          </h2>
          <div className="relative sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search forecasting terms…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
              aria-label="Search terminology"
            />
          </div>
        </div>
        <Card>
          <CardContent className="divide-y divide-border/60 pt-2">
            {terms.length ? (
              terms.map((t) => (
                <div key={t.term} className="grid grid-cols-1 gap-1 py-3 sm:grid-cols-[200px_1fr] sm:gap-4">
                  <dt className="text-sm font-semibold text-foreground">{t.term}</dt>
                  <dd className="text-sm leading-relaxed text-muted-foreground">{t.definition}</dd>
                </div>
              ))
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No terms match “{query}”.
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      <p className="text-center text-xs text-muted-foreground">
        {env.productSuite} · {env.appName} v{env.appVersion}
      </p>
    </PageShell>
  );
}
