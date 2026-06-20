"use client";

import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { env } from "@/lib/constants/env";
import { useUiStore } from "@/lib/stores";
import { Button } from "@/components/ui/button";
import { DhishaaiWordmark } from "@/components/common/brand";
import { ForecastMotif } from "@/components/common/forecast-graphics";
import { PremiumLiveClock } from "./navbar/premium-live-clock";
import { ThemeToggle } from "./navbar/theme-toggle";
import { UserMenu } from "./navbar/user-menu";
import { CommandTrigger } from "./navbar/command-trigger";
import { WindowControls } from "./window-controls";

/**
 * Global enterprise product-identity header — the SINGLE branding location and
 * the recognizable "this is a forecasting platform" element. 72px, sticky, shown
 * on every screen (and, in `minimal` mode, on login).
 *
 *   [☰] DHISHAAI | TIME LENS · Enterprise Forecast Intelligence Platform
 *                       ‹ current module ›        🔎 🔔 ENV v2.0 ◐ ⚙ ◍
 *
 * Branding lives ONLY here (the sidebar no longer repeats the logo/title).
 * Purely presentational; no routing/auth/state logic.
 */

const MODULE_LABELS: { prefix: string; label: string }[] = [
  { prefix: "/forecast-submission", label: "Forecast Submission" },
  { prefix: "/forecasts", label: "Forecast Results" },
  { prefix: "/forecast", label: "Forecasting" },
  { prefix: "/data", label: "Input Data & Configuration" },
  { prefix: "/eda", label: "Exploratory Analysis" },
  { prefix: "/profile", label: "Profile & Route" },
  { prefix: "/performance", label: "Performance Analytics" },
  { prefix: "/scenarios", label: "Scenario Planning" },
  { prefix: "/report", label: "Reporting Center" },
  { prefix: "/dashboard", label: "Forecast Intelligence" },
  { prefix: "/skus", label: "SKU Management" },
];

function useModuleName(): string | null {
  const pathname = usePathname();
  const hit = MODULE_LABELS.find(
    (m) => pathname === m.prefix || pathname.startsWith(`${m.prefix}/`),
  );
  return hit?.label ?? null;
}

function IdentityBadges() {
  return (
    <>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/85">
        <span className="size-1.5 rounded-full bg-[hsl(var(--brand-accent))] shadow-[0_0_6px_hsl(var(--brand-accent))]" aria-hidden />
        {env.environment}
      </span>
      <span className="inline-flex items-center rounded-full border border-white/20 bg-white/10 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-white/90">
        v{env.appVersion}
      </span>
    </>
  );
}

/** DhishaAI logo + the premium live IST clock (the Time Lens logo is replaced by
 *  the clock; DhishaAI remains the single brand mark in the header). The clock is
 *  the platform's signature identity — set apart with a soft accent glow and a
 *  premium gradient separator (Forecast Control Tower feel). */
function BrandLockup() {
  return (
    <div className="flex min-w-0 items-center gap-3 sm:gap-4">
      <DhishaaiWordmark className="h-7 w-auto" plate />
      {/* Premium separator between parent brand and the platform clock. */}
      <span
        className="hidden h-8 w-px bg-gradient-to-b from-transparent via-white/35 to-transparent sm:block"
        aria-hidden
      />
      <div className="relative">
        {/* Soft accent glow behind the clock capsule. */}
        <span
          aria-hidden
          className="pointer-events-none absolute -inset-2 rounded-full bg-[radial-gradient(circle,hsl(var(--brand-accent)/0.20),transparent_70%)] blur-md"
        />
        <PremiumLiveClock />
      </div>
    </div>
  );
}

export function EnterpriseHeader({
  className,
  minimal = false,
}: {
  className?: string;
  minimal?: boolean;
}) {
  const setMobileNavOpen = useUiStore((s) => s.setMobileNavOpen);
  const moduleName = useModuleName();

  return (
    <header
      className={cn(
        // D.1 — this IS the native title bar: the whole header is the window drag
        // region; interactive children opt out with `app-no-drag`.
        "app-drag hero-gradient sticky top-0 z-40 flex h-[72px] items-center gap-3 overflow-hidden border-b border-white/10 pl-4 text-white elev-2",
        className,
      )}
    >
      {/* Forecasting motif — far right, low opacity. */}
      <ForecastMotif
        variant="signal"
        className="absolute inset-y-0 right-0 hidden h-full w-1/3 text-white/10 md:block"
      />
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden
        style={{
          background:
            "linear-gradient(90deg, hsl(var(--hero-from)) 28%, hsl(var(--hero-from) / 0.55) 60%, transparent 100%)",
        }}
      />

      {/* LEFT — mobile menu + brand lockup (single branding location) */}
      <div className="app-no-drag relative flex items-center gap-3">
        {!minimal ? (
          <Button
            variant="ghost"
            size="icon"
            className="text-white hover:bg-white/10 hover:text-white lg:hidden"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="size-5" />
          </Button>
        ) : null}
        <BrandLockup />
      </div>

      {/* CENTER — current module */}
      {!minimal && moduleName ? (
        <div className="relative mx-auto hidden items-center gap-2 md:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-brand-accent" aria-hidden />
          <span className="text-sm font-semibold uppercase tracking-[0.12em] text-white/90">
            {moduleName}
          </span>
        </div>
      ) : null}

      {/* RIGHT — controls + identity + native window controls */}
      <div className="app-no-drag relative ml-auto flex items-stretch gap-2 self-stretch pl-2">
        {minimal ? (
          <div className="flex items-center gap-2 pr-2">
            <IdentityBadges />
          </div>
        ) : (
          <div className="flex items-center gap-2 pr-2">
            <div className="hidden xl:block">
              <CommandTrigger />
            </div>
            <div className="hidden items-center gap-2 sm:flex">
              <IdentityBadges />
            </div>
            <span className="hidden h-6 w-px bg-white/20 sm:block" aria-hidden />
            <div className="text-white/85 [&_button:hover]:bg-white/10 [&_button:hover]:text-white [&_button]:text-white/85">
              <ThemeToggle />
            </div>
            {/* Settings, Profile, and Logout live in the account menu below
                (the standard, fully-wired location). */}
            <UserMenu />
          </div>
        )}
        {/* Native min/max/close — only renders inside the Electron shell. */}
        <WindowControls />
      </div>
    </header>
  );
}
