"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/feedback/empty-state";
import { useAsync } from "@/lib/hooks";
import { whatifService } from "@/lib/api/services";
import { formatDate } from "@/lib/utils/format";
import type { WhatIfGridResponse } from "@/types/whatif";

/** Resolved grid state lifted to the parent so "Run scenario" can send it. */
export interface WhatIfGridState {
  /** True once the scaffold (months + features) has loaded. */
  ready: boolean;
  /** Every editable cell parses to a finite number. */
  valid: boolean;
  /** Forecast-horizon months (ISO) the value columns map to. */
  months: string[];
  /** Per-feature ABSOLUTE values, one per month (parsed). */
  values: Record<string, number[]>;
}

const EMPTY_STATE: WhatIfGridState = { ready: false, valid: false, months: [], values: {} };

/** Parse one editable cell. Empty / NaN / non-numeric → null (invalid). */
function parseCell(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function monthLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso.slice(0, 7)
    : formatDate(iso, { month: "short", year: "numeric", day: undefined });
}

/**
 * TASK 2 — Editable What-If forecasting grid. Rows are the exogenous levers
 * (Feature), columns are the ACTUAL forecast months (dynamic, e.g. "Jul 2026"),
 * and every monthly cell is edited inline (spreadsheet-style — no popup/modal).
 * An "Apply to All Forecast Months" bulk editor sits above the table; individual
 * cells remain editable afterwards. Invalid cells are flagged inline without
 * breaking the table, and the resolved numeric state is lifted to the parent.
 */
export function WhatIfGrid({
  sku,
  features,
  onChange,
}: {
  sku: string;
  features: string[];
  onChange: (state: WhatIfGridState) => void;
}) {
  const grid = useAsync<WhatIfGridResponse | null>(
    () => (sku ? whatifService.whatifGrid(sku) : Promise.resolve(null)),
    [sku],
  );

  const months = useMemo(() => grid.data?.months ?? [], [grid.data]);
  const baselineByFeature = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of grid.data?.features ?? []) m.set(f.name, f.baseline);
    return m;
  }, [grid.data]);

  // TASK 1 — reuse the DoWhy causal-graph levers when the backend grid scaffold
  // can project them (intersection, graph order preserved). But the chosen
  // treatments may be engineered/calendar features (month, lag_*, trend) that
  // aren't directly editable drivers — in that case fall back to EVERY adjustable
  // exogenous variable the scaffold exposes, so the planner always sees editable
  // drivers once a forecast exists (instead of the misleading "Run a forecast
  // first" empty state). When the scaffold itself is empty (no completed forecast)
  // rows stays empty and the backend's message is surfaced below.
  const scaffoldFeatures = useMemo(
    () => (grid.data?.features ?? []).map((f) => f.name),
    [grid.data],
  );
  const rows = useMemo(() => {
    const fromGraph = features.filter((f) => baselineByFeature.has(f));
    return fromGraph.length ? fromGraph : scaffoldFeatures;
  }, [features, baselineByFeature, scaffoldFeatures]);

  // Editable cells as raw strings (so partial / invalid input never throws).
  const [cells, setCells] = useState<Record<string, string[]>>({});
  // Per-feature "apply to all" input value (raw string).
  const [bulk, setBulk] = useState<Record<string, string>>({});

  const seed = useCallback(() => {
    if (!months.length || !rows.length) return;
    const next: Record<string, string[]> = {};
    const nextBulk: Record<string, string> = {};
    for (const f of rows) {
      const base = baselineByFeature.get(f) ?? 0;
      const rounded = Math.round(base * 100) / 100;
      next[f] = months.map(() => String(rounded));
      nextBulk[f] = String(rounded);
    }
    setCells(next);
    setBulk(nextBulk);
  }, [months, rows, baselineByFeature]);

  // (Re)seed whenever the scaffold or the lever set changes.
  const seedKey = useMemo(
    () => JSON.stringify([sku, months, rows]),
    [sku, months, rows],
  );
  useEffect(() => {
    seed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);

  const setCell = (feature: string, monthIdx: number, raw: string) =>
    setCells((prev) => {
      const col = prev[feature] ? [...prev[feature]!] : months.map(() => "");
      col[monthIdx] = raw;
      return { ...prev, [feature]: col };
    });

  const applyToAll = (feature: string) =>
    setCells((prev) => ({ ...prev, [feature]: months.map(() => bulk[feature] ?? "") }));

  // Lift the resolved state to the parent (single effect — avoids loops).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (!months.length || !rows.length) {
      onChangeRef.current(EMPTY_STATE);
      return;
    }
    let valid = true;
    const values: Record<string, number[]> = {};
    for (const f of rows) {
      const col = cells[f] ?? [];
      const nums: number[] = [];
      for (let i = 0; i < months.length; i++) {
        const parsed = parseCell(col[i] ?? "");
        if (parsed == null) {
          valid = false;
          nums.push(baselineByFeature.get(f) ?? 0); // safe fallback (run is gated on `valid`)
        } else {
          nums.push(parsed);
        }
      }
      values[f] = nums;
    }
    onChangeRef.current({ ready: true, valid, months, values });
  }, [cells, months, rows, baselineByFeature]);

  if (grid.isLoading) return <Skeleton className="h-48 w-full" />;
  if (!rows.length) {
    return (
      <EmptyState
        title="No adjustable features"
        description={
          grid.data?.message ||
          "No forecast months or adjustable drivers were found for this item. Run a forecast first."
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      {/* Universal exogenous value controls — "Apply to All Forecast Months". */}
      <div className="rounded-lg border border-border/60 bg-secondary/20 p-4">
        <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
          Apply to All Forecast Months
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Set one value across every month for a feature. You can still edit
          individual months afterward.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((f) => {
            const invalid = parseCell(bulk[f] ?? "") == null;
            return (
              <div key={f} className="flex items-end gap-2">
                <label className="flex-1 space-y-1">
                  <span className="block text-xs font-medium text-foreground">{f}</span>
                  <input
                    inputMode="decimal"
                    value={bulk[f] ?? ""}
                    onChange={(e) => setBulk((prev) => ({ ...prev, [f]: e.target.value }))}
                    aria-label={`Apply-to-all value for ${f}`}
                    aria-invalid={invalid}
                    className={
                      "h-9 w-full rounded-md border bg-background px-2 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
                      (invalid ? "border-destructive" : "border-input")
                    }
                  />
                </label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={invalid}
                  onClick={() => applyToAll(f)}
                >
                  Apply
                </Button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Editable Feature × Month grid (inline cell editing). */}
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
          Monthly assumptions
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={seed}>
          <RotateCcw className="size-3.5" /> Reset to baseline
        </Button>
      </div>
      <div className="overflow-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-card text-xs text-muted-foreground">
            <tr>
              <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium">
                Feature
              </th>
              {months.map((m) => (
                <th key={m} className="px-2 py-2 text-right font-medium tabular-nums whitespace-nowrap">
                  {monthLabel(m)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f} className="border-t border-border/60">
                <td className="sticky left-0 z-10 bg-card px-3 py-1.5 font-medium text-foreground whitespace-nowrap">
                  {f}
                </td>
                {months.map((m, i) => {
                  const raw = cells[f]?.[i] ?? "";
                  const invalid = parseCell(raw) == null;
                  return (
                    <td key={m} className="px-1 py-1">
                      <input
                        inputMode="decimal"
                        value={raw}
                        onChange={(e) => setCell(f, i, e.target.value)}
                        aria-label={`${f} · ${monthLabel(m)}`}
                        aria-invalid={invalid}
                        title={invalid ? "Enter a valid number" : undefined}
                        className={
                          "h-8 w-20 rounded-md border bg-background px-2 text-right text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
                          (invalid
                            ? "border-destructive text-destructive"
                            : "border-input text-foreground")
                        }
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Click any cell to edit it directly. Invalid entries are outlined in red and
        must be fixed before running the scenario.
      </p>
    </div>
  );
}
