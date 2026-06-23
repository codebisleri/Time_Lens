"use client";

import { Suspense } from "react";
import { motion } from "framer-motion";
import { ShieldCheck } from "lucide-react";
import { env } from "@/lib/constants/env";
import { DhishaaiWordmark, TimeLensLogo } from "@/components/common/brand";
import { PremiumLiveClock } from "@/components/layout/navbar/premium-live-clock";
import { LoginForm } from "./login-form";
import { LoginAura } from "./login-aura";

/**
 * Confidential AI login experience (F.15B). An immersive "prediction engine"
 * surface — abstract motion only (LoginAura), with ZERO business data: no charts,
 * KPIs, forecast values, SKUs, or dashboard previews. A 60% hero panel (large
 * animated Time Lens clock + brand) beside a 40% glassmorphism authentication
 * card. Deep-navy luxury palette, orange accent, framer-motion entrance.
 * Responsive: stacks on tablet/mobile with the login card first.
 */

const WORDS = ["Predict.", "Plan.", "Optimize."];

export function LoginExperience() {
  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-[#020817]">
      {/* The native window controls (WCO) overlay the top-right; this transparent
          strip makes the top of the window draggable since the login screen has
          no app header. Inert in the browser (`app-region` is Electron-only). */}
      <div className="app-drag absolute inset-x-0 top-0 z-30 h-10" aria-hidden />

      {/* Confidential abstract backdrop (no data). */}
      <LoginAura />

      <div className="relative z-10 flex min-h-screen flex-col lg:grid lg:grid-cols-[3fr_2fr]">
        {/* LEFT — confidential AI hero */}
        <section className="order-2 flex flex-col justify-center gap-8 px-6 py-12 sm:px-10 lg:order-1 lg:px-16">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          >
            <DhishaaiWordmark className="h-7 w-auto sm:h-8" plate />
          </motion.div>

          {/* Hero clock + identity */}
          <motion.div
            initial={{ opacity: 0, y: 22, filter: "blur(8px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.7, ease: "easeOut", delay: 0.1 }}
            className="flex items-center gap-5"
          >
            <div className="relative shrink-0">
              <span
                aria-hidden
                className="anim-pulse-soft pointer-events-none absolute -inset-6 rounded-full"
                style={{ background: "radial-gradient(circle, rgba(239,118,2,0.35), transparent 70%)" }}
              />
              <div className="relative origin-left scale-[1.35] sm:scale-[1.55]">
                <PremiumLiveClock />
              </div>
            </div>
          </motion.div>

          <div className="space-y-4">
            <motion.h1
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: "easeOut", delay: 0.2 }}
              className="text-5xl font-bold tracking-[0.12em] text-white sm:text-6xl"
            >
              TIME&nbsp;LENS
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.32 }}
              className="text-sm font-semibold uppercase tracking-[0.34em] text-[#FF9B3D]"
            >
              Demand Forecasting &amp; Planning Platform
            </motion.p>

            {/* Predict · Plan · Optimize — staggered words (no metrics). */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-2">
              {WORDS.map((w, i) => (
                <motion.span
                  key={w}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.5 + i * 0.18, ease: "easeOut" }}
                  className="text-2xl font-light tracking-wide text-white/80 sm:text-3xl"
                >
                  {w}
                </motion.span>
              ))}
            </div>

            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 1.0 }}
              className="max-w-md pt-3 text-sm leading-relaxed text-white/45"
            >
              An advanced demand-prediction engine. Sign in to access your
              forecasting workspace.
            </motion.p>
          </div>
        </section>

        {/* RIGHT — authentication card */}
        <section className="order-1 flex items-center justify-center px-6 py-12 sm:px-10 lg:order-2">
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.97, filter: "blur(10px)" }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            whileHover={{ y: -3 }}
            className="relative w-full max-w-md rounded-3xl"
            style={{
              background: "rgba(15,23,42,0.65)",
              border: "1px solid rgba(255,255,255,0.12)",
              backdropFilter: "blur(20px) saturate(1.2)",
              WebkitBackdropFilter: "blur(20px) saturate(1.2)",
              boxShadow: "0 40px 90px -32px rgba(0,0,0,0.9)",
            }}
          >
            {/* Subtle gradient border-glow. */}
            <div
              className="pointer-events-none absolute -inset-px rounded-3xl"
              aria-hidden
              style={{
                background:
                  "linear-gradient(140deg, rgba(239,118,2,0.40), transparent 42%, transparent 68%, rgba(255,255,255,0.14))",
                mask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
                WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
                WebkitMaskComposite: "xor",
                maskComposite: "exclude",
                padding: 1,
              }}
            />

            <div className="relative p-7 sm:p-9">
              <div className="mb-7 flex flex-col items-center gap-4 text-center">
                <span className="relative flex size-12 items-center justify-center rounded-2xl bg-white shadow-lg ring-1 ring-black/5">
                  <span
                    aria-hidden
                    className="anim-pulse-soft pointer-events-none absolute -inset-2 rounded-3xl"
                    style={{ background: "radial-gradient(circle, rgba(239,118,2,0.5), transparent 70%)" }}
                  />
                  <TimeLensLogo className="relative h-9 w-auto" />
                </span>
                <div className="space-y-1">
                  <h2 className="text-xl font-semibold tracking-tight text-white">
                    Sign in to {env.appName}
                  </h2>
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-[#FF9B3D]">
                    Secure Access
                  </p>
                </div>
              </div>

              <Suspense fallback={null}>
                <LoginForm />
              </Suspense>

              <div className="mt-6 flex items-center justify-center gap-1.5 text-[11px] text-white/45">
                <ShieldCheck className="size-3.5" />
                <span>
                  Powered by DhishaAI · {env.environment} · v{env.appVersion}
                </span>
              </div>
            </div>
          </motion.div>
        </section>
      </div>
    </div>
  );
}
