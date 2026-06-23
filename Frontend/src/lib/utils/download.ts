/**
 * Trigger a client-side file download from in-memory content (real data only —
 * the content comes from a backend export endpoint or a serialized object).
 */
export function downloadFile(
  filename: string,
  content: string,
  mime = "text/csv;charset=utf-8",
): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Trigger a client-side download from a data URL (e.g. an ECharts `getDataURL()`
 * PNG). Distinct from {@link downloadFile} because the content is already an
 * encoded URL, not raw text to be Blob-wrapped.
 */
export function downloadDataUrl(filename: string, dataUrl: string): void {
  if (typeof document === "undefined" || !dataUrl) return;
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.click();
}
