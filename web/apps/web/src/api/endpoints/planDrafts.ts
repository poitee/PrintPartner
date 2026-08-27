import type {
  AcceptedPlanBasisContract,
  ApplyPlanDraftReceipt,
  PlanDraftIdentity,
  PlanDraftPartDecisionContract,
  PlanDraftWorkspace,
  RequiredUnitDecisionContract,
} from "@print-partner/contracts";
import {
  parseAcceptedProgressImportResponse,
  parseApplyPlanDraftReceipt,
  parsePlanDraftIdentity,
  parsePlanDraftWorkspace,
} from "@print-partner/contracts";
import { engineFetch, randomIdempotencyKey } from "../engineTransport";

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

export async function recomputePlanDraft(profileId: number): Promise<PlanDraftWorkspace> {
  return parsePlanDraftWorkspace(
    await engineFetch(`/plans/${profileId}/drafts/recompute`, {
      method: "POST",
      headers: { "Idempotency-Key": randomIdempotencyKey() },
      body: JSON.stringify({ apply_manifest: true }),
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
