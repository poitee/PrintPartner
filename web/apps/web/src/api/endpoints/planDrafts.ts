import type {
  AcceptedPlanBasisContract,
  ApplyPlanDraftReceipt,
  PlanDraftIdentity,
  PlanDraftPartDecisionContract,
  PlanDraftWorkspace,
  RequiredUnitDecisionContract,
  ProfileSummary,
  SavePlanChoicesRequest,
} from "@print-partner/contracts";
import {
  parseAcceptedProgressImportResponse,
  parseApplyPlanDraftReceipt,
  parsePlanDraftIdentity,
  parsePlanDraftWorkspace,
  parseAcceptedPlanBasis,
  parseSavePlanChoicesRequest,
} from "@print-partner/contracts";
import { engineFetch, randomIdempotencyKey } from "../engineTransport";
import type { PlanReview } from "./planManifests";

export type SavePlanChoicesResponse = {
  receipt: ApplyPlanDraftReceipt;
  review: PlanReview;
  profile: ProfileSummary;
  closed_draft_ids: number[];
};

export async function savePlanChoices(
  profileId: number,
  request: SavePlanChoicesRequest,
  idempotencyKey: string,
): Promise<SavePlanChoicesResponse> {
  const body = await engineFetch<SavePlanChoicesResponse>(`/plans/${profileId}/save`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(parseSavePlanChoicesRequest(request)),
  });
  const receipt = parseApplyPlanDraftReceipt(body?.receipt);
  const review = body?.review;
  const profile = body?.profile;
  const basis = parseAcceptedPlanBasis(review?.accepted_basis);
  if (receipt.profile_id !== profileId || review?.profile_id !== profileId ||
      basis.profile_id !== profileId || profile?.id !== profileId ||
      basis.plan_version < receipt.plan_version ||
      (basis.plan_version === receipt.plan_version &&
        (basis.plan_revision_id !== receipt.revision_id ||
         basis.plan_revision_digest !== receipt.revision_digest ||
         basis.required_unit_mapping_digest !== receipt.required_unit_mapping_digest)) ||
      typeof review.plan_name !== "string" || !Array.isArray(review.layers) ||
      !Array.isArray(review.issues) || typeof review.has_blockers !== "boolean" ||
      !review.totals || !Number.isSafeInteger(review.totals.included_parts) ||
      !Number.isSafeInteger(review.totals.total_print_units) ||
      review.totals.included_parts < 0 || review.totals.total_print_units < 0 ||
      !review.totals.by_role || !review.totals.by_filament ||
      !Array.isArray(review.part_groups) || review.part_groups.some((group) =>
        !group || typeof group.folder !== "string" || !Array.isArray(group.parts) ||
        group.parts.some((part) => !part || !Number.isSafeInteger(part.id) || part.id <= 0 ||
          typeof part.match_key !== "string" || typeof part.relative_path !== "string" ||
          typeof part.filename !== "string" || typeof part.included !== "boolean" ||
          (part.source_layer !== null && typeof part.source_layer !== "string") ||
          typeof part.missing !== "boolean" || typeof part.filament_display !== "string" ||
          !Number.isSafeInteger(part.quantity_effective) || !Array.isArray(part.print_units) ||
          part.print_units.some((printed) => typeof printed !== "boolean") ||
          !Number.isSafeInteger(part.printed_count) || part.printed_count < 0)) ||
      typeof profile.name !== "string" || !Number.isSafeInteger(profile.part_count) ||
      !profile.accepted_progress || !["ready", "empty", "unavailable"].includes(profile.accepted_progress.kind) ||
      (profile.accepted_progress.kind === "ready" &&
        (!Number.isSafeInteger(profile.accepted_progress.total_units) || profile.accepted_progress.total_units < 0 ||
         !Number.isSafeInteger(profile.accepted_progress.remaining_units) || profile.accepted_progress.remaining_units < 0)) ||
      !profile.freshness || !["current", "stale", "untracked"].includes(profile.freshness.status) ||
      !Array.isArray(body.closed_draft_ids) ||
      body.closed_draft_ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("The saved Plan response is incomplete or belongs to a different Plan revision");
  }
  return { ...body, receipt, review: { ...review, accepted_basis: basis } };
}

export async function listPlanDrafts(profileId: number): Promise<PlanDraftIdentity[]> {
  const body = await engineFetch<{ drafts: PlanDraftIdentity[] }>(`/plans/${profileId}/drafts`);
  return body.drafts;
}

export async function fetchPlanDraftWorkspace(
  profileId: number,
  draftId: number,
): Promise<PlanDraftWorkspace> {
  return parsePlanDraftWorkspace(await engineFetch(`/plans/${profileId}/drafts/${draftId}`));
}

export async function recomputePlanDraft(
  profileId: number,
  options?: { applyManifest?: boolean },
): Promise<PlanDraftWorkspace> {
  return parsePlanDraftWorkspace(
    await engineFetch(`/plans/${profileId}/drafts/recompute`, {
      method: "POST",
      headers: { "Idempotency-Key": randomIdempotencyKey() },
      body: JSON.stringify({ apply_manifest: options?.applyManifest ?? false }),
    }),
  );
}

export async function editPlanDraftParts(input: {
  profileId: number;
  draftId: number;
  expectedSnapshotDigest: string;
  decisions: PlanDraftPartDecisionContract[];
}): Promise<PlanDraftWorkspace> {
  return parsePlanDraftWorkspace(
    await engineFetch(`/plans/${input.profileId}/drafts/${input.draftId}/parts`, {
      method: "PATCH",
      body: JSON.stringify({
        expected_snapshot_digest: input.expectedSnapshotDigest,
        decisions: input.decisions,
      }),
    }),
  );
}

export async function reconcilePlanDraft(input: {
  profileId: number;
  draftId: number;
  expectedSnapshotDigest: string;
  decisions: RequiredUnitDecisionContract[];
}): Promise<PlanDraftWorkspace> {
  return parsePlanDraftWorkspace(
    await engineFetch(`/plans/${input.profileId}/drafts/${input.draftId}/reconciliation`, {
      method: "PUT",
      headers: { "Idempotency-Key": randomIdempotencyKey() },
      body: JSON.stringify({
        expected_snapshot_digest: input.expectedSnapshotDigest,
        decisions: input.decisions,
      }),
    }),
  );
}

export async function applyPlanDraft(
  workspace: PlanDraftWorkspace,
  options?: { remapCheckoffLinks?: boolean },
): Promise<ApplyPlanDraftReceipt> {
  return parseApplyPlanDraftReceipt(
    await engineFetch(`/plans/${workspace.profile_id}/drafts/${workspace.draft.draft_id}/apply`, {
      method: "POST",
      headers: { "Idempotency-Key": randomIdempotencyKey() },
      body: JSON.stringify({
        expected_snapshot_digest: workspace.draft.snapshot_digest,
        expected_lifecycle_version: workspace.draft.lifecycle_version,
        expected_base: workspace.draft.base,
        ...(options?.remapCheckoffLinks ? { remap_checkoff_links: true } : {}),
      }),
    }),
  );
}

export async function abandonPlanDraft(
  profileId: number,
  draft: PlanDraftIdentity,
): Promise<PlanDraftIdentity> {
  return parsePlanDraftIdentity(
    await engineFetch(`/plans/${profileId}/drafts/${draft.draft_id}/abandon`, {
      method: "POST",
      body: JSON.stringify({ expected_lifecycle_version: draft.lifecycle_version }),
    }),
  );
}

export async function rebasePlanDraft(
  profileId: number,
  draft: PlanDraftIdentity,
): Promise<PlanDraftWorkspace> {
  return parsePlanDraftWorkspace(
    await engineFetch(`/plans/${profileId}/drafts/${draft.draft_id}/rebase`, {
      method: "POST",
      headers: { "Idempotency-Key": randomIdempotencyKey() },
      body: JSON.stringify({
        expected_source_state: draft.state === "open" ? "open" : "abandoned",
        expected_source_lifecycle_version: draft.lifecycle_version,
        expected_source_snapshot_digest: draft.snapshot_digest,
      }),
    }),
  );
}

export async function importAcceptedPrintedCounts(input: {
  profileId: number;
  expected: AcceptedPlanBasisContract;
  rows: Array<{ part_id: number; printed_count: number }>;
}): Promise<{ updated_parts: number }> {
  return parseAcceptedProgressImportResponse(
    await engineFetch(`/plans/${input.profileId}/progress/import`, {
      method: "POST",
      body: JSON.stringify({ expected: input.expected, rows: input.rows }),
    }),
  );
}
