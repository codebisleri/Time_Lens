"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

/**
 * Shared numeric input (Phase X.M · Tasks 1–2).
 *
 * Fixes the old clamp-on-keystroke UX (which fought the user while typing) with a
 * free-typing field that VALIDATES instead of mutating: the user can type, paste,
 * use the arrow keys, clear the field, and tab away freely. When the value is out
 * of range (or empty / non-integer) the field shows a red border + helper message
 * and reports `onValidityChange(false)` so the parent can disable submission.
 *
 * Features: direct typing · keyboard + arrow steppers (native number input) ·
 * paste · mobile numeric keypad (inputMode) · tab navigation · min / max ·
 * helper text · validation state.
 */
export function NumericInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  allowFloat = false,
  label,
  unit,
  helperText,
  errorText,
  ariaLabel,
  className,
  disabled,
  onValidityChange,
  hardLimit = false,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Allow decimals (default false → whole numbers only). */
  allowFloat?: boolean;
  /**
   * Phase X.X · Task 2 — HARD limit enforcement. When true, the field can never
   * hold an out-of-range value: typed/pasted/stepped values above `max` are
   * clamped to `max` on the spot, non-numeric keystrokes are dropped, and values
   * below `min` (or empty) snap to `min` on blur. Use for bounded integer config
   * (Forecast Horizon, Cold-Start, Short-History). Default false keeps the
   * free-typing validate-don't-mutate behaviour everywhere else.
   */
  hardLimit?: boolean;
  /** Human label used in the default range message ("Forecast horizon must be…"). */
  label?: string;
  /** Unit appended to the default range message (e.g. "months"). */
  unit?: string;
  /** Hint shown under the field when the value is valid. */
  helperText?: string;
  /** Overrides the auto-generated error message. */
  errorText?: string;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
  /** Called whenever validity flips — wire to disable a submit button. */
  onValidityChange?: (valid: boolean) => void;
}) {
  const id = useId();
  const [text, setText] = useState<string>(() =>
    Number.isFinite(value) ? String(value) : "",
  );

  // Resync the field when the external value changes to something the field is
  // not already showing (e.g. a reset or programmatic update) — but don't fight
  // the user mid-edit when the parsed text already equals the prop.
  useEffect(() => {
    const n = Number(text);
    const shown = text !== "" && Number.isFinite(n) && n === value;
    if (!shown) setText(Number.isFinite(value) ? String(value) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const validate = (t: string): { valid: boolean; n: number } => {
    if (t.trim() === "") return { valid: false, n: NaN };
    const n = Number(t);
    if (!Number.isFinite(n)) return { valid: false, n: NaN };
    if (!allowFloat && !Number.isInteger(n)) return { valid: false, n };
    if (min != null && n < min) return { valid: false, n };
    if (max != null && n > max) return { valid: false, n };
    return { valid: true, n };
  };

  const current = validate(text);

  // Report validity transitions upward (skip redundant calls).
  const lastValid = useRef<boolean | null>(null);
  useEffect(() => {
    if (onValidityChange && lastValid.current !== current.valid) {
      lastValid.current = current.valid;
      onValidityChange(current.valid);
    }
  });

  const handle = (t: string) => {
    if (hardLimit) {
      // Allow an empty field mid-edit (snaps to min on blur). Otherwise accept
      // only well-formed numbers and clamp above-max instantly so the field can
      // never display an out-of-range value (covers typing, paste, and steppers).
      if (t.trim() === "") {
        setText("");
        return;
      }
      const raw = Number(t);
      if (!Number.isFinite(raw)) return; // drop invalid keystroke/paste
      let n = allowFloat ? raw : Math.trunc(raw);
      if (max != null && n > max) n = max;
      // Don't clamp below min while typing (e.g. "1" before "12"); blur handles it.
      const out = String(n);
      setText(out);
      onChange(n);
      return;
    }
    setText(t);
    const v = validate(t);
    if (v.valid) onChange(v.n);
  };

  const handleBlur = () => {
    if (!hardLimit) return;
    const n = Number(text);
    if (text.trim() === "" || !Number.isFinite(n)) {
      const fallback = min ?? 0;
      setText(String(fallback));
      onChange(fallback);
      return;
    }
    let clamped = allowFloat ? n : Math.trunc(n);
    if (min != null && clamped < min) clamped = min;
    if (max != null && clamped > max) clamped = max;
    if (clamped !== n || String(clamped) !== text) {
      setText(String(clamped));
      onChange(clamped);
    }
  };

  const showError = !current.valid;
  const rangeMsg =
    errorText ??
    (min != null && max != null
      ? `${label ?? "Value"} must be between ${min} and ${max}${unit ? ` ${unit}` : ""}.`
      : `Enter a valid ${allowFloat ? "number" : "whole number"}${
          min != null ? ` ≥ ${min}` : ""
        }${max != null ? ` ≤ ${max}` : ""}.`);
  const message = showError ? rangeMsg : helperText;

  return (
    <div className="space-y-1">
      <Input
        id={id}
        type="number"
        inputMode={allowFloat ? "decimal" : "numeric"}
        min={min}
        max={max}
        step={step}
        value={text}
        disabled={disabled}
        aria-label={ariaLabel ?? label}
        aria-invalid={showError || undefined}
        aria-describedby={message ? `${id}-msg` : undefined}
        className={cn(
          showError && "border-destructive focus-visible:ring-destructive",
          className,
        )}
        onChange={(e) => handle(e.target.value)}
        onBlur={handleBlur}
      />
      {message ? (
        <p
          id={`${id}-msg`}
          className={cn(
            "text-[0.7rem] leading-snug",
            showError ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
