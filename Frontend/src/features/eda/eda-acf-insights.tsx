"use client";

import { useMemo } from "react";
import { Activity, CalendarRange, Waves } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { EdaAcfPoint } from "@/types/eda";

/**
 * Phase X.C · Task 1 — surfaces the backend ACF/PACF results as readable cards:
 * significant lags, detected seasonality, and the recommended seasonal period.
 * It does NOT recompute autocorrelation — it reads the backend `autocorrelation`
 * / `partialAutocorrelation` arrays and only derives which lags clear the 95%
 * significance band (±1.96/√n) for display.
 */
export function EdaAcfInsights({
  acf,
  pacf,
  nPeriods,
}: {
  acf: EdaAcfPoint[];
  pacf: EdaAcfPoint[];
  nPeriods: number;
}) {
  const { sigAcf, sigPacf, period, thr } = useMemo(() => {
    const n = Math.max(nPeriods || 0, acf?.length ?? 0);
    const t = n > 0 ? 1.96 / Math.sqrt(n) : 0.5;
    const sig = (arr: EdaAcfPoint[]) =>
      (arr ?? [])
        .filter((p) => p.lag >= 1 && p.value != null && Math.abs(p.value as number) > t)
        .sort((a, b) => Math.abs(b.value as number) - Math.abs(a.value as number));
    const sa = sig(acf);
    const sp = sig(pacf);
    // Seasonal period = strongest POSITIVE ACF at lag ≥ 2 above the band.
    const seasonal = (acf ?? [])
      .filter((p) => p.lag >= 2 && p.value != null && (p.value as number) > t)
      .sort((a, b) => (b.value as number) - (a.value as number));
    return { sigAcf: sa, sigPacf: sp, period: seasonal[0]?.lag ?? null, thr: t };
  }, [acf, pacf, nPeriods]);

  const fmt = (v: number | null) => (v == null ? "—" : (v as number).toFixed(2));

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <Card>
        <CardContent className="space-y-2 pt-5">
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
            <Activity className="size-3.5 text-primary" /> Significant Lags
          </p>
          {sigAcf.length ? (
            <>
              <p className="text-2xl font-semibold tabular-nums text-foreground">{sigAcf.length}</p>
              <div className="flex flex-wrap gap-1.5">
                {sigAcf.slice(0, 6).map((p) => (
                  <span key={`acf-${p.lag}`} className="rounded bg-secondary px-1.5 py-0.5 text-[0.7rem] text-foreground">
                    Lag {p.lag}: ACF&nbsp;{fmt(p.value)}
                  </span>
                ))}
                {sigPacf[0] ? (
                  <span className="rounded bg-secondary px-1.5 py-0.5 text-[0.7rem] text-foreground">
                    Lag {sigPacf[0].lag}: PACF&nbsp;{fmt(sigPacf[0].value)}
                  </span>
                ) : null}
              </div>
              <p className="text-[0.7rem] text-muted-foreground">
                |value| above the 95% band (±{thr.toFixed(2)}).
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No lags clear the 95% band.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 pt-5">
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
            <Waves className="size-3.5 text-primary" /> Seasonality
          </p>
          <p className="text-2xl font-semibold text-foreground">{period ? "Detected" : "Not detected"}</p>
          <p className="text-[0.7rem] text-muted-foreground">
            {period
              ? `Strong autocorrelation repeats every ${period} periods.`
              : "No repeating autocorrelation peak above the band."}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 pt-5">
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
            <CalendarRange className="size-3.5 text-primary" /> Recommended Seasonal Period
          </p>
          <p className="text-2xl font-semibold tabular-nums text-foreground">
            {period ? `${period}` : "—"}
            {period ? <span className="ml-1 text-sm font-normal text-muted-foreground">periods</span> : null}
          </p>
          <p className="text-[0.7rem] text-muted-foreground">From the dominant ACF lag (≥ 2).</p>
        </CardContent>
      </Card>
    </div>
  );
}
