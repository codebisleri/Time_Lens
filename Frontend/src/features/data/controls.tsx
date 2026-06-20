"use client";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { formatForecastLevel } from "@/lib/utils/format";

/** Labelled form field wrapper (label + control + optional hint). */
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label className="text-xs font-medium text-foreground">{label}</label>
      {children}
      {hint ? (
        <p className="text-[0.7rem] leading-snug text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export interface Opt {
  value: string;
  label: string;
}

/** Native select styled to match the Input primitive (no new UI dependency). */
export function Select({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Opt[];
  ariaLabel?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      // Explicit bg/text (not transparent) so the closed control AND the native
      // option list are legible in dark mode (Chromium honours option colors).
      className={cn(
        "h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "[&>option]:bg-popover [&>option]:text-popover-foreground",
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Numeric input that STRICTLY enforces [min, max] (Part 6). Out-of-range values
 * are clamped on every change and on blur, so invalid values cannot be entered
 * or submitted. No helper text — the bounds are implicit.
 */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  ariaLabel,
  className,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
}) {
  const clamp = (n: number) =>
    Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, n));
  return (
    <Input
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={Number.isFinite(value) ? value : ""}
      disabled={disabled}
      aria-label={ariaLabel}
      className={className}
      onChange={(e) => {
        if (e.target.value === "") return; // allow transient empty while typing
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(clamp(n));
      }}
      onBlur={(e) => {
        const n = Number(e.target.value);
        onChange(clamp(Number.isFinite(n) ? n : (min ?? 0)));
      }}
    />
  );
}

/** Checkbox + label row. */
export function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 cursor-pointer accent-primary"
      />
      {label}
    </label>
  );
}

export const NONE = "__none__";

/** Build column options with an optional "(none)" sentinel mapped to null. */
export function columnOptions(columns: string[], withNone = false): Opt[] {
  // F.17C — display a humanized label (product_name → Product Name) while the
  // option VALUE stays the raw CSV header, so mapping is unchanged but no raw
  // database column name ever appears in any column dropdown.
  const opts = columns.map((c) => ({ value: c, label: formatForecastLevel(c) }));
  return withNone ? [{ value: NONE, label: "(none)" }, ...opts] : opts;
}
