"use client";

import { useEffect, useId, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * The Time Lens analog clock FACE — a single reusable, real-time animated SVG used
 * everywhere the brand clock appears (header `PremiumLiveClock`, login card, …).
 * It shows IST (Asia/Kolkata) with smoothly-creeping hour/minute/second hands. The
 * orange outer ring is a STATIC decorative element (a full 360° circle) — it does
 * not rotate, animate, or depend on the time; only the hands move.
 *
 * Performance: one requestAnimationFrame loop drives the SVG via refs (zero React
 * re-renders). Colours inherit `currentColor` (theme-aware) + the brand accent, so
 * a parent sets the hand/dial colour by setting text colour. Filter ids are
 * namespaced per instance (useId) so the component can mount multiple times
 * without clashing SVG `<filter>`/gradient ids.
 */

const R = 46; // outer ring radius (viewBox 100×100)

// One formatter, reused — always Asia/Kolkata (never browser local / UTC).
const IST = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour12: false,
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export interface IstNow {
  h: number;
  m: number;
  s: number; // fractional seconds for a smooth sweep
  weekday: string;
  day: string;
  month: string;
  year: string;
}

export function istNow(): IstNow {
  const now = new Date();
  const parts = IST.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // Seconds + millis are timezone-independent (IST offset is whole-minute), so
  // pairing IST hour/minute with the wall-clock sub-second is exact + smooth.
  const s = now.getSeconds() + now.getMilliseconds() / 1000;
  return {
    h: Number(get("hour")) % 24,
    m: Number(get("minute")),
    s,
    weekday: get("weekday"),
    day: get("day"),
    month: get("month"),
    year: get("year"),
  };
}

export function AnalogClock({ className }: { className?: string }) {
  const hourRef = useRef<SVGLineElement>(null);
  const minRef = useRef<SVGLineElement>(null);
  const secRef = useRef<SVGLineElement>(null);

  // Per-instance, selector-safe ids (drop the colons React's useId emits).
  const uid = useId().replace(/:/g, "");
  const id = (n: string) => `${uid}-${n}`;

  useEffect(() => {
    let raf = 0;
    const frame = () => {
      const { h, m, s } = istNow();
      // Include the sub-minute term so the hands creep CONTINUOUSLY rather than
      // ticking once a minute — smooth, non-jerky. (The outer ring is static.)
      const hourA = ((h % 12) + m / 60 + s / 3600) * 30;
      const minA = (m + s / 60) * 6;
      const secA = s * 6;

      hourRef.current?.setAttribute("transform", `rotate(${hourA} 50 50)`);
      minRef.current?.setAttribute("transform", `rotate(${minA} 50 50)`);
      secRef.current?.setAttribute("transform", `rotate(${secA} 50 50)`);

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <svg
      viewBox="0 0 100 100"
      className={cn("shrink-0", className)}
      shapeRendering="geometricPrecision"
      role="img"
      aria-label="Time Lens clock"
    >
      <defs>
        {/* Drop shadow beneath the hands. */}
        <filter id={id("hand-shadow")} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="0.6" stdDeviation="0.8" floodColor="#000" floodOpacity="0.45" />
        </filter>
        {/* Soft glow for the center hub (blur halo behind the sharp source). */}
        <filter id={id("glow")} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="1.6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* Inner glow / depth on the dial. */}
        <radialGradient id={id("dial")} cx="50%" cy="42%" r="60%">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.10" />
          <stop offset="70%" stopColor="currentColor" stopOpacity="0.02" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.18" />
        </radialGradient>
        {/* Glass reflection sheen across the top. */}
        <linearGradient id={id("sheen")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="45%" stopColor="currentColor" stopOpacity="0.05" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Outer ring — a STATIC full 360° orange circle (decorative only). It never
          rotates, animates, or depends on the time. Consistent thickness, no gaps,
          no progress/arc behaviour. */}
      <circle
        cx="50"
        cy="50"
        r={R}
        fill="none"
        stroke="hsl(var(--brand-accent))"
        strokeWidth="5.5"
      />

      {/* Dial + inner glow + radial command grid. */}
      <circle cx="50" cy="50" r="39" fill="hsl(201 60% 9% / 0.5)" stroke="currentColor" strokeOpacity="0.12" strokeWidth="1" />
      <circle cx="50" cy="50" r="39" fill={`url(#${id("dial")})`} />
      <g stroke="currentColor" strokeOpacity="0.10" strokeWidth="0.6" fill="none">
        <circle cx="50" cy="50" r="26" />
        <circle cx="50" cy="50" r="13" />
        <line x1="11" y1="50" x2="89" y2="50" />
        <line x1="50" y1="11" x2="50" y2="89" />
      </g>
      {/* Horizon arc — a forecasting "instrument" sweep across the lower dial. */}
      <path d="M16,58 Q50,40 84,58" fill="none" stroke="hsl(var(--brand-accent))" strokeOpacity="0.45" strokeWidth="1" strokeLinecap="round" />

      {/* Premium tick marks — 12 ticks, quarters bolder/longer. */}
      {Array.from({ length: 12 }).map((_, i) => {
        const major = i % 3 === 0;
        return (
          <line
            key={i}
            x1="50"
            y1={major ? 14 : 15.5}
            x2="50"
            y2={major ? 20 : 18}
            stroke="currentColor"
            strokeOpacity={major ? 0.6 : 0.3}
            strokeWidth={major ? 1.8 : 1}
            strokeLinecap="round"
            transform={`rotate(${i * 30} 50 50)`}
          />
        );
      })}

      {/* Hands (shadowed). */}
      <g filter={`url(#${id("hand-shadow")})`}>
        <line ref={hourRef} x1="50" y1="52" x2="50" y2="30" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" transform="rotate(0 50 50)" />
        <line ref={minRef} x1="50" y1="53" x2="50" y2="21" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" transform="rotate(0 50 50)" />
        <line ref={secRef} x1="50" y1="56" x2="50" y2="17" stroke="hsl(var(--brand-accent))" strokeWidth="1.3" strokeLinecap="round" transform="rotate(0 50 50)" />
      </g>

      {/* Glowing center hub. */}
      <circle cx="50" cy="50" r="5" fill="hsl(var(--brand-accent) / 0.30)" filter={`url(#${id("glow")})`} />
      <circle cx="50" cy="50" r="2.4" fill="currentColor" />
      <circle cx="50" cy="50" r="1" fill="hsl(var(--brand-accent))" />

      {/* Glass reflection sheen. */}
      <path d="M18,30 Q50,16 82,30 Q50,40 18,30 Z" fill={`url(#${id("sheen")})`} opacity="0.5" />
    </svg>
  );
}
