import type { Metadata } from "next";
import {
  AlertTriangle,
  Lightbulb,
  ListChecks,
  type LucideIcon,
} from "lucide-react";
import { AppHeader } from "@/components/layout/app-header";
import { PrintManualButton } from "./print-button";

export const metadata: Metadata = { title: "Time Lens — User Manual" };

/**
 * Standalone User Manual (F.9 Part 4 · rebuilt in Phase X.K · Task 2). Lives
 * OUTSIDE the (app) shell so it renders full-bleed in the separate application
 * window opened via window.open(...,'popup'). Static reference content — no app
 * data or logic.
 *
 * Rewritten for readability: clear hierarchy (sections → sub-headings), a sticky
 * table of contents, Tip/Warning/Example callouts, business-friendly
 * explanations of segments, anomalies, model selection and residual correction,
 * and a print / save-as-PDF action. Uses the SAME shared AppHeader as the rest of
 * the application (in `minimal` mode).
 */

/* ── Presentational primitives ─────────────────────────────────────────────── */

function Callout({
  kind,
  title,
  children,
}: {
  kind: "tip" | "warning" | "example";
  title?: string;
  children: React.ReactNode;
}) {
  const map: Record<typeof kind, { icon: LucideIcon; tone: string; label: string }> = {
    tip: { icon: Lightbulb, tone: "border-success/30 bg-success/5 text-success", label: "Tip" },
    warning: { icon: AlertTriangle, tone: "border-warning/30 bg-warning/5 text-warning", label: "Important" },
    example: { icon: ListChecks, tone: "border-primary/30 bg-primary/5 text-primary", label: "Example" },
  };
  const { icon: Icon, tone, label } = map[kind];
  return (
    <div className={`rounded-lg border ${tone.split(" ").slice(0, 2).join(" ")} p-4`}>
      <p className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-wide ${tone.split(" ")[2]}`}>
        <Icon className="size-4" />
        {title ?? label}
      </p>
      <div className="mt-1.5 space-y-2 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20 space-y-3">
      <h2 className="border-b border-border pb-1.5 text-lg font-semibold tracking-tight text-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="pt-1 text-sm font-semibold text-foreground">{children}</h3>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>;
}

function DefRow({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 py-2 sm:grid-cols-[180px_1fr] sm:gap-4">
      <dt className="text-sm font-semibold text-foreground">{term}</dt>
      <dd className="text-sm leading-relaxed text-muted-foreground">{children}</dd>
    </div>
  );
}

/* ── Table of contents ─────────────────────────────────────────────────────── */

const TOC: { id: string; label: string }[] = [
  { id: "intro", label: "1. What is Time Lens?" },
  { id: "workflow", label: "2. The Forecasting Workflow" },
  { id: "segments", label: "3. Understanding Demand Segments" },
  { id: "anomalies", label: "4. How Anomalies Are Detected" },
  { id: "models", label: "5. How Models Are Selected" },
  { id: "residual", label: "6. Residual Correction & XGB Residual" },
  { id: "topdown", label: "7. Top-Down Forecasting" },
  { id: "results", label: "8. Reading Your Results" },
];

/* ── Page ──────────────────────────────────────────────────────────────────── */

export default function UserManualPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <AppHeader minimal />

      <main className="mx-auto max-w-3xl space-y-8 px-6 py-8">
        {/* Title + actions */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Time Lens — User Manual
            </h1>
            <p className="text-xs text-muted-foreground">
              Demand Forecasting &amp; Planning Platform · A beginner-to-analyst guide
            </p>
          </div>
          <PrintManualButton />
        </div>

        {/* Table of contents */}
        <nav className="rounded-lg border border-border bg-card/40 p-4 print:hidden">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Contents
          </p>
          <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {TOC.map((t) => (
              <li key={t.id}>
                <a
                  href={`#${t.id}`}
                  className="text-sm text-muted-foreground transition-colors hover:text-brand-accent"
                >
                  {t.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* 1. Intro */}
        <Section id="intro" title="1. What is Time Lens?">
          <P>
            Time Lens is an enterprise demand-forecasting and planning platform. It turns raw
            sales history into accurate, reviewable demand plans through one guided workflow:
            it ingests your data, profiles each item&apos;s demand behaviour, routes every item to
            its best-fit model, runs a multi-model competition with accuracy backtesting, and
            lets you plan scenarios and publish signed-off reports.
          </P>
          <Callout kind="tip">
            <p>
              You don&apos;t need to be a data scientist. Follow the six workflow steps in order
              using the sidebar — each step explains what it does and what to check before
              moving on.
            </p>
          </Callout>
          <P>
            Throughout this manual, <strong>&ldquo;item&rdquo;</strong> means whatever you chose as
            your Forecast Level — it might be a Product ID, Material Code, SKU, or a custom group.
            The platform always uses your own column name, so what you see on screen matches your
            business vocabulary.
          </P>
        </Section>

        {/* 2. Workflow */}
        <Section id="workflow" title="2. The Forecasting Workflow">
          <P>
            The workflow is a straight line. Each step unlocks the next, so you always know where
            you are:
          </P>
          <div className="rounded-lg border border-border bg-card/40 p-4 text-center text-xs font-medium text-muted-foreground">
            Input &amp; Configure → EDA → Profile &amp; Route → Forecast → Scenario Planning → Reports
          </div>

          <SubHeading>Step 1 · Input Data &amp; Configuration</SubHeading>
          <P>
            Upload your sales-history file (CSV/Excel) and map the key columns: the Date, the
            Forecast Level (the entity each forecast represents, e.g. Product ID), and the Demand
            value. Then set the Forecast Frequency (Monthly, Weekly…), the Forecast Horizon (how
            many future periods to project), and an optional Start Date.
          </P>
          <Callout kind="warning">
            <p>
              Map your Date and Demand columns correctly — every later step depends on them. If
              dates fail to parse, set the Date Format explicitly instead of leaving it on
              auto-detect.
            </p>
          </Callout>

          <SubHeading>Step 2 · EDA (Exploratory Data Analysis)</SubHeading>
          <P>
            Review data quality, demand distribution, trend, seasonality, decomposition, and
            autocorrelation before modelling. This is also where you review and correct anomalies
            (see section 4).
          </P>

          <SubHeading>Step 3 · Profile &amp; Route</SubHeading>
          <P>
            Every item is classified by its demand pattern and contribution, then auto-routed to
            a best-fit model family. The Algorithm Portfolio shows which models will run and how
            many items each covers (see section 3).
          </P>

          <SubHeading>Step 4 · Forecast</SubHeading>
          <P>
            Run the multi-model competition. Each item&apos;s champion model is chosen by hold-out
            accuracy (WMAPE). Review per-item diagnostics, confidence bands, and export results.
          </P>

          <SubHeading>Step 5 · Scenario Planning</SubHeading>
          <P>
            Model what-if changes (price, promotion, supply) against the baseline forecast and
            compare the impact before committing to a plan.
          </P>

          <SubHeading>Step 6 · Reports</SubHeading>
          <P>Generate executive demand-plan and accuracy reports for review and sign-off.</P>
        </Section>

        {/* 3. Segments */}
        <Section id="segments" title="3. Understanding Demand Segments">
          <P>
            Time Lens classifies every item along two axes: how <strong>predictable</strong> its
            demand is (Stable vs Volatile) and how much it <strong>contributes</strong> to revenue
            (High, Mid, Low). Combining them gives six core segments, plus three triage buckets
            for items that need special handling — nine in total.
          </P>

          <Callout kind="example" title="What is Stable High?">
            <p>
              A <strong>Stable High</strong> item sells smoothly and predictably <em>and</em> drives
              a large share of revenue — your reliable best-sellers. They get your most powerful
              models and the tightest review, because an error here costs the most.
            </p>
          </Callout>

          <Callout kind="example" title="What is Volatile Low?">
            <p>
              A <strong>Volatile Low</strong> item sells erratically (spiky or sporadic) and
              contributes little revenue — long-tail products. They&apos;re routed to robust,
              intermittent-demand models rather than precision models, because chasing their noise
              isn&apos;t worth it.
            </p>
          </Callout>

          <SubHeading>The nine segments at a glance</SubHeading>
          <dl className="divide-y divide-border/60">
            <DefRow term="Stable High">Predictable demand, top revenue contribution — flagship items, highest modelling effort.</DefRow>
            <DefRow term="Stable Mid">Predictable demand, moderate contribution — dependable mid-tier products.</DefRow>
            <DefRow term="Stable Low">Predictable but small — easy to forecast, low business impact.</DefRow>
            <DefRow term="Volatile High">Important but hard to predict — high revenue with spiky demand; needs blended models and close review.</DefRow>
            <DefRow term="Volatile Mid">Moderate value, irregular demand — balanced, robust models.</DefRow>
            <DefRow term="Volatile Low">Long-tail, erratic, low value — intermittent-demand models (Croston / SBA family).</DefRow>
            <DefRow term="Cold-Start / NPI">Too little history to model normally (new products) — routed to foundation / zero-shot approaches.</DefRow>
            <DefRow term="Short History">Some history, not enough for a full model — borrows strength from a pooled global model.</DefRow>
            <DefRow term="Intermittent / Lumpy">Many zero-demand periods — specialised intermittent-demand methods.</DefRow>
          </dl>
          <Callout kind="tip">
            <p>
              Stable vs Volatile is derived from the demand <em>pattern</em> (using ADI and CV²),
              so the pattern and volatility views can never disagree. Open &ldquo;Trace a SKU&rdquo; on
              the Profile &amp; Route page to see the exact arithmetic for any item.
            </p>
          </Callout>
        </Section>

        {/* 4. Anomalies */}
        <Section id="anomalies" title="4. How Anomalies Are Detected">
          <P>
            An anomaly is a point that doesn&apos;t fit the item&apos;s normal demand behaviour — a
            sudden spike or drop. Time Lens uses an <strong>Isolation Forest</strong> detector,
            which isolates unusual points, combined with a holiday-aware check so genuine holiday
            peaks aren&apos;t mistaken for errors.
          </P>
          <SubHeading>Why was this point flagged?</SubHeading>
          <P>
            On the EDA anomaly table, click <strong>Explain</strong> on any row to see the reasons,
            assembled from the existing detection output — for example:
          </P>
          <ul className="space-y-1 pl-1 text-sm text-muted-foreground">
            <li>• Demand was 42% above the expected range.</li>
            <li>• Isolation Forest score exceeded the detection threshold.</li>
            <li>• Rolling demand deviation detected (≈3σ from the mean).</li>
            <li>• No holiday impact found — demand deviates from expected seasonal behaviour.</li>
          </ul>
          <Callout kind="warning">
            <p>
              Correcting an anomaly replaces it with a rolling-mean estimate, which <em>changes the
              history your models learn from</em>. Only correct points you&apos;re confident are data
              errors — leave real demand events (genuine promotions, true stockouts) in place.
            </p>
          </Callout>
        </Section>

        {/* 5. Model selection */}
        <Section id="models" title="5. How Models Are Selected">
          <P>
            Time Lens does not pick one model for everything. Each item runs a{" "}
            <strong>competition</strong>: several candidate models forecast a held-out slice of
            recent history (a backtest), and the one with the best out-of-sample accuracy —
            measured by <strong>WMAPE</strong> (lower is better) — becomes that item&apos;s
            <strong> champion</strong>.
          </P>
          <SubHeading>Why was this model selected?</SubHeading>
          <P>
            Because it produced the lowest backtest error <em>for that specific item</em>. A smooth
            best-seller may be won by a Global LightGBM model; an intermittent long-tail item by
            Croston/SBA; a brand-new item by a zero-shot foundation model. The candidate pool is
            decided by the item&apos;s segment (section 3), so each item only competes among models
            suited to its demand pattern.
          </P>
          <Callout kind="tip">
            <p>
              On the Forecast results, the champion is marked with a star (★). Open an item to see
              its full leaderboard and how close the runners-up were.
            </p>
          </Callout>
        </Section>

        {/* 6. Residual correction */}
        <Section id="residual" title="6. Residual Correction & XGB Residual">
          <P>
            A <strong>residual</strong> is the leftover error after a model makes its prediction
            (actual minus forecast). Even a good model leaves a pattern in its residuals — for
            example a consistent under-forecast around promotions.
          </P>
          <SubHeading>What is residual correction?</SubHeading>
          <P>
            Residual correction trains a second model to predict those leftover errors and adds the
            correction back to the base forecast. The base model captures the main signal; the
            corrector cleans up the systematic mistakes it missed.
          </P>
          <SubHeading>What is XGB residual?</SubHeading>
          <P>
            &ldquo;XGB residual&rdquo; means the corrector is a gradient-boosted tree model
            (XGBoost) trained on the base model&apos;s residuals, using features like lags, price,
            and promotions. It&apos;s a booster layer, not a replacement — it only nudges the base
            forecast toward the patterns it can still explain.
          </P>
          <Callout kind="example">
            <p>
              Base model forecasts 100 units; it has historically under-forecast this item by ~8
              units during promos. The XGB residual layer learns that bias and lifts the promo-week
              forecast to ~108.
            </p>
          </Callout>
        </Section>

        {/* 7. Top-down */}
        <Section id="topdown" title="7. Top-Down Forecasting">
          <P>
            Some items are too new, too sparse, or too noisy to forecast reliably on their own.
            <strong> Top-Down forecasting</strong> instead forecasts a stable aggregate — for
            example a brand or category total — and then splits that total back down to each item
            by its historical share.
          </P>
          <Callout kind="tip">
            <p>
              Forecasting the aggregate is easier and more accurate because the noise of individual
              items averages out. Enable Top-Down in Step 1 for cold-start, short-history, or noisy
              items.
            </p>
          </Callout>
        </Section>

        {/* 8. Results */}
        <Section id="results" title="8. Reading Your Results">
          <P>Key metrics and concepts you&apos;ll see on the Forecast page:</P>
          <dl className="divide-y divide-border/60">
            <DefRow term="WMAPE">Weighted Mean Absolute Percentage Error — the primary accuracy metric. Total absolute error ÷ total actuals. Lower is better.</DefRow>
            <DefRow term="Bias">Signed error. Positive = over-forecast, negative = under-forecast. Aim for near zero.</DefRow>
            <DefRow term="Confidence Band">The likely range around the point forecast (e.g. P10–P90). Wider bands mean more uncertainty.</DefRow>
            <DefRow term="Backtest">Holding out recent history and forecasting it to measure real out-of-sample accuracy.</DefRow>
            <DefRow term="Champion">The model that won an item&apos;s competition on backtest accuracy.</DefRow>
          </dl>
          <Callout kind="warning">
            <p>
              A low WMAPE on a backtest is a strong sign, but always sanity-check the forecast
              chart against your business knowledge before sign-off. Metrics summarise the past;
              your judgement covers what the data can&apos;t see.
            </p>
          </Callout>
        </Section>

        <p className="border-t border-border pt-4 text-xs text-muted-foreground">
          Powered by DhishaAI. For the full glossary of terms, see Terminology Knowledge on the
          Overview page.
        </p>
      </main>
    </div>
  );
}
