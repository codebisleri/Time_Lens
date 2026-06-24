"use client";

import { useState } from "react";
import { Calendar, Plus, RotateCcw, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Field, Select } from "@/features/data/controls";
import type { SubmissionBulk } from "@/types/submission";

/**
 * Bulk actions on the current filter — apply % changes, copy LY same month,
 * reset to model, and bulk-set reason. Each maps to a single PATCH {bulk, filter}.
 *
 * Phase Y.3 · Task 1 — an override REASON is mandatory before any value-changing
 * override (% change, Copy LY overwrite, or bulk-set reason) can be applied. The
 * reason selector starts unset; until a reason is chosen those Apply buttons are
 * disabled and a validation message is shown, and the chosen reason is recorded
 * on every affected row. "Reset to model" clears an override, so it needs none.
 */
export function SubmissionBulkActions({
  reasonOptions,
  rowsInView,
  disabled,
  onApply,
}: {
  reasonOptions: string[];
  rowsInView: number;
  disabled: boolean;
  onApply: (bulk: SubmissionBulk) => void;
}) {
  const [uplift, setUplift] = useState("5");
  // Empty = no reason chosen yet (the placeholder). reasonOptions[0] is the
  // backend "(no override)" sentinel, which we drop from the choices so picking
  // any real reason is an explicit, recorded decision.
  const [reason, setReason] = useState("");
  const reasonChoices = reasonOptions.filter((_, i) => i !== 0);
  const reasonValid = reason.trim() !== "";

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-foreground">
          ⚡ Bulk actions on the current filter
        </h3>
        <span className="text-xs text-muted-foreground">
          applies to {rowsInView} row(s) in view
        </span>
      </div>

      {/* Mandatory override reason — gates every value-changing override below. */}
      <Field label="Override reason (required)">
        <Select
          value={reason}
          onChange={setReason}
          options={[
            { value: "", label: "Select an override reason…" },
            ...reasonChoices.map((r) => ({ value: r, label: r })),
          ]}
          ariaLabel="Override reason"
        />
        {!reasonValid ? (
          <p className="mt-1 text-xs font-medium text-destructive">
            Please select or enter an override reason.
          </p>
        ) : null}
      </Field>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Apply % Changes">
          <div className="flex items-center gap-2">
            <Input
              type="number"
              step={5}
              value={uplift}
              onChange={(e) => setUplift(e.target.value)}
              className="h-9 w-24 tabular-nums"
              aria-label="Percent change"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || !reasonValid}
              title={!reasonValid ? "Please select or enter an override reason." : undefined}
              onClick={() =>
                onApply({ op: "uplift", value: Number(uplift) || 0, reason })
              }
            >
              <Plus className="size-4" /> Apply
            </Button>
          </div>
        </Field>

        <Field label="Copy last-year same month">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || !reasonValid}
            title={!reasonValid ? "Please select or enter an override reason." : undefined}
            onClick={() => onApply({ op: "copy_ly", reason })}
          >
            <Calendar className="size-4" /> Copy LY →
          </Button>
        </Field>

        <Field label="Reset to model">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => onApply({ op: "reset" })}
          >
            <RotateCcw className="size-4" /> Reset
          </Button>
        </Field>

        <Field label="Set reason only">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || !reasonValid}
            title={!reasonValid ? "Please select or enter an override reason." : undefined}
            onClick={() => onApply({ op: "reason", reason })}
          >
            <Tag className="size-4" /> Apply
          </Button>
        </Field>
      </div>
    </Card>
  );
}
