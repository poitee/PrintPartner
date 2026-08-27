import { EngineHttpError, engineFetch } from "../engineTransport";

export type PlanPhaseDefinition = {
  name: string;
  order: number;
  description?: string;
  /** Repo-relative folder paths whose STL/3MF files belong to this phase. */
  folders: string[];
  /** Names of phases that must be fully printed before this phase can start. */
  depends_on: string[];
  /** Optional hex color for the phase badge, e.g. '#4A90D9'. */
  color?: string;
};

export type PlanPhaseManifestResponse = {
  profile_id: number;
  /** True when at least one source in the plan has a pp-phases.json. */
  has_phases: boolean;
  phases: PlanPhaseDefinition[];
};

/**
 * Fetch the phase manifest for a plan.
 * Returns has_phases=false with an empty phases array when no source has a
 * pp-phases.json; the UI should fall back to the flat parts list in that case.
 */
export async function fetchPlanPhaseManifest(
  profileId: number,
): Promise<PlanPhaseManifestResponse> {
  try {
    return await engineFetch<PlanPhaseManifestResponse>(`/plans/${profileId}/phase-manifest`);
  } catch (error) {
    if (error instanceof EngineHttpError && error.status === 404) {
      return {
        profile_id: profileId,
        has_phases: false,
        phases: [],
      };
    }
    throw error;
  }
}

export type PlanVariantDimensionsResponse = {
  profile_id: number;
  source_id: number | null;
  dimensions: Record<string, Array<string | number>>;
  selection: Record<string, string>;
};

/** Fetch variant_dimensions declared in the base source manifest, plus the current selection. */
export async function fetchPlanVariantDimensions(
  profileId: number,
): Promise<PlanVariantDimensionsResponse> {
  return engineFetch<PlanVariantDimensionsResponse>(`/plans/${profileId}/variant-dimensions`);
}

/** Apply a variant selection to the plan (updates import rules on base source). */
export async function applyPlanVariantSelection(
  profileId: number,
  selection: Record<string, string>,
  sourceId?: number,
): Promise<{ profile_id: number; source_id: number; rules: string[]; selection: Record<string, string> }> {
  return engineFetch(`/plans/${profileId}/variant-selection`, {
    method: "POST",
    body: JSON.stringify({ selection, ...(sourceId != null ? { source_id: sourceId } : {}) }),
  });
}
