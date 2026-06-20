"use client";

import { useEffect, useRef, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Premium live analog clock (IST / Asia/Kolkata) for the global header — a
 * forecasting "control tower" element. Frosted-glass capsule with an animated
 * day-progress ring, smooth analog hands, a glowing hub, and a compact digital
 * readout, plus a live hover tooltip.
 *
 * Performance: a single requestAnimationFrame loop drives the SVG via refs
 * (transform / stroke-dashoffset) and writes the digital text only when the
 * minute changes — so it animates smoothly with ZERO React re-renders. The loop
 * is cancelled on unmount; the header lives in the persistent app layout so the
 * clock keeps running across route + theme changes.
 */

const R = 46; // day-progress ring radius (viewBox 100×100)
const RING_C = 2 * Math.PI * R;

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

interface IstNow {
  h: number;
  m: number;
  s: number; // fractional seconds for a smooth sweep
  weekday: string;
  day: string;
  month: string;
  year: string;
}

function istNow(): IstNow {
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

/** Live tooltip body — mounts only while hovered (Radix), 1s self-update. */
function ClockTooltipBody() {
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const t = istNow();
  const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
  return (
    <div className="min-w-[172px] space-y-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-accent">
        Current Time (IST)
      </p>
      <div className="space-y-0.5">
        <p className="text-sm font-semibold leading-tight text-popover-foreground">{t.weekday}</p>
        <p className="text-xs text-muted-foreground">{`${t.day} ${t.month} ${t.year}`}</p>
      </div>
      <p className="font-mono text-lg font-semibold tabular-nums leading-none text-popover-foreground">
        {`${pad(t.h)}:${pad(t.m)}:${pad(t.s)}`}
      </p>
      <p className="flex items-center gap-1.5 border-t border-border/60 pt-1.5 text-[11px] text-muted-foreground">
        <span className="size-1.5 rounded-full bg-success" aria-hidden />
        Asia/Kolkata
      </p>
    </div>
  );
}

export function PremiumLiveClock() {
  const hourRef = useRef<SVGLineElement>(null);
  const minRef = useRef<SVGLineElement>(null);
  const secRef = useRef<SVGLineElement>(null);
  const ringRef = useRef<SVGCircleElement>(null);
  const pulseRef = useRef<SVGGElement>(null);

  useEffect(() => {
    let raf = 0;

    const frame = () => {
      const { h, m, s } = istNow();
      const hourA = ((h % 12) + m / 60) * 30;
      const minA = (m + s / 60) * 6;
      const secA = s * 6;

      hourRef.current?.setAttribute("transform", `rotate(${hourA} 50 50)`);
      minRef.current?.setAttribute("transform", `rotate(${minA} 50 50)`);
      secRef.current?.setAttribute("transform", `rotate(${secA} 50 50)`);

      // Day progress 00:00 → 24:00 around the outer ring + travelling pulse.
      const dayProgress = (h * 3600 + m * 60 + s) / 86400;
      if (ringRef.current) {
        ringRef.current.style.strokeDashoffset = String(RING_C * (1 - dayProgress));
      }
      pulseRef.current?.setAttribute("transform", `rotate(${dayProgress * 360} 50 50)`);

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="group flex cursor-default items-center gap-2 rounded-lg px-1 py-0.5 text-white transition-all duration-200 hover:scale-[1.02]"
          aria-label="Current time, India Standard Time"
          role="img"
        >
          {/* Analog face — colours inherit `currentColor` (theme-aware) + brand accent. */}
          <svg
            viewBox="0 0 100 100"
            className="size-10 shrink-0 drop-shadow-sm sm:size-12 lg:size-[56px]"
            shapeRendering="geometricPrecision"
          >
            <defs>
              {/* Drop shadow beneath the hands. */}
              <filter id="tl-hand-shadow" x="-30%" y="-30%" width="160%" height="160%">
                <feDropShadow dx="0" dy="0.6" stdDeviation="0.8" floodColor="#000" floodOpacity="0.45" />
              </filter>
              {/* Soft glow for the day-progress ring + pulse. */}
              <filter id="tl-glow" x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur stdDeviation="1.6" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              {/* Inner glow / depth on the dial. */}
              <radialGradient id="tl-dial" cx="50%" cy="42%" r="60%">
                <stop offset="0%" stopColor="currentColor" stopOpacity="0.10" />
                <stop offset="70%" stopColor="currentColor" stopOpacity="0.02" />
                <stop offset="100%" stopColor="#000" stopOpacity="0.18" />
              </radialGradient>
              {/* Glass reflection sheen across the top. */}
              <linearGradient id="tl-sheen" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
                <stop offset="45%" stopColor="currentColor" stopOpacity="0.05" />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* Day-progress ring: track + glowing progress (starts at 12 o'clock). */}
            <circle cx="50" cy="50" r={R} fill="none" stroke="currentColor" strokeOpacity="0.16" strokeWidth="5.5" />
            <circle
              ref={ringRef}
              cx="50"
              cy="50"
              r={R}
              fill="none"
              stroke="hsl(var(--brand-accent))"
              strokeWidth="5.5"
              strokeLinecap="round"
              strokeDasharray={RING_C}
              strokeDashoffset={RING_C}
              transform="rotate(-90 50 50)"
              filter="url(#tl-glow)"
            />

            {/* Dial + inner glow + radial command grid. */}
            <circle cx="50" cy="50" r="39" fill="hsl(201 60% 9% / 0.5)" stroke="currentColor" strokeOpacity="0.12" strokeWidth="1" />
            <circle cx="50" cy="50" r="39" fill="url(#tl-dial)" />
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

            {/* Travelling day-progress pulse on the ring. */}
            <g ref={pulseRef} transform="rotate(0 50 50)">
              <circle cx="50" cy={50 - R} r="2.6" fill="hsl(var(--brand-accent))" filter="url(#tl-glow)" className="anim-pulse-soft" />
            </g>

            {/* Hands (shadowed). */}
            <g filter="url(#tl-hand-shadow)">
              <line ref={hourRef} x1="50" y1="52" x2="50" y2="30" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" transform="rotate(0 50 50)" />
              <line ref={minRef} x1="50" y1="53" x2="50" y2="21" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" transform="rotate(0 50 50)" />
              <line ref={secRef} x1="50" y1="56" x2="50" y2="17" stroke="hsl(var(--brand-accent))" strokeWidth="1.3" strokeLinecap="round" transform="rotate(0 50 50)" />
            </g>

            {/* Glowing center hub. */}
            <circle cx="50" cy="50" r="5" fill="hsl(var(--brand-accent) / 0.30)" filter="url(#tl-glow)" />
            <circle cx="50" cy="50" r="2.4" fill="currentColor" />
            <circle cx="50" cy="50" r="1" fill="hsl(var(--brand-accent))" />

            {/* Glass reflection sheen. */}
            <path d="M18,30 Q50,16 82,30 Q50,40 18,30 Z" fill="url(#tl-sheen)" opacity="0.5" />
          </svg>

          {/* Brand label (replaces the digital readout) — hidden on mobile.
              Reads as an active command-center system indicator: ● TIME LENS. */}
          <span className="hidden h-7 w-px bg-white/30 sm:block" aria-hidden />
          <span className="hidden items-center gap-1.5 pr-1 sm:flex">
            <span
              className="size-1 rounded-full bg-[hsl(var(--brand-accent))] shadow-[0_0_6px_hsl(var(--brand-accent))]"
              aria-hidden
            />
            <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/80 transition-colors duration-200 group-hover:text-white sm:text-xs lg:text-sm">
              Time Lens
            </span>
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        <ClockTooltipBody />
      </TooltipContent>
    </Tooltip>
  );
}
