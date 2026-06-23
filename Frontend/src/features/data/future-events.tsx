"use client";

import { useRef, useState } from "react";
import { AlertTriangle, CalendarPlus, CheckCircle2, Download, Plus, Save, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { dataService } from "@/lib/api/services";
import { downloadFile } from "@/lib/utils/download";
import type { FutureEvent } from "@/types/dataset";
import { Select } from "./controls";

const EVENT_TYPES = [
  "Holiday", "Promo", "Launch", "Closure", "Stock-out", "Price change",
  "Marketing burst", "External shock", "Other",
].map((v) => ({ value: v, label: v }));

const COLS: (keyof FutureEvent)[] = [
  "event_start_date", "event_end_date", "event_name", "event_type",
  "impact_pct", "applies_to", "notes",
];

const emptyRow = (): FutureEvent => ({
  event_start_date: "", event_end_date: "", event_name: "", event_type: "Promo",
  impact_pct: "0", applies_to: "ALL", notes: "",
});

/** Minimal CSV parse for the events template (header + simple comma split). */
function parseEventsCsv(text: string): FutureEvent[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const headerLine = lines[0];
  if (!headerLine) return [];
  const header = headerLine.split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row = emptyRow();
    const sink = row as unknown as Record<string, string>;
    header.forEach((h, i) => {
      if (COLS.includes(h as keyof FutureEvent)) {
        sink[h] = (cells[i] ?? "").trim();
      }
    });
    return row;
  });
}

function toCsv(rows: FutureEvent[]): string {
  const esc = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
  return [COLS.join(","), ...rows.map((r) => COLS.map((c) => esc(r[c])).join(","))].join("\n");
}

const VALID_EVENT_TYPES = new Set(EVENT_TYPES.map((e) => e.value.toLowerCase()));

// Every template column is required (F.12 #6 — detect missing columns first).
const REQUIRED_COLUMNS: (keyof FutureEvent)[] = [...COLS];

/** Required columns absent from the uploaded header (checked before dates). */
function missingColumns(text: string): string[] {
  const headerLine = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const header = new Set(headerLine.split(",").map((h) => h.trim().toLowerCase()));
  return REQUIRED_COLUMNS.filter((c) => !header.has(c.toLowerCase()));
}

/** Parse a date in YYYY-MM-DD, DD-MM-YYYY, or DD/MM/YYYY → UTC ms, else null. */
function parseEventDate(v: string): number | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  let y: number, mo: number, d: number;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s); // YYYY-MM-DD
  if (m) {
    y = +m[1]!; mo = +m[2]!; d = +m[3]!;
  } else {
    m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s); // DD-MM-YYYY or DD/MM/YYYY
    if (!m) return null;
    d = +m[1]!; mo = +m[2]!; y = +m[3]!;
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900) return null;
  return Date.UTC(y, mo - 1, d);
}
const isValidDate = (v: string) => parseEventDate(v) !== null;

export interface EventIssue {
  line: number; // CSV line number (header = line 1)
  message: string;
}

/**
 * Validate uploaded Event Calendar rows (F.9 Part 11). Returns row-level issues;
 * an empty array means the file is clean and may proceed. Checks required fields,
 * date validity + ordering, numeric impact, invalid event categories, and
 * duplicate events.
 */
export function validateEventRows(rows: FutureEvent[]): EventIssue[] {
  const issues: EventIssue[] = [];
  const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    const line = i + 2; // +1 for header, +1 for 1-based
    if (!r.event_name?.trim()) issues.push({ line, message: "Event Name missing" });
    if (!r.event_start_date?.trim()) {
      issues.push({ line, message: "Start Date missing" });
    } else if (!isValidDate(r.event_start_date)) {
      issues.push({ line, message: `Invalid Date Format (start: "${r.event_start_date}")` });
    }
    if (r.event_end_date?.trim()) {
      if (!isValidDate(r.event_end_date)) {
        issues.push({ line, message: `Invalid Date Format (end: "${r.event_end_date}")` });
      } else {
        const sd = parseEventDate(r.event_start_date);
        const ed = parseEventDate(r.event_end_date);
        if (sd !== null && ed !== null && ed < sd) {
          issues.push({ line, message: "End Date is before Start Date" });
        }
      }
    }
    if (!r.event_type?.trim()) {
      issues.push({ line, message: "Event Category missing" });
    } else if (!VALID_EVENT_TYPES.has(r.event_type.trim().toLowerCase())) {
      issues.push({ line, message: `Invalid Event Category ("${r.event_type}")` });
    }
    if (r.impact_pct?.trim() && Number.isNaN(Number(r.impact_pct))) {
      issues.push({ line, message: `Impact % is not numeric ("${r.impact_pct}")` });
    }
    if (!r.applies_to?.trim()) {
      issues.push({ line, message: "Applies-To missing (use ALL or a level value)" });
    }
    // Duplicate event = same name + start date.
    const key = `${r.event_name?.trim().toLowerCase()}|${r.event_start_date?.trim()}`;
    if (r.event_name?.trim() && seen.has(key)) {
      issues.push({ line, message: `Duplicate Event (also on line ${seen.get(key)})` });
    } else if (r.event_name?.trim()) {
      seen.set(key, line);
    }
  });
  return issues;
}

/**
 * Future Events Calendar — replicates the Streamlit events editor: template
 * download, CSV upload (replaces list), an editable 7-column grid, and a
 * download of the current events. Persisted into the dataset config.
 */
export function FutureEvents({
  initial,
  onSave,
  saving,
}: {
  initial: FutureEvent[];
  onSave: (events: FutureEvent[]) => void;
  saving: boolean;
}) {
  const [rows, setRows] = useState<FutureEvent[]>(initial);
  const [issues, setIssues] = useState<EventIssue[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const setCell = (i: number, key: keyof FutureEvent, value: string) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));

  // Phase X.Q · Task 5 — never report a false "saved" when there is no event
  // calendar. With zero rows (no file uploaded / all removed), block the save.
  const handleSave = () => {
    if (rows.length === 0) {
      toast.error("Please upload an event calendar before saving.");
      return;
    }
    onSave(rows);
  };

  const downloadTemplate = async () => {
    try {
      const csv = await dataService.eventsTemplate();
      downloadFile("events_calendar_template.csv", csv);
    } catch {
      toast.error("Couldn’t fetch template");
    }
  };

  const onUpload = async (file: File) => {
    const text = await file.text();
    // 1) Missing required columns are detected BEFORE any date parsing (F.12 #6).
    const missing = missingColumns(text);
    if (missing.length) {
      setIssues(missing.map((c) => ({ line: 1, message: `Missing required column: ${c}` })));
      toast.error(`Event Calendar missing column(s): ${missing.join(", ")}`);
      return;
    }
    const parsed = parseEventsCsv(text);
    if (parsed.length === 0) {
      setIssues([{ line: 1, message: "No data rows found (is the header row present?)" }]);
      toast.error("Event Calendar has no rows");
      return;
    }
    // 2) Then validate row contents (dates, categories, duplicates, …).
    const found = validateEventRows(parsed);
    if (found.length) {
      // Block invalid files — do NOT load the rows; user must fix errors first.
      setIssues(found);
      toast.error(`Event Calendar has ${found.length} issue(s) — fix and re-upload`);
      return;
    }
    setIssues(null);
    setRows(parsed);
    toast.success(`Events loaded — ${parsed.length} valid row(s)`);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarPlus className="size-4 text-primary" /> Future events calendar
          </CardTitle>
          <CardDescription>
            Promos, holidays, launches and shocks that should inform the forecast.
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={downloadTemplate}>
            <Download className="size-4" /> Template
          </Button>
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <Upload className="size-4" /> Upload CSV
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onUpload(f);
              e.target.value = "";
            }}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadFile("events_calendar_current.csv", toCsv(rows))}
            disabled={rows.length === 0}
          >
            <Download className="size-4" /> Current
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Upload validation report (Part 11) — invalid files are blocked. */}
        {issues && issues.length ? (
          <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-destructive">
              <AlertTriangle className="size-4" />
              Event Calendar not loaded — {issues.length} issue(s) found. Fix and re-upload.
            </p>
            <ul className="max-h-48 space-y-1 overflow-auto text-xs text-foreground">
              {issues.map((iss, i) => (
                <li key={i} className="flex gap-2">
                  <span className="shrink-0 font-mono font-medium text-destructive">
                    Row {iss.line}:
                  </span>
                  <span>{iss.message}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : issues && issues.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-success/25 bg-success/10 p-3 text-sm text-success">
            <CheckCircle2 className="size-4" /> Event Calendar validated — all rows OK.
          </div>
        ) : null}

        <div className="overflow-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="px-2 py-1 font-medium">Start</th>
                <th className="px-2 py-1 font-medium">End</th>
                <th className="px-2 py-1 font-medium">Name</th>
                <th className="px-2 py-1 font-medium">Type</th>
                <th className="px-2 py-1 font-medium">Impact %</th>
                <th className="px-2 py-1 font-medium">Applies to</th>
                <th className="px-2 py-1 font-medium">Notes</th>
                <th className="px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-border/60">
                  <td className="p-1"><Input type="date" value={r.event_start_date} onChange={(e) => setCell(i, "event_start_date", e.target.value)} className="h-8" aria-label="Start date" /></td>
                  <td className="p-1"><Input type="date" value={r.event_end_date} onChange={(e) => setCell(i, "event_end_date", e.target.value)} className="h-8" aria-label="End date" /></td>
                  <td className="p-1"><Input value={r.event_name} onChange={(e) => setCell(i, "event_name", e.target.value)} className="h-8" aria-label="Event name" /></td>
                  <td className="p-1 min-w-36"><Select value={r.event_type} onChange={(v) => setCell(i, "event_type", v)} options={EVENT_TYPES} ariaLabel="Event type" /></td>
                  <td className="p-1"><Input type="number" step="1" value={r.impact_pct} onChange={(e) => setCell(i, "impact_pct", e.target.value)} className="h-8 w-20" aria-label="Impact percent" /></td>
                  <td className="p-1"><Input value={r.applies_to} onChange={(e) => setCell(i, "applies_to", e.target.value)} className="h-8" aria-label="Applies to" /></td>
                  <td className="p-1"><Input value={r.notes} onChange={(e) => setCell(i, "notes", e.target.value)} className="h-8" aria-label="Notes" /></td>
                  <td className="p-1">
                    <Button variant="ghost" size="icon" className="size-8" onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))} aria-label="Remove event">
                      <Trash2 className="size-4 text-muted-foreground" />
                    </Button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr><td colSpan={8} className="px-2 py-4 text-center text-muted-foreground">No events. Add one or upload a CSV.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between">
          <Button variant="outline" size="sm" onClick={() => setRows((rs) => [...rs, emptyRow()])}>
            <Plus className="size-4" /> Add event
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || rows.length === 0}
            title={rows.length === 0 ? "Upload an event calendar before saving" : undefined}
          >
            <Save className="size-4" /> Save events
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
