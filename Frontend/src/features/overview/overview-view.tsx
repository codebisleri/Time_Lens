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
import { WorkflowHero } from "@/features/workflow/workflow-hero";
import { routes } from "@/lib/constants/routes";
import { env } from "@/lib/constants/env";

const STEPS: { n: number; label: string; href: string; icon: LucideIcon; desc: string }[] = [
  { n: 1, label: "Input Data & Configuration", href: routes.data, icon: Database, desc: "Upload sales history, map columns, set the forecasting level, frequency, and horizon." },
  { n: 2, label: "EDA", href: routes.eda, icon: LineChart, desc: "Explore demand: distribution, trend, seasonality, decomposition, and correlation." },
  { n: 3, label: "Profile & Route", href: routes.profile, icon: Layers, desc: "Classify demand patterns and auto-route every item to its best-fit model family." },
  { n: 4, label: "Forecast", href: routes.forecast, icon: TrendingUp, desc: "Run the model competition, pick champions, and review accuracy diagnostics." },
  { n: 5, label: "Scenario Planning", href: routes.scenarios, icon: SlidersHorizontal, desc: "Model what-if price, promo, and supply changes against the baseline plan." },
  { n: 6, label: "Reports", href: routes.report, icon: FileBarChart, desc: "Generate executive demand plans and accuracy reports for sign-off." },
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

function StepCard({ step }: { step: (typeof STEPS)[number] }) {
  return (
    <Link
      href={step.href}
      className="group flex gap-4 rounded-xl border border-border bg-card p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-[var(--shadow-md)]"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-primary/10 text-primary">
        <step.icon className="size-5" />
      </span>
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-brand-accent">
            Step {step.n}
          </span>
        </div>
        <p className="text-sm font-semibold text-foreground">{step.label}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{step.desc}</p>
      </div>
      <ArrowRight className="ml-auto size-4 shrink-0 self-center text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </Link>
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

      {/* Forecasting workflow */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold tracking-tight text-foreground">Forecasting Workflow</h2>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
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
