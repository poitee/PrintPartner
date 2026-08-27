import type { ProfileSummary, SourceSummary } from "@print-partner/contracts";
import type { RoleFilamentRow } from "../api/endpoints/filaments";
import type { PlanReview } from "../api/endpoints/planManifests";
import { canArchivePlan } from "./planPickerGroups";
import { buildPlanWarningLines, planHeaderSubtitle } from "./planWarnings";
import { planHasUnsetRoleColors } from "./roleColorSet";
import { deskNextStepLine } from "./deskNextStep";
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
  planWarnings: string[];
  colorsUnset: boolean;
  planNextStep: string | null;
  headerSubtitle: string;
};

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
  const planWarnings = buildPlanWarningLines({
    buildStale: input.buildStale,
    attachedSources: input.attachedSources,
    review: input.review ?? null,
    roleFilaments: input.roleFilaments,
  });
  const colorsUnset = planHasUnsetRoleColors(input.roleFilaments);
  const planNextStep = deskNextStepLine("plan", {
    attachedSourceCount: input.sourceCardLayerCount,
    partCount,
    colorsUnset,
  });
  const headerSubtitle = planHeaderSubtitle({
    profile: input.selectedProfile,
    sourceCount: input.sourceCardLayerCount,
    partCount,
  });

  return {
    partCount,
    archiveAllowed,
    planWarnings,
    colorsUnset,
    planNextStep,
    headerSubtitle,
  };
}
