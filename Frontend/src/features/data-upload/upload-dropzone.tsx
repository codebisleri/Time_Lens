"use client";

import { useRef, useState, type DragEvent } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileSpreadsheet,
  Loader2,
  RotateCcw,
  UploadCloud,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatFileSize } from "./mock-upload";
import type { UploadPhase } from "./types";

interface UploadDropzoneProps {
  phase: UploadPhase;
  progress: number;
  file: File | null;
  error: string | null;
  onFile: (file: File) => void;
  onReset: () => void;
}

/**
 * Large drag-and-drop ingestion zone supporting CSV/XLSX, with idle, dragging,
 * uploading, processing, success, and error states.
 */
export function UploadDropzone({
  phase,
  progress,
  file,
  error,
  onFile,
  onReset,
}: UploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const isBusy =
    phase === "uploading" ||
    phase === "processing" ||
    phase === "generating";

  function handleFiles(files: FileList | null) {
    const selected = files?.[0];
    if (selected) onFile(selected);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (isBusy) return;
    handleFiles(e.dataTransfer.files);
  }

  // ── Result / progress states ──────────────────────────────────────────────
  if (phase !== "idle") {
    return (
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-start gap-4">
          <span
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-lg border",
              phase === "error"
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : phase === "success"
                  ? "border-success/30 bg-success/10 text-success"
                  : "border-border bg-secondary text-muted-foreground",
            )}
          >
            {phase === "error" ? (
              <AlertCircle className="size-5" />
            ) : phase === "success" ? (
              <CheckCircle2 className="size-5" />
            ) : phase === "processing" || phase === "generating" ? (
              <Loader2 className="size-5 animate-spin" />
            ) : (
              <FileSpreadsheet className="size-5" />
            )}
          </span>

          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {file?.name ?? "Upload"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {phase === "uploading" && "Uploading…"}
                  {phase === "processing" && "Processing dataset…"}
                  {phase === "generating" && "Generating forecasts…"}
                  {phase === "success" && "Processing complete"}
                  {phase === "error" && (error ?? "Upload failed")}
                  {file ? ` · ${formatFileSize(file.size)}` : ""}
                </p>
              </div>
              {(phase === "success" || phase === "error") && (
                <Button variant="outline" size="sm" onClick={onReset}>
                  <RotateCcw className="size-3.5" />
                  Upload another
                </Button>
              )}
            </div>

            {(phase === "uploading" ||
              phase === "processing" ||
              phase === "generating") && (
              <div className="space-y-1">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                  <div
                    className={cn(
                      "h-full rounded-full bg-primary transition-all duration-150",
                      phase === "processing" && "animate-pulse",
                    )}
                    style={{
                      width: `${phase === "processing" ? 100 : progress}%`,
                    }}
                  />
                </div>
                {(phase === "uploading" || phase === "generating") && (
                  <p className="text-right text-xs tabular-nums text-muted-foreground">
                    {progress}%
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Idle / dragging ───────────────────────────────────────────────────────
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center transition-colors",
        dragging
          ? "border-primary bg-primary/5"
          : "border-border bg-card hover:border-muted-foreground/40 hover:bg-secondary/30",
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.xlsx"
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <UploadCloud className="size-6" />
      </span>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          {dragging ? "Drop the file to upload" : "Drag & drop your data file"}
        </p>
        <p className="text-sm text-muted-foreground">
          or <span className="font-medium text-primary">browse</span> to choose
          a file
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        Supports CSV and XLSX · up to 50 MB
      </p>
    </div>
  );
}
