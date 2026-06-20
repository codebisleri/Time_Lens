"use client";

import { Check, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check as CheckRow } from "@/features/data/controls";
import { cn } from "@/lib/utils";
import type {
  SubmissionFacets,
  SubmissionFilterState,
} from "@/types/submission";

/** Dropdown that keeps the menu open while toggling several values. */
function MultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (value: string) =>
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    );

  const summary =
    selected.length === 0
      ? `All ${label.toLowerCase()}`
      : selected.length === 1
        ? selected[0]
        : `${selected.length} selected`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="justify-between gap-2 sm:w-44"
        >
          <span className="truncate">{summary}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-72 w-56 overflow-y-auto"
      >
        <DropdownMenuLabel className="flex items-center justify-between">
          {label}
          {selected.length > 0 ? (
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-xs font-normal text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            No values
          </div>
        ) : (
          options.map((opt) => (
            <DropdownMenuItem
              key={opt}
              // preventDefault keeps the menu open for multi-select.
              onSelect={(e) => {
                e.preventDefault();
                toggle(opt);
              }}
              className="justify-between gap-2"
            >
              <span className="truncate">{opt}</span>
              {selected.includes(opt) ? (
                <Check className="size-4 shrink-0 text-primary" />
              ) : null}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Cascading Submission filters: category / brand / product / segment / SKU
 * (multi-select, facets from the backend) plus the overridden-only toggle and
 * the low-confidence WMAPE threshold. Filtering runs server-side.
 */
export function SubmissionFilters({
  filters,
  facets,
  summary,
  onChange,
}: {
  filters: SubmissionFilterState;
  facets: SubmissionFacets;
  summary: string;
  onChange: (next: SubmissionFilterState) => void;
}) {
  const active =
    filters.category.length > 0 ||
    filters.brand.length > 0 ||
    filters.product.length > 0 ||
    filters.segment.length > 0 ||
    filters.sku.length > 0 ||
    filters.overriddenOnly ||
    filters.wmapeThreshold > 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <MultiSelect
          label="Category"
          options={facets.categories}
          selected={filters.category}
          onChange={(category) => onChange({ ...filters, category })}
        />
        <MultiSelect
          label="Brand"
          options={facets.brands}
          selected={filters.brand}
          onChange={(brand) => onChange({ ...filters, brand })}
        />
        <MultiSelect
          label="Product"
          options={facets.products}
          selected={filters.product}
          onChange={(product) => onChange({ ...filters, product })}
        />
        <MultiSelect
          label="Segment"
          options={facets.segments}
          selected={filters.segment}
          onChange={(segment) => onChange({ ...filters, segment })}
        />
        <MultiSelect
          label="SKU"
          options={facets.skus}
          selected={filters.sku}
          onChange={(sku) => onChange({ ...filters, sku })}
        />

        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">WMAPE &gt;</span>
          <Input
            type="number"
            min={0}
            step={1}
            value={filters.wmapeThreshold || ""}
            onChange={(e) =>
              onChange({
                ...filters,
                wmapeThreshold: Number(e.target.value) || 0,
              })
            }
            placeholder="0"
            className="h-8 w-20 tabular-nums"
            aria-label="Low-confidence WMAPE threshold"
          />
        </div>

        <CheckRow
          checked={filters.overriddenOnly}
          onChange={(overriddenOnly) =>
            onChange({ ...filters, overriddenOnly })
          }
          label="Overridden only"
        />

        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            onChange({
              category: [],
              brand: [],
              product: [],
              segment: [],
              sku: [],
              overriddenOnly: false,
              wmapeThreshold: 0,
            })
          }
          className={cn(
            "text-muted-foreground transition-opacity",
            active ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <X className="size-4" /> Clear
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">{summary}</p>
    </div>
  );
}
