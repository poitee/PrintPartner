import type { QueryClient } from "@tanstack/react-query";
import type { JobSnapshot } from "@print-partner/contracts";
import { queryKeys } from "./keys";
import { invalidateProfiles } from "./profiles";
import { invalidateSourceContent } from "./sourceContent";
import { invalidateSources } from "./sources";
import {
  invalidateAcceptedPlateExportJobs,
} from "./acceptedPlates";

const SYNC_KINDS = new Set(["sync", "sync-all", "check-source-updates", "import-scan"]);
const SOURCE_MUTATION_KINDS = new Set([
  "import-repos-txt",
  "import-kit-bundle",
  ...SYNC_KINDS,
]);

export type JobInvalidationOptions = {
  sourceIds?: readonly number[];
  /** True only when health reports `tenant_feature_toggles`. */
  rebuild?: boolean;
};

/**
 * Invalidate cached reads after a background job reaches a terminal snapshot.
 * With rebuild reads, a finished import scan refreshes that source, and a
 * finished plan publication refreshes that plan. Other finished source jobs
 * still refresh the shared source, profile, and plan review caches.
 */
export function invalidateAfterJob(
  qc: QueryClient,
  kind: string,
  snapshot: JobSnapshot,
  profileId?: number | null,
  options?: JobInvalidationOptions,
) {
  if (kind === "export-accepted-plate-3mf" && profileId != null) {
    void invalidateAcceptedPlateExportJobs(qc, profileId);
  }

  if (snapshot.status !== "done") return;

  if (options?.rebuild) {
    let scoped = false;
    if (kind === "import-scan") {
      const sourceIds = importedSourceIds(snapshot, options.sourceIds);
      if (sourceIds.length > 0) invalidateOwnedSourceQueries(qc, sourceIds);
      scoped = true;
    }
    const publishedPlan = publishedPlanId(snapshot);
    if (publishedPlan != null) {
      invalidateMatchingPlan(qc, publishedPlan);
      scoped = true;
    }
    if (scoped) return;
  }

  if (SOURCE_MUTATION_KINDS.has(kind)) {
    void invalidateSources(qc);
    void invalidateProfiles(qc);
    void qc.invalidateQueries({ queryKey: queryKeys.planReviews });
  }

  if (kind === "stl-export" || kind === "export-kit-bundle" || kind === "export-checklist-html") {
    // Exports don't change cached reads; no invalidation needed.
  }
}

function positiveId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function resultRecord(snapshot: JobSnapshot): Record<string, unknown> | null {
  const result = snapshot.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  return result;
}

/** The completion result names the source. The start-time ids are the fallback. */
function importedSourceIds(
  snapshot: JobSnapshot,
  fallback: readonly number[] | undefined,
): number[] {
  const result = resultRecord(snapshot);
  const fromResult: number[] = [];
  if (result) {
    const projectId = positiveId(result.project_id);
    if (projectId) fromResult.push(projectId);
    if (Array.isArray(result.results)) {
      for (const row of result.results) {
        if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
        const id = positiveId(row.project_id);
        if (id) fromResult.push(id);
      }
    }
  }
  const ids = fromResult.length > 0
    ? fromResult
    : (fallback ?? []).flatMap((id) => {
        const parsed = positiveId(id);
        return parsed == null ? [] : [parsed];
      });
  return [...new Set(ids)];
}

/** An apply receipt names one plan. Export results do not carry `draft_id`. */
function publishedPlanId(snapshot: JobSnapshot): number | null {
  const result = resultRecord(snapshot);
  if (!result) return null;
  const profileId = positiveId(result.profile_id);
  if (profileId == null || positiveId(result.draft_id) == null || positiveId(result.revision_id) == null) {
    return null;
  }
  return profileId;
}

function invalidateOwnedSourceQueries(qc: QueryClient, sourceIds: readonly number[]): void {
  void qc.invalidateQueries({ queryKey: queryKeys.sources, exact: true });
  void qc.invalidateQueries({ queryKey: queryKeys.sourceActivity });
  for (const sourceId of sourceIds) {
    void invalidateSourceContent(qc, sourceId);
  }
}

function invalidateMatchingPlan(qc: QueryClient, profileId: number): void {
  void qc.invalidateQueries({
    predicate: (query) => query.queryKey[0] === "planReview" && query.queryKey[1] === profileId,
  });
  void qc.invalidateQueries({ queryKey: queryKeys.planLayers(profileId) });
  void qc.invalidateQueries({ queryKey: queryKeys.planDrafts(profileId) });
  void qc.invalidateQueries({
    predicate: (query) => query.queryKey[0] === "planDraft" && query.queryKey[1] === profileId,
  });
  void qc.invalidateQueries({ queryKey: queryKeys.buildWorkflow(profileId) });
  void qc.invalidateQueries({ queryKey: queryKeys.checkoff(profileId) });
  void qc.invalidateQueries({ queryKey: queryKeys.acceptedPlateWorkspace(profileId) });
  void qc.invalidateQueries({ queryKey: queryKeys.acceptedPlateExportJobs(profileId) });
  void qc.invalidateQueries({ queryKey: queryKeys.profile(profileId) });
}
