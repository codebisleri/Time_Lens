import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { ColumnMapping, ValidationIssue } from "@/types/dataset";

/**
 * State machine for the multi-step Data Upload wizard (select → map → validate
 * → confirm). Ephemeral by design — reset when the user leaves the flow.
 */
export type UploadStep = "select" | "map" | "validate" | "confirm";

interface UploadState {
  step: UploadStep;
  file: File | null;
  fileName: string | null;
  columnMappings: ColumnMapping[];
  issues: ValidationIssue[];
  previewRows: Record<string, string>[];
  isProcessing: boolean;

  setFile: (file: File | null) => void;
  setStep: (step: UploadStep) => void;
  setMappings: (mappings: ColumnMapping[]) => void;
  setIssues: (issues: ValidationIssue[]) => void;
  setPreview: (rows: Record<string, string>[]) => void;
  setProcessing: (processing: boolean) => void;
  reset: () => void;
}

const initial = {
  step: "select" as UploadStep,
  file: null,
  fileName: null,
  columnMappings: [],
  issues: [],
  previewRows: [],
  isProcessing: false,
};

export const useUploadStore = create<UploadState>()(
  devtools(
    (set) => ({
      ...initial,
      setFile: (file) => set({ file, fileName: file?.name ?? null }),
      setStep: (step) => set({ step }),
      setMappings: (columnMappings) => set({ columnMappings }),
      setIssues: (issues) => set({ issues }),
      setPreview: (previewRows) => set({ previewRows }),
      setProcessing: (isProcessing) => set({ isProcessing }),
      reset: () => set(initial),
    }),
    { name: "upload-store" },
  ),
);
