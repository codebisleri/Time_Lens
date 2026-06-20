"use client";

import { useState } from "react";
import { Check, ChevronDown, Columns3, Save } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { Dataset } from "@/types/dataset";

const NONE = "__none__";
type Role = { key: keyof NonNullable<Dataset["detectedMapping"]>; label: string; required: boolean };

const ROLES: Role[] = [
  { key: "date", label: "Date column", required: true },
  { key: "sku", label: "SKU column", required: true },
  { key: "sales", label: "Sales column", required: true },
  { key: "category", label: "Category column", required: false },
  { key: "price", label: "Price column", required: false },
];

/**
 * Column Mapping — shows the engine's auto-detected column → role mapping and
 * lets the planner override each role. Overrides are local (the bridge ingests
 * with the detected mapping); "Save mapping" confirms the selection.
 */
export function ColumnMapping({ dataset }: { dataset: Dataset }) {
  const columns = dataset.columns ?? [];
  const detected = dataset.detectedMapping ?? {};
  const [mapping, setMapping] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      ROLES.map((r) => [r.key, (detected[r.key] as string | null) ?? NONE]),
    ),
  );

  const options = [NONE, ...columns];
  const dirty = ROLES.some(
    (r) => mapping[r.key] !== ((detected[r.key] as string | null) ?? NONE),
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Columns3 className="size-4 text-muted-foreground" /> Column mapping
          </CardTitle>
          <CardDescription>
            Auto-detected from your file — override any role if needed.
          </CardDescription>
        </div>
        <Button
          size="sm"
          disabled={!dirty}
          onClick={() => toast.success("Column mapping saved")}
        >
          <Save className="size-4" /> Save mapping
        </Button>
      </CardHeader>
      <CardContent>
        <div className="divide-y divide-border/60">
          {ROLES.map((role) => {
            const detectedCol = (detected[role.key] as string | null) ?? null;
            const current = mapping[role.key] ?? NONE;
            return (
              <div
                key={role.key}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {role.label}
                  </span>
                  {role.required ? (
                    <Badge variant="outline" className="text-[10px]">
                      required
                    </Badge>
                  ) : null}
                  {detectedCol && current === detectedCol ? (
                    <Badge variant="secondary" className="text-[10px]">
                      auto-detected
                    </Badge>
                  ) : null}
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="w-full justify-between sm:w-64">
                      <span className="truncate font-mono text-xs">
                        {current === NONE ? "— not mapped —" : current}
                      </span>
                      <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="max-h-72 w-64 overflow-y-auto">
                    {options.map((col) => (
                      <DropdownMenuItem
                        key={col}
                        onSelect={() =>
                          setMapping((m) => ({ ...m, [role.key]: col }))
                        }
                        className="justify-between"
                      >
                        <span className="truncate font-mono text-xs">
                          {col === NONE ? "— not mapped —" : col}
                        </span>
                        {col === current ? (
                          <Check className="size-4 text-primary" />
                        ) : null}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
        </div>
        {columns.length === 0 ? (
          <p className={cn("mt-3 text-sm text-muted-foreground")}>
            Column list unavailable for this dataset.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
