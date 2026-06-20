"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { formatDate, formatNumber } from "@/lib/utils/format";
import type { SubmissionEdit, SubmissionRow } from "@/types/submission";

const HEADERS: { key: string; label: string; align?: "right" }[] = [
  { key: "sku", label: "SKU" },
  { key: "productName", label: "Product" },
  { key: "category", label: "Category" },
  { key: "brand", label: "Brand" },
  { key: "segment", label: "Segment" },
  { key: "forecastMonth", label: "Month" },
  { key: "lastYearSameMonth", label: "LY same mo.", align: "right" },
  { key: "last3moAvg", label: "Last-3mo avg", align: "right" },
  { key: "modelForecast", label: "Model", align: "right" },
  { key: "submittedForecast", label: "Submitted", align: "right" },
  { key: "deltaVsModelPct", label: "Δ vs model", align: "right" },
  { key: "momPct", label: "MoM %", align: "right" },
  { key: "yoyPct", label: "YoY %", align: "right" },
  { key: "reason", label: "Reason" },
  { key: "notes", label: "Notes" },
  { key: "mape", label: "WMAPE", align: "right" },
  { key: "strategy", label: "Strategy" },
];

function num(v: number | null): string {
  return v == null || !Number.isFinite(v) ? "—" : formatNumber(Math.round(v));
}
function pct(v: number | null): string {
  return v == null || !Number.isFinite(v)
    ? "—"
    : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}
function mape(v: number | null): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(1);
}

const TH =
  "sticky top-0 z-10 whitespace-nowrap border-b border-border bg-card px-3 py-2 text-left text-xs font-medium text-muted-foreground";
const TD = "whitespace-nowrap px-3 py-1.5 text-sm tabular-nums text-foreground";

type Draft = { submittedForecast: string; notes: string };

/**
 * Purpose-built editable worksheet grid (Streamlit column order). Only
 * submittedForecast / reason / notes are editable; numeric + notes edits commit
 * on blur, the reason select commits on change. Derived columns (Δ, MoM, YoY)
 * come straight from the backend after each commit.
 */
export function SubmissionGrid({
  rows,
  reasonOptions,
  disabled,
  onEdit,
}: {
  rows: SubmissionRow[];
  reasonOptions: string[];
  disabled: boolean;
  onEdit: (edit: SubmissionEdit) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  // Reseed local text/number drafts whenever the backing rows change (after a
  // refetch). Safe because commits only fire on blur, so no field is mid-edit.
  useEffect(() => {
    const next: Record<string, Draft> = {};
    for (const r of rows) {
      next[r.id] = {
        submittedForecast: String(Math.round(r.submittedForecast)),
        notes: r.notes ?? "",
      };
    }
    setDrafts(next);
  }, [rows]);

  const byId = useMemo(
    () => Object.fromEntries(rows.map((r) => [r.id, r])),
    [rows],
  );

  function setDraft(id: string, patch: Partial<Draft>) {
    setDrafts((d) => ({
      ...d,
      [id]: { ...(d[id] ?? { submittedForecast: "", notes: "" }), ...patch },
    }));
  }

  function commitForecast(id: string) {
    const row = byId[id];
    if (!row) return;
    const raw = drafts[id]?.submittedForecast ?? "";
    const parsed = Number(raw);
    if (raw.trim() === "" || Number.isNaN(parsed)) {
      setDraft(id, { submittedForecast: String(Math.round(row.submittedForecast)) });
      return;
    }
    if (parsed !== row.submittedForecast) {
      onEdit({ id, submittedForecast: parsed });
    }
  }

  function commitNotes(id: string) {
    const row = byId[id];
    if (!row) return;
    const value = drafts[id]?.notes ?? "";
    if (value !== (row.notes ?? "")) onEdit({ id, notes: value });
  }

  return (
    <div className="max-h-[540px] overflow-auto rounded-lg border border-border">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {HEADERS.map((h) => (
              <th
                key={h.key}
                className={cn(TH, h.align === "right" && "text-right")}
              >
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const overridden = r.submittedForecast !== r.modelForecast;
            const draft = drafts[r.id];
            return (
              <tr
                key={r.id}
                className={cn(
                  "border-b border-border/60 last:border-0 hover:bg-secondary/30",
                  overridden && "bg-primary/5",
                )}
              >
                <td className={cn(TD, "font-mono text-xs font-medium")}>
                  {r.sku}
                </td>
                <td className={cn(TD, "max-w-48 truncate")}>{r.productName}</td>
                <td className={TD}>{r.category}</td>
                <td className={TD}>{r.brand}</td>
                <td className={TD}>{r.segment}</td>
                <td className={TD}>
                  {formatDate(r.forecastMonth, {
                    month: "short",
                    year: "numeric",
                    day: undefined,
                  })}
                </td>
                <td className={cn(TD, "text-right")}>
                  {num(r.lastYearSameMonth)}
                </td>
                <td className={cn(TD, "text-right")}>{num(r.last3moAvg)}</td>
                <td className={cn(TD, "text-right text-muted-foreground")}>
                  {num(r.modelForecast)}
                </td>
                <td className={cn(TD, "text-right")}>
                  <input
                    type="number"
                    value={draft?.submittedForecast ?? ""}
                    disabled={disabled}
                    onChange={(e) =>
                      setDraft(r.id, { submittedForecast: e.target.value })
                    }
                    onBlur={() => commitForecast(r.id)}
                    className="h-8 w-24 rounded-md border border-input bg-background/60 px-2 text-right text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    aria-label={`Submitted forecast for ${r.sku}`}
                  />
                </td>
                <td
                  className={cn(
                    TD,
                    "text-right font-medium",
                    overridden ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  {pct(r.deltaVsModelPct)}
                </td>
                <td className={cn(TD, "text-right")}>{pct(r.momPct)}</td>
                <td className={cn(TD, "text-right")}>{pct(r.yoyPct)}</td>
                <td className={TD}>
                  <select
                    value={r.reason}
                    disabled={disabled}
                    onChange={(e) => onEdit({ id: r.id, reason: e.target.value })}
                    className="h-8 w-48 rounded-md border border-input bg-background/60 px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    aria-label={`Reason for ${r.sku}`}
                  >
                    {/* Ensure the current value is selectable even if not in the option set. */}
                    {!reasonOptions.includes(r.reason) ? (
                      <option value={r.reason}>{r.reason}</option>
                    ) : null}
                    {reasonOptions.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </td>
                <td className={TD}>
                  <input
                    type="text"
                    value={draft?.notes ?? ""}
                    disabled={disabled}
                    onChange={(e) => setDraft(r.id, { notes: e.target.value })}
                    onBlur={() => commitNotes(r.id)}
                    placeholder="—"
                    className="h-8 w-56 rounded-md border border-input bg-background/60 px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    aria-label={`Notes for ${r.sku}`}
                  />
                </td>
                <td className={cn(TD, "text-right")}>{mape(r.mape)}</td>
                <td className={cn(TD, "text-xs text-muted-foreground")}>
                  {r.strategy}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
