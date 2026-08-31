import type { SourceSummary } from "@print-partner/contracts";
import type { SourceKind } from "../components/sources/sourceLabels";

const AUTOMATIC_KINDS = new Set(["github", "git"]);
const TRACKED_MODEL_KINDS = new Set(["printables", "makerworld", "thangs"]);

export type SourceMonitoringCapability = "automatic" | "manual_model" | "local";

export function sourceMonitoringCapability(kind: string): SourceMonitoringCapability {
  if (AUTOMATIC_KINDS.has(kind)) return "automatic";
  if (TRACKED_MODEL_KINDS.has(kind)) return "manual_model";
  return "local";
}
export function sourceModelUrlPlaceholder(kind: SourceKind): string {
  switch (kind) {
    case "printables":
      return "www.printables.com/model/…";
    case "makerworld":
      return "makerworld.com/en/models/…";
    case "thangs":
      return "thangs.com/designer/…/3d-model/…";
    default:
      return "github.com/org/repo.git";
  }
}

export function sourceMonitoringSummary(sources: readonly SourceSummary[]) {
  let automaticCount = 0;
  let manualTrackedCount = 0;
  let updateCount = 0;
  let lastCheckedAt: string | null = null;
  let lastCheckedTime = Number.NEGATIVE_INFINITY;

  for (const source of sources) {
    const capability = sourceMonitoringCapability(source.source_kind);
    if (capability === "automatic") automaticCount += 1;
    if (capability === "manual_model") manualTrackedCount += 1;
    if (source.update_status === "updates_available") updateCount += 1;
    if (source.update_checked_at) {
      const time = Date.parse(source.update_checked_at);
      if (!Number.isNaN(time) && time > lastCheckedTime) {
        lastCheckedTime = time;
        lastCheckedAt = source.update_checked_at;
      }
    }
  }

  return {
    automaticCount,
    manualTrackedCount,
    updateCount,
    lastCheckedAt,
  } as const;
}
