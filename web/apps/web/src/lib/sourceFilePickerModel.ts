import type { SourceSummary } from "@print-partner/contracts";

export type AttachedSourceStateLabel = {
  text: string;
  tone: "muted" | "warn" | "sync";
};

export function attachedSourceStateLabel(input: {
  source: SourceSummary | null | undefined;
  formatDate: (iso: string | null | undefined) => string;
  selectedCount: number;
  totalFiles: number;
  syncing: boolean;
  syncMessage: string;
}): AttachedSourceStateLabel {
  if (input.syncing) {
    return { text: input.syncMessage || "syncing", tone: "sync" };
  }
  if (input.source?.update_status === "updates_available") {
    return { text: "update available", tone: "warn" };
  }
  if (input.source?.source_kind === "local") {
    const picks =
      input.totalFiles > 0
        ? ` · ${input.selectedCount} of ${input.totalFiles} files`
        : input.selectedCount > 0
          ? ` · ${input.selectedCount} picks`
          : "";
    return { text: `local folder · always current${picks}`, tone: "muted" };
  }
  if (!input.source?.last_synced_at) {
    return { text: "not synced", tone: "warn" };
  }
  const formatted = input.formatDate(input.source.last_synced_at);
  const syncBit = formatted ? `synced ${formatted}` : "synced";
  const picks =
    input.totalFiles > 0
      ? ` · ${input.selectedCount} of ${input.totalFiles} files`
      : input.selectedCount > 0
        ? ` · ${input.selectedCount} picks`
        : "";
  return { text: `${syncBit}${picks}`, tone: "muted" };
}
