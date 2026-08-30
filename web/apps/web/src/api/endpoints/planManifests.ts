import type { AcceptedPlanBasisContract, PartRow } from "@print-partner/contracts";
import { parseAcceptedPlanBasis } from "@print-partner/contracts";
import { engineFetch } from "../engineTransport";
import type {
  RepoManifestDocument,
  RepoManifestOptionGroup,
  RepoManifestVariant,
  ScannedManifestPart,
} from "./sourceArtifacts";
import type { ProfileLayer } from "./plans";

export type ChoiceTreeNode = {
  id: string;
  label?: string;
  type?: "pick_one" | "pick_any" | "addon_toggle";
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
  selections: Record<string, string>;
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

export type ManifestV2 = {
  profile_id: number;
  version: number;
  yaml: string;
  plan: {
    name: string | null;
    base_source_id: string | null;
    addon_source_ids: string[];
  };
  sources: Array<{
    id: string;
    kind: string;
    url: string | null;
    branch: string | null;
    role: string | null;
  }>;
  selections: Record<string, string>;
  option_groups: Record<
    string,
    {
      rule: string;
      label: string | null;
      parts: string[];
      variants: RepoManifestVariant[];
    }
  >;
  slots?: Record<
    string,
    {
      label: string | null;
      default_group: string | null;
    }
  >;
  choice_tree?: ChoiceTreeNode[];
  option_group_count: number;
  addon_count: number;
};

export type PlanManifestBuilderSource = {
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

export type PlanManifestBuilderBootstrap = {
  profile_id: number;
  sources: PlanManifestBuilderSource[];
  merged_option_groups: Record<string, RepoManifestOptionGroup>;
};

export type ManifestWarning = {
  code: string;
  message: string;
  severity: string;
  match_key: string | null;
};

export type ManifestSummary = {
  profile_id: number;
  required: { total: number; included: number };
  optional: { total: number; included: number };
  recommended: { total: number; included: number };
  option_groups: Array<{
    id: string;
    rule: string;
    members: number;
    selected: number;
    min: number | null;
    max: number | null;
  }>;
};

export type ManifestTemplateSummary = {
  id: string;
  label: string;
  category: string;
  available: string;
};

export type ManifestTemplatePayload = {
  id: string;
  label: string;
  category: string;
  yaml: string;
  document: RepoManifestDocument;
};

export type ManifestRegistryEntry = {
  slug: string;
  target_repo: string;
  title: string | null;
  manifest_file: string;
};

export type KitCatalogBase = {
  label: string;
  source_name: string;
  compatible_addons: string[];
  printer_family?: string;
  default_addons?: string[];
};

export type KitCatalogSourceEntry = {
  name: string;
  variant_id?: string;
  compatible_bases?: string[];
};

export type KitCatalogCategory = {
  label: string;
  rule: string;
  replaces_slot?: string;
  sources: KitCatalogSourceEntry[];
};

export type KitCatalogStackPreset = {
  label: string;
  base: string;
  addon_sources: string[];
  default_selections?: Record<string, string>;
};

export type KitCatalog = {
  version: number;
  bases: Record<string, KitCatalogBase>;
  addon_categories: Record<string, KitCatalogCategory>;
  stack_presets?: Record<string, KitCatalogStackPreset>;
};

export type PlanMaintenanceEntry = {
  profile_id: number;
  name: string;
  warning_count: number;
  warnings: ManifestWarning[];
};

export type PlansMaintenanceReport = {
  plans_with_warnings: PlanMaintenanceEntry[];
};

export type PlanReviewIssue = {
  code: string;
  message: string;
  severity: "blocker" | "warning";
  link_hint?: "sources" | "build" | null;
};

export type PlanReviewLayer = {
  id: number;
  layer_type: string;
  project_id: number | null;
  project_name: string | null;
  local_path: string | null;
  synced: boolean;
  last_synced_at: string | null;
};

export type PlanReviewTotals = {
  included_parts: number;
  total_print_units: number;
  by_role: Record<string, number>;
  by_filament: Record<string, number>;
};

/** Plan part row with print progress (unified Review API). */
export type ReviewPart = PartRow & {
  printed_count: number;
  print_units: boolean[];
  /** Assembly tracking: which completed units have been physically installed. */
  assembled_units?: boolean[];
  /** Checkoff: not fully printed yet (printed_count < qty). */
  missing: boolean;
  /** On-disk STL absent for an included part (GRE-235). */
  stl_missing?: boolean;
  /** Included part has STL but no cached thumbnail PNG (GRE-235). */
  thumb_empty?: boolean;
  filament_display: string;
  filament_hex?: string | null;
  spool_summary?: Array<{ remaining_g: number; spool_id: number }>;
  spool_badge?: string | null;
};

export type PlanReviewPartGroup = {
  folder: string;
  source_layer: string | null;
  parts: ReviewPart[];
};

export type PlanReview = {
  profile_id: number;
  accepted_basis: AcceptedPlanBasisContract | null;
  plan_name: string;
  layers: PlanReviewLayer[];
  totals: PlanReviewTotals;
  issues: PlanReviewIssue[];
  has_blockers: boolean;
  part_groups: PlanReviewPartGroup[];
};

export type BuildPlanningEvidence = {
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

export async function fetchKitCatalog(): Promise<KitCatalog> {
  return engineFetch<KitCatalog>("/kit-catalog");
}

export async function fetchPlansMaintenance(): Promise<PlansMaintenanceReport> {
  return engineFetch<PlansMaintenanceReport>("/plans/maintenance");
}

export async function fetchManifestTemplates(): Promise<ManifestTemplateSummary[]> {
  const body = await engineFetch<{ templates: ManifestTemplateSummary[] }>(
    "/manifest-templates",
  );
  return body.templates;
}

export async function fetchManifestTemplate(
  templateId: string,
): Promise<ManifestTemplatePayload> {
  return engineFetch<ManifestTemplatePayload>(`/manifest-templates/${templateId}`);
}

export async function fetchManifestRegistry(): Promise<ManifestRegistryEntry[]> {
  const body = await engineFetch<{ entries: ManifestRegistryEntry[] }>(
    "/manifest-registry",
  );
  return body.entries;
}

export async function fetchCommunityManifest(slug: string): Promise<{
  slug: string;
  yaml: string;
  document: RepoManifestDocument;
}> {
  return engineFetch(`/manifest-registry/${encodeURIComponent(slug)}`);
}

export async function fetchProfileParts(profileId: number): Promise<PartRow[]> {
  const body = await engineFetch<{ parts: PartRow[] }>(
    `/plans/${profileId}/parts?limit=10000`,
  );
  return body.parts;
}

export async function fetchManifestSummary(
  profileId: number,
): Promise<ManifestSummary> {
  return engineFetch<ManifestSummary>(`/plans/${profileId}/manifest-summary`);
}

export async function fetchManifestWarnings(
  profileId: number,
): Promise<ManifestWarning[]> {
  const body = await engineFetch<{ warnings: ManifestWarning[] }>(
    `/plans/${profileId}/manifest-warnings`,
  );
  return body.warnings;
}

export async function fetchPlanReview(
  profileId: number,
  options?: { includeExcluded?: boolean },
): Promise<PlanReview> {
  const qs = options?.includeExcluded === true ? "?include_excluded=true" : "";
  const review = await engineFetch<PlanReview>(`/plans/${profileId}/review${qs}`);
  return {
    ...review,
    accepted_basis:
      review.accepted_basis == null ? null : parseAcceptedPlanBasis(review.accepted_basis),
  };
}

export async function fetchManifestV2(profileId: number): Promise<ManifestV2> {
  return engineFetch<ManifestV2>(`/plans/${profileId}/manifest-v2`);
}

export async function fetchPlanManifestSummary(
  profileId: number,
): Promise<ManifestSummary> {
  return engineFetch<ManifestSummary>(`/plans/${profileId}/manifest-summary`);
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

export async function fetchPlanParts(profileId: number): Promise<PartRow[]> {
  const body = await engineFetch<{ parts: PartRow[] }>(
    `/plans/${profileId}/parts?limit=10000`,
  );
  return body.parts;
}

export async function fetchPlanManifestWarnings(
  profileId: number,
): Promise<ManifestWarning[]> {
  const body = await engineFetch<{ warnings: ManifestWarning[] }>(
    `/plans/${profileId}/manifest-warnings`,
  );
  return body.warnings;
}
