import { toast } from "sonner";
import type { JobSnapshot } from "../api/engine";
import { completeExportDownload } from "./exportActions";
type CompleteExportOptions = {
  pathField?: "path" | "root_path" | "primary_path";
  suggestedFilename?: string;
};

function warningsFromResult(result: Record<string, unknown> | null | undefined): string[] {
  if (!Array.isArray(result?.warnings)) return [];
  return result.warnings.filter((w): w is string => typeof w === "string");
}

function fileTotalFromResult(result: Record<string, unknown> | null | undefined): number | undefined {
  const v = result?.file_total;
  return typeof v === "number" ? v : undefined;
}

/** Handle STL pack export job completion — download, zero-file errors, and warning surfacing. */
export function handleStlPackExportJobDone(
  title: string,
  snap: JobSnapshot,
  options?: CompleteExportOptions,
): void {
  if (snap.status === "error") {
    toast.error(snap.message || `${title} failed`);
    return;
  }

  const result = snap.result;
  const fileTotal = fileTotalFromResult(result);
  const warnings = warningsFromResult(result);

  if (fileTotal === 0) {
    toast.error(warnings[0] ?? snap.message ?? "No STL files exported", {
      description: "Sync Sources and fix Review blockers, then try again.",
      duration: 12_000,
    });
    return;
  }

  completeExportDownload(title, result, options);

  if (warnings.length > 0) {
    const preview = warnings.slice(0, 3).join("\n");
    const more = warnings.length > 3 ? `\n…and ${warnings.length - 3} more` : "";
    toast.warning(`${title}: ${warnings.length} warning(s)`, {
      description: preview + more,
      duration: 12_000,
    });
  }
}
