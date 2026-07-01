"use client";

import { useEffect, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AnalogClock, istNow } from "@/components/common/analog-clock";

/**
 * Premium live analog clock (IST / Asia/Kolkata) for the global header — a
 * forecasting "control tower" element. Wraps the shared <AnalogClock> face (the
 * real-time animated SVG used app-wide) with the brand label + a live hover
 * tooltip. The header lives in the persistent app layout so the clock keeps
 * running across route + theme changes.
 */

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
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="group flex cursor-default items-center gap-2 rounded-lg px-1 py-0.5 text-white transition-all duration-200 hover:scale-[1.02]"
          aria-label="Current time, India Standard Time"
          role="img"
        >
          <AnalogClock className="size-10 drop-shadow-sm sm:size-12 lg:size-[56px]" />

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
