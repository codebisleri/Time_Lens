/**
 * Full-screen enterprise forecasting backdrop for the login page (F.9 1.2).
 * Lightweight animated SVG only — flowing demand/trend lines, a confidence band,
 * drifting network nodes, and a faint analytics grid. NO numbers, revenue, or
 * forecast outputs. Decorative (`aria-hidden`, pointer-events-none), and
 * animations auto-disable under prefers-reduced-motion.
 */
export function LoginBackdrop() {
  return (
    <div
      className="hero-gradient pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden
    >
      {/* Brand glow + analytics grid */}
      <div className="absolute inset-0 [background:radial-gradient(50%_40%_at_18%_12%,hsl(var(--brand-accent)/0.16),transparent_70%)]" />
      <div className="bg-analytics-grid absolute inset-0 opacity-40" />
      <div className="absolute -left-32 bottom-0 size-[34rem] rounded-full bg-[hsl(var(--brand)/0.25)] blur-3xl" />

      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 1200 800"
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          <linearGradient id="tl-band" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--brand-accent))" stopOpacity="0.18" />
            <stop offset="100%" stopColor="hsl(var(--brand-accent))" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Confidence band around the forecast curve */}
        <path
          className="anim-pulse-soft"
          d="M0,520 C200,470 360,430 540,440 C740,452 920,360 1200,330 L1200,470 C920,500 740,560 540,560 C360,560 200,600 0,640 Z"
          fill="url(#tl-band)"
        />

        {/* Historical demand (brand blue, flowing) */}
        <path
          className="anim-dash"
          d="M0,560 C160,540 300,520 460,524 C620,528 720,500 860,470 C1000,440 1100,420 1200,400"
          fill="none"
          stroke="hsl(201 80% 70% / 0.75)"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        {/* Forecast horizon (accent, flowing faster) */}
        <path
          className="anim-dash-slow"
          d="M0,470 C200,440 360,400 540,405 C740,410 920,330 1200,300"
          fill="none"
          stroke="hsl(var(--brand-accent))"
          strokeWidth="2.5"
          strokeLinecap="round"
        />

        {/* Supply-chain network nodes + links (drifting) */}
        <g className="anim-float" stroke="hsl(0 0% 100% / 0.18)" strokeWidth="1">
          <line x1="180" y1="200" x2="360" y2="150" />
          <line x1="360" y1="150" x2="520" y2="240" />
          <line x1="520" y1="240" x2="720" y2="170" />
          <line x1="720" y1="170" x2="940" y2="220" />
        </g>
        <g className="anim-float" fill="hsl(0 0% 100% / 0.5)">
          <circle cx="180" cy="200" r="3.5" />
          <circle cx="360" cy="150" r="3.5" />
          <circle cx="520" cy="240" r="3.5" />
          <circle cx="720" cy="170" r="3.5" />
          <circle cx="940" cy="220" r="3.5" />
        </g>
        <g fill="hsl(var(--brand-accent))">
          <circle className="anim-pulse-soft" cx="540" cy="405" r="4" />
          <circle className="anim-pulse-soft" cx="1200" cy="300" r="4" />
        </g>
      </svg>

      {/* Left-edge scrim so the backdrop never competes with the card */}
      <div className="absolute inset-0 bg-gradient-to-r from-[hsl(var(--hero-from)/0.4)] via-transparent to-[hsl(var(--hero-from)/0.4)]" />
    </div>
  );
}
