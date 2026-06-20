import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { ForecastMotif, type MotifVariant } from "@/components/common/forecast-graphics";

/**
 * Forecasting hero banner at the top of each workflow stage. Replaces the plain
 * Streamlit-style step header with an enterprise demand-planning identity:
 * a deep-navy → blue brand gradient, a decorative forecasting motif (history →
 * forecast horizon / confidence band / demand signal …), a stage icon, and an
 * optional KPI ribbon + planning-status indicators.
 *
 * Backward compatible: the original `{ step, title, subtitle }` API still works.
 * Purely presentational — no data, no logic.
 */

export interface HeroMetric {
  label: string;
  value: string;
  /** Optional sub-text under the value (e.g. "12-month horizon"). */
  hint?: string;
}

interface WorkflowHeroProps {
  /** Eyebrow text, e.g. "Step 4 · Forecast". */
  step: string;
  title: string;
  subtitle: string;
  /** Stage icon shown in the brand chip. */
  icon?: LucideIcon;
  /** Decorative forecasting motif behind the content. */
  variant?: MotifVariant;
  /** KPI ribbon rendered along the bottom of the hero. */
  metrics?: HeroMetric[];
  /** Right-aligned status pills (e.g. "Plan locked", "3 SKUs flagged"). */
  status?: React.ReactNode;
  className?: string;
}

export function WorkflowHero({
  step,
  title,
  subtitle,
  icon: Icon,
  variant = "horizon",
  metrics,
  status,
  className,
}: WorkflowHeroProps) {
  return (
    <section
      className={cn(
        "hero-gradient relative isolate overflow-hidden rounded-xl border border-white/10 text-white shadow-[var(--shadow-md)]",
        className,
      )}
    >
      {/* Decorative forecasting motif — low opacity, theme-aware. */}
      <ForecastMotif
        variant={variant}
        className="absolute inset-y-0 right-0 z-0 hidden h-full w-2/3 text-white/25 sm:block"
      />
      {/* Soft brand glow + left fade so text stays legible over the motif. */}
      <div
        className="pointer-events-none absolute inset-0 z-0"
        aria-hidden
        style={{
          background:
            "linear-gradient(90deg, hsl(var(--hero-from)) 8%, hsl(var(--hero-from) / 0.65) 42%, transparent 78%)",
        }}
      />
      <div
        className="pointer-events-none absolute -right-16 -top-20 z-0 size-72 rounded-full opacity-40 blur-3xl"
        aria-hidden
        style={{ background: "radial-gradient(circle, hsl(var(--brand-accent) / 0.35), transparent 70%)" }}
      />

      <div className="relative z-10 flex flex-col gap-5 px-6 py-6">
        <div className="flex items-start gap-4">
          {Icon ? (
            <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-xl border border-white/20 bg-white/10 text-white backdrop-blur-sm">
              <Icon className="size-5" />
            </span>
          ) : (
            <span
              className="mt-1 h-10 w-1.5 shrink-0 rounded-full"
              style={{ background: "linear-gradient(to bottom, #ffffff, hsl(var(--brand-accent)))" }}
              aria-hidden
            />
          )}
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">
              {step}
            </p>
            <h1 className="text-2xl font-bold tracking-tight text-white">{title}</h1>
            <p className="max-w-2xl text-sm leading-relaxed text-white/80">{subtitle}</p>
          </div>
          {status ? (
            <div className="hidden shrink-0 items-center gap-2 md:flex">{status}</div>
          ) : null}
        </div>

        {metrics?.length ? (
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-white/10 bg-white/5 sm:grid-cols-4">
            {metrics.map((m) => (
              <div key={m.label} className="bg-transparent px-4 py-3">
                <dt className="text-[11px] font-medium uppercase tracking-wide text-white/60">
                  {m.label}
                </dt>
                <dd className="mt-1 text-lg font-semibold tabular-nums text-white">
                  {m.value}
                </dd>
                {m.hint ? (
                  <dd className="text-[11px] text-white/55">{m.hint}</dd>
                ) : null}
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </section>
  );
}

/** Small planning-status pill for the hero's `status` slot. */
export function HeroStatusPill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "accent" | "positive";
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "accent"
      ? "border-white/25 bg-[hsl(var(--brand-accent)/0.22)] text-white"
      : tone === "positive"
        ? "border-white/25 bg-white/15 text-white"
        : "border-white/15 bg-white/10 text-white/85";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium backdrop-blur-sm",
        toneClass,
      )}
    >
      {children}
    </span>
  );
}
