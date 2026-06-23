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
  const [reason, setReason] = useState(reasonOptions[0] ?? "");

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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
              disabled={disabled}
              onClick={() =>
                onApply({ op: "uplift", value: Number(uplift) || 0 })
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
            disabled={disabled}
            onClick={() => onApply({ op: "copy_ly" })}
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

        <Field label="Bulk-set reason">
          <div className="flex items-center gap-2">
            <Select
              value={reason}
              onChange={setReason}
              options={reasonOptions.map((r) => ({ value: r, label: r }))}
              ariaLabel="Bulk reason"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => onApply({ op: "reason", reason })}
            >
              <Tag className="size-4" /> Apply
            </Button>
          </div>
        </Field>
      </div>
    </Card>
  );
}
