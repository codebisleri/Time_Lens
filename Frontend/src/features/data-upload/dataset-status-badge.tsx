import { Badge } from "@/components/ui/badge";
import type { DatasetStatus } from "@/types/dataset";

const VARIANT: Record<
  DatasetStatus,
  "success" | "warning" | "destructive" | "secondary"
> = {
  ready: "success",
  uploading: "warning",
  processing: "warning",
  validating: "warning",
  failed: "destructive",
};

const LABEL: Record<DatasetStatus, string> = {
  ready: "Ready",
  uploading: "Uploading",
  processing: "Processing",
  validating: "Validating",
  failed: "Failed",
};

export function DatasetStatusBadge({ status }: { status: DatasetStatus }) {
  return <Badge variant={VARIANT[status]}>{LABEL[status]}</Badge>;
}
