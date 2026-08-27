import type { ProfileSummary, SourceSummary } from "@print-partner/contracts";
import type { RoleFilamentRow } from "../api/endpoints/filaments";
import type { PlanReview } from "../api/endpoints/planManifests";
import { canArchivePlan } from "./planPickerGroups";
import { planHeaderSubtitle } from "./planWarnings";
import { checkoffUnitTotals } from "./checkoffProgress";

export type BuildPageDerivedInput = {
  selectedProfile: ProfileSummary | undefined;
  review: PlanReview | null | undefined;
  attachedSources: SourceSummary[];
  roleFilaments: RoleFilamentRow[];
  sourceCardLayerCount: number;
  buildStale: boolean;
};

export type BuildPageDerivedState = {
  partCount: number;
  archiveAllowed: boolean;
  headerSubtitle: string;
};

/**
 * Page chrome for the Sources workspace: what the header says and which Build
 * actions are legal. Setup status lives in `sourcesSetupTasks`, so warnings are
 * not duplicated here as a second, quieter opinion.
 */
export function buildPageDerivedState(input: BuildPageDerivedInput): BuildPageDerivedState {
  const partCount = input.selectedProfile?.part_count ?? input.review?.totals.included_parts ?? 0;
  const includedForArchive =
    input.review?.part_groups.flatMap((group) => group.parts).filter((part) => part.included) ?? [];
  const archiveTotals = checkoffUnitTotals(includedForArchive);
  const archiveAllowed = canArchivePlan({
    archived: Boolean(input.selectedProfile?.archived_at),
    totalUnits: archiveTotals.totalUnits,
    remainingUnits: archiveTotals.remainingUnits,
  });
  const headerSubtitle = planHeaderSubtitle({
    profile: input.selectedProfile,
    sourceCount: input.sourceCardLayerCount,
    partCount,
  });

  return { partCount, archiveAllowed, headerSubtitle };
}
