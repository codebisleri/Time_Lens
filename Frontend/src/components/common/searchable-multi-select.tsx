"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";

export interface MultiSelectOption {
  value: string;
  label: string;
}

/**
 * Searchable, keyboard-navigable multi-select dropdown (value/label aware).
 * Selected values render as removable chips below the trigger; the option list is
 * searchable and scrollable. `value` is the array of selected option VALUES —
 * directly compatible with persisted string[] state. Closes on outside-click/Esc.
 */
export function SearchableMultiSelect({
  options,
  value,
  onChange,
  placeholder = "Select…",
  ariaLabel,
}: {
  options: MultiSelectOption[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const labelOf = useMemo(() => {
    const m = new Map(options.map((o) => [o.value, o.label]));
    return (v: string) => m.get(v) ?? v;
  }, [options]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query, open]);

  const toggle = (v: string) =>
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = filtered[activeIdx];
      if (o) toggle(o.value);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={options.length === 0}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-xs text-muted-foreground transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="truncate">
          {options.length === 0
            ? "No models available"
            : value.length
              ? `${value.length} selected`
              : placeholder}
        </span>
        <ChevronDown className="size-4 shrink-0 opacity-60" />
      </button>

      {open && options.length > 0 ? (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover shadow-md">
          <div className="border-b border-border/60 p-2">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search…"
              aria-label="Search models"
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div role="listbox" aria-multiselectable className="max-h-56 overflow-auto p-1">
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">No matches.</p>
            ) : (
              filtered.map((o, i) => {
                const selected = value.includes(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => toggle(o.value)}
                    className={
                      "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors " +
                      (i === activeIdx ? "bg-secondary/70 " : "") +
                      (selected ? "font-medium text-primary" : "text-foreground")
                    }
                  >
                    <span className="truncate">{o.label}</span>
                    {selected ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}

      {/* Selected values as removable chips. */}
      {value.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {value.map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[0.7rem] text-primary"
            >
              {labelOf(v)}
              <button
                type="button"
                onClick={() => toggle(v)}
                aria-label={`Remove ${labelOf(v)}`}
                className="rounded-full p-0.5 hover:bg-primary/20"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
