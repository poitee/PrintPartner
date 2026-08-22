import type { QueryClient } from "@tanstack/react-query";
import type { JobSnapshot } from "../api/engine";
import { queryKeys } from "./keys";
import { invalidateProfiles } from "./profiles";
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

/** Invalidate TanStack Query caches after a background job completes. */
export function invalidateAfterJob(
  qc: QueryClient,
  kind: string,
  snapshot: JobSnapshot,
  profileId?: number | null,
) {
  if (kind === "export-accepted-plate-3mf" && profileId != null) {
    void invalidateAcceptedPlateExportJobs(qc, profileId);
  }

  if (snapshot.status !== "done") return;

  if (SOURCE_MUTATION_KINDS.has(kind)) {
    void invalidateSources(qc);
    void invalidateProfiles(qc);
    void qc.invalidateQueries({ queryKey: queryKeys.planReviews });
  }

  if (kind === "stl-export" || kind === "export-kit-bundle" || kind === "export-checklist-html") {
    // Exports don't change cached reads; no invalidation needed.
  }
}
