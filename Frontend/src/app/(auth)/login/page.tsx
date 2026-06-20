import type { Metadata } from "next";
import { LoginExperience } from "@/features/auth/login-experience";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Enterprise login (F.15) — an immersive, motion-driven split-screen forecasting
 * experience: a 60% animated visualization panel (hero clock, demand/forecast
 * chart, count-up KPIs, rotating headline, particle/grid backdrop) beside a 40%
 * glassmorphism authentication card. All rendering lives in the client
 * LoginExperience component.
 */
export default function LoginPage() {
  return <LoginExperience />;
}
