import { cn } from "@/lib/utils";

/**
 * Forecasting visual language — reusable, theme-aware SVG motifs.
 *
 * These are the in-app counterparts of the static assets in
 * `/public/branding/*.svg`. They are inline SVG so they can inherit the parent
 * text color via `currentColor` (the primary stroke) and the brand-accent token
 * (the forecast / "future" accent). They are purely decorative — `aria-hidden`,
 * `pointer-events-none` — and meant to sit low-opacity behind content to give
 * every surface a demand-forecasting identity (history → forecast horizon,
 * confidence bands, demand signal, planning timeline, supply network).
 *
 * Usage: place inside a `relative` container and put real content in a sibling
 * with a higher stacking context. Tune presence with `className` opacity, e.g.
 *   <ForecastMotif variant="horizon" className="text-white/30" />
 */

export type MotifVariant =
  | "horizon"
  | "band"
  | "signal"
  | "grid"
  | "timeline"
  | "network"
  | "curve";

const ACCENT = "hsl(var(--brand-accent))";

interface MotifProps {
  variant?: MotifVariant;
  className?: string;
}

function HorizonMotif() {
  return (
    <svg viewBox="0 0 800 360" fill="none" preserveAspectRatio="xMidYMid slice" className="h-full w-full">
      {/* forecast horizon shading */}
      <rect x="470" y="20" width="330" height="300" fill={ACCENT} fillOpacity="0.08" />
      <line x1="470" y1="14" x2="470" y2="326" stroke={ACCENT} strokeWidth="1.5" strokeDasharray="4 5" strokeOpacity="0.7" />
      {/* confidence band */}
      <path d="M470 196 C 545 150, 620 150, 700 110 L 800 84 L 800 210 L 700 176 C 620 214, 545 224, 470 236 Z" fill={ACCENT} fillOpacity="0.10" />
      {/* actual history */}
      <path d="M0 250 C 70 235, 110 210, 160 220 C 210 230, 250 180, 300 188 C 350 196, 410 168, 470 196" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      {/* forecast */}
      <path d="M470 196 C 545 150, 620 150, 700 130 L 800 116" stroke={ACCENT} strokeWidth="3" strokeLinecap="round" strokeDasharray="2 9" />
      <circle cx="470" cy="196" r="4.5" fill={ACCENT} />
    </svg>
  );
}

function BandMotif() {
  return (
    <svg viewBox="0 0 800 360" fill="none" preserveAspectRatio="xMidYMid slice" className="h-full w-full">
      <path d="M0 200 C 180 188, 360 150, 560 92 C 660 64, 740 52, 800 46 L 800 150 C 740 150, 660 156, 560 176 C 360 214, 180 232, 0 232 Z" fill="currentColor" fillOpacity="0.12" />
      <path d="M0 208 C 180 198, 360 166, 560 120 C 660 98, 740 90, 800 86 L 800 122 C 740 124, 660 130, 560 148 C 360 192, 180 216, 0 220 Z" fill="currentColor" fillOpacity="0.16" />
      <path d="M0 214 C 180 206, 360 178, 560 134 C 660 112, 740 102, 800 100" stroke={ACCENT} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function SignalMotif() {
  return (
    <svg viewBox="0 0 800 300" fill="none" preserveAspectRatio="xMidYMid slice" className="h-full w-full">
      <g fill="currentColor" fillOpacity="0.18">
        <rect x="40" y="170" width="34" height="90" rx="3" />
        <rect x="100" y="140" width="34" height="120" rx="3" />
        <rect x="160" y="190" width="34" height="70" rx="3" />
        <rect x="220" y="120" width="34" height="140" rx="3" />
        <rect x="280" y="150" width="34" height="110" rx="3" />
        <rect x="340" y="100" width="34" height="160" rx="3" />
      </g>
      <g fill={ACCENT} fillOpacity="0.14" stroke={ACCENT} strokeOpacity="0.6" strokeWidth="1.5">
        <rect x="400" y="110" width="34" height="150" rx="3" />
        <rect x="460" y="90" width="34" height="170" rx="3" />
        <rect x="520" y="120" width="34" height="140" rx="3" />
        <rect x="580" y="80" width="34" height="180" rx="3" />
        <rect x="640" y="100" width="34" height="160" rx="3" />
        <rect x="700" y="70" width="34" height="190" rx="3" />
      </g>
      <path d="M57 165 L117 135 L177 185 L237 115 L297 145 L357 95 L417 105 L477 85 L537 115 L597 75 L657 95 L717 65" stroke={ACCENT} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function GridMotif() {
  return (
    <svg viewBox="0 0 800 400" fill="none" preserveAspectRatio="xMidYMid slice" className="h-full w-full">
      <defs>
        <pattern id="fm-grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M40 0 L0 0 0 40" fill="none" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="800" height="400" fill="url(#fm-grid)" />
      <line x1="60" y1="300" x2="740" y2="110" stroke={ACCENT} strokeWidth="2" strokeOpacity="0.7" strokeDasharray="6 6" />
      <g fill="currentColor">
        <circle cx="220" cy="240" r="5" />
        <circle cx="380" cy="190" r="6" />
        <circle cx="540" cy="150" r="5" />
      </g>
      <g fill={ACCENT}>
        <circle cx="300" cy="260" r="4" />
        <circle cx="460" cy="210" r="4" />
        <circle cx="620" cy="170" r="4" />
      </g>
    </svg>
  );
}

function TimelineMotif() {
  return (
    <svg viewBox="0 0 800 200" fill="none" preserveAspectRatio="xMidYMid slice" className="h-full w-full">
      <line x1="20" y1="100" x2="780" y2="100" stroke="currentColor" strokeOpacity="0.35" strokeWidth="2" />
      <rect x="490" y="60" width="290" height="80" fill={ACCENT} fillOpacity="0.06" />
      <g fill="currentColor">
        <circle cx="90" cy="100" r="7" />
        <circle cx="250" cy="100" r="7" />
        <circle cx="410" cy="100" r="7" />
      </g>
      <circle cx="490" cy="100" r="10" fill={ACCENT} />
      <circle cx="490" cy="100" r="16" fill="none" stroke={ACCENT} strokeOpacity="0.5" strokeWidth="1.5" />
      <g fill="none" stroke={ACCENT} strokeWidth="2">
        <circle cx="610" cy="100" r="7" />
        <circle cx="710" cy="100" r="7" />
      </g>
    </svg>
  );
}

function NetworkMotif() {
  return (
    <svg viewBox="0 0 800 400" fill="none" preserveAspectRatio="xMidYMid slice" className="h-full w-full">
      <g stroke="currentColor" strokeOpacity="0.30" strokeWidth="1.5">
        <line x1="120" y1="200" x2="320" y2="110" />
        <line x1="120" y1="200" x2="320" y2="290" />
        <line x1="320" y1="110" x2="520" y2="200" />
        <line x1="320" y1="290" x2="520" y2="200" />
        <line x1="520" y1="200" x2="680" y2="160" />
        <line x1="320" y1="110" x2="520" y2="80" />
        <line x1="320" y1="290" x2="520" y2="320" />
      </g>
      <g stroke={ACCENT} strokeOpacity="0.6" strokeWidth="2" strokeDasharray="3 7">
        <line x1="120" y1="200" x2="320" y2="110" />
        <line x1="320" y1="110" x2="520" y2="200" />
        <line x1="520" y1="200" x2="680" y2="160" />
      </g>
      <g fill="currentColor" fillOpacity="0.9">
        <circle cx="120" cy="200" r="9" />
        <circle cx="320" cy="110" r="7" />
        <circle cx="320" cy="290" r="7" />
        <circle cx="680" cy="160" r="7" />
      </g>
      <circle cx="520" cy="200" r="10" fill={ACCENT} />
    </svg>
  );
}

function CurveMotif() {
  return (
    <svg viewBox="0 0 800 360" fill="none" preserveAspectRatio="xMidYMid slice" className="h-full w-full">
      <path d="M0 280 C 90 250, 130 300, 220 250 C 310 200, 360 260, 460 210 C 560 160, 620 220, 720 170 C 760 150, 790 158, 800 154 L 800 360 L 0 360 Z" fill="currentColor" fillOpacity="0.10" />
      <path d="M0 280 C 90 250, 130 300, 220 250 C 310 200, 360 260, 460 210 C 560 160, 620 220, 720 170 C 760 150, 790 158, 800 154" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M0 320 C 100 300, 150 330, 250 300 C 350 270, 420 310, 520 280 C 620 250, 700 290, 800 260" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" strokeOpacity="0.85" />
    </svg>
  );
}

const MOTIFS: Record<MotifVariant, () => React.JSX.Element> = {
  horizon: HorizonMotif,
  band: BandMotif,
  signal: SignalMotif,
  grid: GridMotif,
  timeline: TimelineMotif,
  network: NetworkMotif,
  curve: CurveMotif,
};

/**
 * Decorative forecasting motif. Renders an inline, theme-aware SVG that inherits
 * the parent's `currentColor` for its primary strokes and the brand-accent token
 * for the forecast accent. Always non-interactive and hidden from assistive tech.
 */
export function ForecastMotif({ variant = "horizon", className }: MotifProps) {
  const Motif = MOTIFS[variant];
  return (
    <div className={cn("pointer-events-none select-none", className)} aria-hidden>
      <Motif />
    </div>
  );
}
