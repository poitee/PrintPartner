import { toast } from "sonner";
import { downloadExport } from "../api/engine";

export type ExportJobResult = Record<string, unknown> | null | undefined;

type CompleteExportOptions = {
  pathField?: "path" | "root_path" | "primary_path";
  suggestedFilename?: string;
};

function pathFromResult(result: ExportJobResult, field: string): string | undefined {
  const v = result?.[field];
  return typeof v === "string" ? v : undefined;
}

/** Prefer browser download via download_url; fall back to a toast with the server path. */
export function completeExportDownload(
  title: string,
  result: ExportJobResult,
  options?: CompleteExportOptions,
): void {
  const pathField = options?.pathField ?? "path";
  const downloadUrl = result?.download_url;
  if (typeof downloadUrl === "string") {
    downloadExport(downloadUrl, options?.suggestedFilename);
    toast.success(`${title} downloaded`);
    return;
  }

  const filePath =
    pathFromResult(result, pathField) ??
    pathFromResult(result, "primary_path") ??
    pathFromResult(result, "root_path") ??
    pathFromResult(result, "path");

  if (typeof filePath === "string") {
    toast.success(title, { description: filePath, duration: 12_000 });
    return;
  }

  toast.success(title);
}

/** Download multiple files when the job result includes per-file download_url entries. */
export function completeMultiFileExportDownload(title: string, result: ExportJobResult): void {
  const paths = result?.paths as Array<{ download_url?: string }> | undefined;
  if (Array.isArray(paths)) {
    let count = 0;
    for (const entry of paths) {
      if (typeof entry.download_url === "string") {
        downloadExport(entry.download_url);
        count++;
      }
    }
    if (count > 0) {
      toast.success(`${title}: ${count} file(s) downloaded`);
      return;
    }
  }
  completeExportDownload(title, result, { pathField: "primary_path" });
}
