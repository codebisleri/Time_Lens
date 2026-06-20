"use client";

import { useCallback, useState } from "react";
import { useAsync } from "@/lib/hooks";
import { reportsService } from "@/lib/api/services";
import { downloadFile } from "@/lib/utils/download";
import type { GeneratedReport, ReportKind } from "@/types/report";

/**
 * Owns the Report hub data + actions: the executive summary, the generated-report
 * history, and generate/download. A single `tick` refetches summary + history
 * after a generation so the dashboard and history stay in sync with the backend.
 */
export function useReport() {
  const [tick, setTick] = useState(0);
  const summary = useAsync(() => reportsService.summary(), [tick]);
  const history = useAsync(() => reportsService.list(), [tick]);
  const [generating, setGenerating] = useState<ReportKind | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  const generate = useCallback(async (type: ReportKind) => {
    setGenerating(type);
    try {
      await reportsService.generate({ type });
      setTick((t) => t + 1);
    } finally {
      setGenerating(null);
    }
  }, []);

  const download = useCallback(async (report: GeneratedReport) => {
    setDownloading(report.id);
    try {
      const html = await reportsService.download(report.id);
      const stamp = report.generatedAt
        .replace(/[:T]/g, "")
        .slice(0, 13);
      downloadFile(`dhishaai_${report.type}_${stamp}.html`, html, "text/html");
    } finally {
      setDownloading(null);
    }
  }, []);

  return { summary, history, generating, downloading, generate, download };
}
