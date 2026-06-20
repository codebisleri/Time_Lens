"use client";

import { motion } from "framer-motion";

/**
 * Confidential AI "prediction engine" backdrop for the login experience (F.15B).
 * Purely ABSTRACT, decorative motion — NO business data, charts, KPIs, or values.
 * Layered: animated dark gradient · subtle grid · moving prediction paths · time
 * waves · neural-network nodes · forecast trajectories · expanding clock/time
 * rings · glowing depth particles. SVG + CSS keyframes (anim-*) + framer-motion;
 * no ECharts. Decorative only (aria-hidden, pointer-events-none).
 */

// Deterministic particle field (no Math.random → no hydration mismatch). Depth
// via size + opacity (larger/brighter = "closer").
const PARTICLES = [
  { top: "14%", left: "12%", size: 7, op: 0.8, accent: true, delay: 0 },
  { top: "22%", left: "70%", size: 4, op: 0.5, accent: false, delay: 1.1 },
  { top: "38%", left: "26%", size: 5, op: 0.6, accent: false, delay: 2.0 },
  { top: "30%", left: "52%", size: 3, op: 0.4, accent: true, delay: 0.5 },
  { top: "62%", left: "16%", size: 6, op: 0.7, accent: false, delay: 1.6 },
  { top: "54%", left: "80%", size: 4, op: 0.5, accent: true, delay: 0.9 },
  { top: "74%", left: "40%", size: 5, op: 0.6, accent: false, delay: 2.4 },
  { top: "84%", left: "66%", size: 7, op: 0.75, accent: true, delay: 0.3 },
  { top: "46%", left: "92%", size: 3, op: 0.4, accent: false, delay: 1.9 },
  { top: "10%", left: "44%", size: 4, op: 0.5, accent: false, delay: 1.3 },
  { top: "90%", left: "24%", size: 3, op: 0.4, accent: true, delay: 2.2 },
  { top: "68%", left: "58%", size: 5, op: 0.55, accent: false, delay: 0.7 },
];

// Neural-network node positions (viewBox 0..1200 × 0..800) + abstract links.
const NODES = [
  [180, 200], [360, 150], [300, 320], [520, 240], [480, 420],
  [700, 180], [680, 360], [900, 260], [860, 460], [1060, 340],
] as const;
const LINKS: [number, number][] = [
  [0, 1], [0, 2], [1, 3], [2, 3], [2, 4], [3, 5], [4, 6],
  [3, 6], [5, 7], [6, 7], [6, 8], [7, 9], [8, 9],
];

export function LoginAura() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {/* Layer 1 — animated dark gradient base + slowly pulsing accent glows. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(130% 130% at 78% -10%, #163654 0%, #10243C 42%, #07111D 74%, #020817 100%)",
        }}
      />
      <motion.div
        className="absolute -left-40 top-1/3 size-[42rem] rounded-full blur-3xl"
        style={{ background: "rgba(239,118,2,0.10)" }}
        animate={{ opacity: [0.5, 0.9, 0.5], scale: [1, 1.08, 1] }}
        transition={{ duration: 12, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute -right-24 -top-24 size-[34rem] rounded-full blur-3xl"
        style={{ background: "rgba(239,118,2,0.12)" }}
        animate={{ opacity: [0.6, 1, 0.6], scale: [1, 1.1, 1] }}
        transition={{ duration: 10, repeat: Infinity, ease: "easeInOut", delay: 1.5 }}
      />
      <motion.div
        className="absolute bottom-[-10rem] left-1/2 size-[40rem] -translate-x-1/2 rounded-full blur-3xl"
        style={{ background: "rgba(255,255,255,0.05)" }}
        animate={{ opacity: [0.4, 0.7, 0.4] }}
        transition={{ duration: 14, repeat: Infinity, ease: "easeInOut", delay: 0.8 }}
      />

      {/* Layer 2 — subtle grid. */}
      <div className="bg-analytics-grid absolute inset-0 opacity-[0.18]" />

      {/* Layers 3–5 — prediction paths, time waves, forecast trajectories, nodes. */}
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 1200 800"
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          <radialGradient id="tl-node-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Time waves — slow horizontal curves, 5–10% opacity. */}
        <path
          className="anim-dash-slow"
          d="M-50,300 C200,250 400,360 650,300 C880,245 1050,330 1250,290"
          fill="none"
          stroke="#ffffff"
          strokeOpacity="0.08"
          strokeWidth="2"
        />
        <path
          className="anim-dash-slow"
          d="M-50,470 C220,420 420,520 660,460 C900,405 1060,480 1250,450"
          fill="none"
          stroke="#EF7602"
          strokeOpacity="0.07"
          strokeWidth="2"
        />

        {/* Prediction paths — flowing, faint. */}
        <path
          className="anim-dash"
          d="M-50,600 C180,560 360,540 560,560 C760,580 940,500 1250,470"
          fill="none"
          stroke="#ffffff"
          strokeOpacity="0.10"
          strokeWidth="1.6"
        />

        {/* Forecast trajectories — abstract dashed lines (NO values). */}
        <path
          className="anim-dash"
          d="M-50,520 C260,480 460,420 700,430 C920,440 1080,360 1250,330"
          fill="none"
          stroke="#EF7602"
          strokeOpacity="0.12"
          strokeWidth="1.8"
          strokeDasharray="2 12"
        />

        {/* Neural-network nodes + links. */}
        <g stroke="#ffffff" strokeOpacity="0.10" strokeWidth="1">
          {LINKS.map(([a, b], i) => (
            <line
              key={i}
              x1={NODES[a]![0]} y1={NODES[a]![1]}
              x2={NODES[b]![0]} y2={NODES[b]![1]}
            />
          ))}
        </g>
        {NODES.map(([x, y], i) => (
          <g key={i}>
            <circle cx={x} cy={y} r="16" fill="url(#tl-node-glow)" className="anim-pulse-soft" />
            <circle cx={x} cy={y} r="2.4" fill={i % 3 === 0 ? "#EF7602" : "#ffffff"} />
          </g>
        ))}
      </svg>

      {/* Layer 6 — expanding time / clock rings (orange glow), center-left. */}
      <div className="absolute left-[30%] top-[46%] hidden lg:block">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="absolute rounded-full border"
            style={{
              width: 140,
              height: 140,
              marginLeft: -70,
              marginTop: -70,
              borderColor: "rgba(239,118,2,0.45)",
              boxShadow: "0 0 30px rgba(239,118,2,0.25)",
            }}
            initial={{ scale: 0.3, opacity: 0.55 }}
            animate={{ scale: 2.6, opacity: 0 }}
            transition={{ duration: 7, repeat: Infinity, delay: i * 2.3, ease: "easeOut" }}
          />
        ))}
      </div>

      {/* Glowing depth particles. */}
      {PARTICLES.map((p, i) => (
        <span
          key={i}
          className="anim-float absolute rounded-full"
          style={{
            top: p.top,
            left: p.left,
            width: p.size,
            height: p.size,
            opacity: p.op,
            background: p.accent ? "#EF7602" : "#ffffff",
            boxShadow: p.accent
              ? "0 0 14px rgba(239,118,2,0.85)"
              : "0 0 14px rgba(255,255,255,0.55)",
            animationDelay: `${p.delay}s`,
          }}
        />
      ))}

      {/* Vignette to keep the card readable. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(80% 80% at 50% 50%, transparent 55%, rgba(2,8,23,0.55) 100%)",
        }}
      />
    </div>
  );
}
