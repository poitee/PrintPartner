import type {
  ManifestSelections,
} from "@print-partner/contracts";
import { parsePlanReview, type PlanReview } from "../planReview";
export type { PlanReview, PlanReviewIssue, PlanReviewPartGroup } from "../planReview";
import { engineFetch } from "../engineTransport";
import type {
  RepoManifestDocument,
  RepoManifestOptionGroup,
  ScannedManifestPart,
} from "./sourceArtifacts";
import type { ProfileLayer } from "./plans";

export type { ReviewPart } from "@print-partner/contracts";

export type ChoiceTreeNode = {
  id: string;
  label?: string;
  type?: "pick_one" | "pick_any" | "pick_n" | "addon_toggle";
  group?: string;
  source_id?: string;
  replaces_slot?: string;
  sources?: string[];
  children?: ChoiceTreeNode[];
};

export type KitManifest = {
  name: string | null;
  layers: string[];
  base_source_id?: string | null;
  addon_source_ids?: string[];
  selections: ManifestSelections;
  include: string[];
  exclude: string[];
  replacements?: Record<string, string>;
  choice_tree?: ChoiceTreeNode[];
  /** UI-only cache for cross-repo folder links (authoritative rules live in repo YAML). */
  category_links?: Array<{
    categoryId: string;
    members: Array<{ source: string; pathGlob: string }>;
  }>;
};

type PlanManifestBuilderSource = {
  source_id: number;
  layer_type: string;
  name: string;
  role: string;
  url: string;
  exists: boolean;
  path: string;
  yaml: string;
  document: RepoManifestDocument;
  scanned_parts: ScannedManifestPart[];
};

type PlanManifestBuilderBootstrap = {
  profile_id: number;
  sources: PlanManifestBuilderSource[];
  resolved_selections?: ManifestSelections;
  merged_option_groups: Record<string, RepoManifestOptionGroup>;
};

export type ManifestRegistryEntry = {
  slug: string;
  target_repo: string;
  title: string | null;
  manifest_file: string;
};

type BuildPlanningEvidence = {
  id: string;
  normalized_url: string;
  kind: string;
  input_kind?: "url" | "model_page" | "upload";
  source_role?: string;
  sync_status?: "pending" | "synced" | "failed";
  pinned_revision?: string;
  upload_required?: boolean;
  artifacts?: Array<{
    path: string;
    format: "stl" | "3mf" | "zip";
    byte_size: number;
  }>;
};

export type BuildPlanningState = {
  planning_phase:
    | { kind: "preparing" }
    | { kind: "draft"; draft_id: number }
    | { kind: "applied"; draft_id: number; revision_id: number | null }
    | { kind: "abandoned"; draft_id: number }
    | { kind: "missing_draft"; draft_id: number };
  brief: {
    special_request: string;
    requirements: Array<{ key: string; value: string; status: string; detail?: string }>;
    evidence: BuildPlanningEvidence[];
    contributions: Array<{ id: string; slot: string; status: string; responsibility: string }>;
    compatibility_findings?: Array<{
      id: string;
      subject: string;
      status: string;
      detail: string;
    }>;
    role_filaments: Array<{ role: string; requested_name?: string; inventory_kind: string }>;
    draft_id?: number;
  };
  readiness: { ready: boolean; blockers: Array<{ code: string; detail: string }> };
  grouped_difference_count: number;
  difference_count: number;
};

export async function fetchPlanManifestBuilder(
  profileId: number,
): Promise<PlanManifestBuilderBootstrap> {
  return engineFetch(`/plans/${profileId}/plan-manifest-builder`);
}

export async function fetchManifestRegistry(): Promise<ManifestRegistryEntry[]> {
  const body = await engineFetch<{ entries: ManifestRegistryEntry[] }>(
    "/manifest-registry",
  );
  return body.entries;
}

export async function fetchPlanReview(
  profileId: number,
  options?: { includeExcluded?: boolean },
): Promise<PlanReview> {
  const qs = options?.includeExcluded === true ? "?include_excluded=true" : "";
  return parsePlanReview(await engineFetch<unknown>(`/plans/${profileId}/review${qs}`), profileId);
}

export async function fetchPlanKitManifest(profileId: number): Promise<KitManifest> {
  const body = await engineFetch<{ kit: KitManifest }>(`/plans/${profileId}/kit-manifest`);
  return body.kit;
}

export async function savePlanKitManifest(
  profileId: number,
  kit: KitManifest,
): Promise<KitManifest> {
  const body = await engineFetch<{ kit: KitManifest }>(`/plans/${profileId}/kit-manifest`, {
    method: "PUT",
    body: JSON.stringify({ kit }),
  });
  return body.kit;
}

export async function fetchPlanLayers(profileId: number): Promise<ProfileLayer[]> {
  const body = await engineFetch<{ layers: ProfileLayer[] }>(`/plans/${profileId}/layers`);
  return body.layers;
}

export async function fetchBuildPlanningState(
  profileId: number,
  draftId?: number | null,
): Promise<BuildPlanningState | null> {
  const draftQuery = draftId == null ? "" : `?draft_id=${encodeURIComponent(String(draftId))}`;
  const result = await engineFetch<{ planning: BuildPlanningState | null }>(
    `/plans/${profileId}/build-planning${draftQuery}`,
  );
  return result.planning;
}
