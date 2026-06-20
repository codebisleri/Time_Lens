"use client";

import { Check, ChevronDown, Search, X } from "lucide-react";
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
import { cn } from "@/lib/utils";
import type { SkuStatus } from "@/types/sku";

export const ALL = "all" as const;
export type StatusFilter = SkuStatus | typeof ALL;
export type CategoryFilter = string | typeof ALL;

export interface SkuFilters {
  search: string;
  category: CategoryFilter;
  status: StatusFilter;
}

export const DEFAULT_SKU_FILTERS: SkuFilters = {
  search: "",
  category: ALL,
  status: ALL,
};

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: ALL, label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "discontinued", label: "Discontinued" },
  { value: "new", label: "New" },
];

/** A single-select dropdown styled as a filter "pill". */
function SelectMenu<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="justify-between gap-2 sm:w-44">
          <span className="truncate">{current?.label ?? label}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => onChange(option.value)}
            className="justify-between"
          >
            <span className="truncate">{option.label}</span>
            {option.value === value ? (
              <Check className="size-4 text-primary" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * SKU catalog filter bar: free-text search plus category and status selects.
 * Filtering runs client-side against the loaded mock catalog (see the view).
 */
export function SkuFilterBar({
  filters,
  categories,
  onChange,
}: {
  filters: SkuFilters;
  categories: string[];
  onChange: (filters: SkuFilters) => void;
}) {
  const categoryOptions: { value: CategoryFilter; label: string }[] = [
    { value: ALL, label: "All categories" },
    ...categories.map((c) => ({ value: c, label: c })),
  ];

  const hasActiveFilters =
    filters.search !== "" ||
    filters.category !== ALL ||
    filters.status !== ALL;

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="relative flex-1 sm:max-w-xs">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          placeholder="Search by code, name, or category…"
          value={filters.search}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
          className="pl-9"
          aria-label="Search SKUs"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SelectMenu
          label="Category"
          value={filters.category}
          options={categoryOptions}
          onChange={(category) => onChange({ ...filters, category })}
        />
        <SelectMenu
          label="Status"
          value={filters.status}
          options={STATUS_OPTIONS}
          onChange={(status) => onChange({ ...filters, status })}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange(DEFAULT_SKU_FILTERS)}
          className={cn(
            "text-muted-foreground transition-opacity",
            hasActiveFilters ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <X className="size-4" /> Clear
        </Button>
      </div>
    </div>
  );
}
