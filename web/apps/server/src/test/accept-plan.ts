import type { AppRepository } from "../db/repository.js";
import type { PlanDraftSnapshot } from "../services/plan-drafts.js";
import type { RequiredUnitReconciliationDecision } from "../services/required-unit-reconciliation.js";

let commandSequence = 0;

function commandKey(label: string): string {
  commandSequence += 1;
  return `test:${label}:${commandSequence}`;
}

function reconcileDraft(repo: AppRepository, draft: PlanDraftSnapshot): PlanDraftSnapshot {
  const first = repo.savePlanDraftRequiredUnitReconciliation({
    profileId: draft.profileId,
    draftId: draft.id,
    expectedSnapshotDigest: draft.snapshotDigest,
    decisions: [],
    actorId: "test:fixture",
    idempotencyKey: commandKey("reconcile"),
  });
  if (first.kind !== "saved" && first.kind !== "existing") {
    throw new Error(`Test Plan reconciliation failed: ${first.kind}`);
  }
  if (first.reconciliation.resultKind === "ready") return first.draft;
  const decisions: RequiredUnitReconciliationDecision[] = first.reconciliation.conflicts.map(
    (conflict) => {
      switch (conflict.kind) {
        case "unsafe_predecessor":
          return {
            kind: "accept_prior_completion",
            targetDraftPartId: conflict.targetDraftPartId,
            predecessorRevisionPartId: conflict.predecessorRevisionPartId,
          };
        case "ambiguous_exact_match":
          return {
            kind: "select_exact_predecessor",
            targetDraftPartId: conflict.targetDraftPartId,
            predecessorRevisionPartId: conflict.candidateRevisionPartIds[0]!,
          };
        case "predecessor_claimed":
          return { kind: "replace", targetDraftPartId: conflict.targetDraftPartId };
      }
    },
  );
  const resolved = repo.savePlanDraftRequiredUnitReconciliation({
    profileId: draft.profileId,
    draftId: draft.id,
    expectedSnapshotDigest: first.draft.snapshotDigest,
    decisions,
    actorId: "test:fixture",
    idempotencyKey: commandKey("resolve"),
  });
  if (
    (resolved.kind !== "saved" && resolved.kind !== "existing") ||
    resolved.reconciliation.resultKind !== "ready"
  ) {
    throw new Error(`Test Plan reconciliation did not become ready: ${resolved.kind}`);
  }
  return resolved.draft;
}

function applyDraft(repo: AppRepository, draft: PlanDraftSnapshot): void {
  const ready = reconcileDraft(repo, draft);
  const expectedBase = ready.baseRevisionId == null
    ? { kind: "empty" as const, planVersion: 0 as const }
    : {
        kind: "revision" as const,
        revisionId: ready.baseRevisionId,
        planVersion: ready.basePlanVersion,
      };
  const result = repo.applyPlanChanges({
    profileId: ready.profileId,
    draftId: ready.id,
    expectedSnapshotDigest: ready.snapshotDigest,
    expectedLifecycleVersion: ready.lifecycleVersion,
    expectedBase,
    actorId: "test:fixture",
    idempotencyKey: commandKey("apply"),
  });
  if (result.kind !== "applied" && result.kind !== "existing" && result.kind !== "already_applied") {
    throw new Error(`Test Plan Apply failed: ${result.kind}`);
  }
}

export function acceptPlanForTest(repo: AppRepository, profileId: number): {
  merged: boolean;
  part_count?: number;
  reason?: string;
  layer_debug: Array<Record<string, unknown>>;
} {
  const result = repo.recomputePlanDraft({
    profileId,
    actor: "test:fixture",
    idempotencyKey: commandKey("draft"),
  });
  if (result.kind !== "created" && result.kind !== "existing") {
    return { merged: false, reason: result.kind, layer_debug: [] };
  }
  applyDraft(repo, result.draft);
  return { merged: true, part_count: result.draft.parts.length, layer_debug: [] };
}

export function editAcceptedPartsForTest(
  repo: AppRepository,
  profileId: number,
  edits: ReadonlyArray<{
    projectionPartId: number;
    included?: boolean;
    quantityOverride?: number;
  }>,
): ReadonlyMap<number, number> {
  const accepted = repo.getAcceptedPlanRevision(profileId);
  if (!accepted) throw new Error("Test accepted Plan is missing");
  const created = repo.recomputePlanDraft({
    profileId,
    actor: "test:fixture",
    idempotencyKey: commandKey("edit-draft"),
  });
  if (created.kind !== "created" && created.kind !== "existing") {
    throw new Error(`Test edit draft failed: ${created.kind}`);
  }
  const draftPartByProjection = new Map<number, number>();
  for (const acceptedPart of accepted.parts) {
    if (acceptedPart.projectionPartId == null) continue;
    const draftPart = created.draft.parts.find(
      (part) => part.baseRevisionPartId === acceptedPart.id,
    );
    if (draftPart) draftPartByProjection.set(acceptedPart.projectionPartId, draftPart.id);
  }
  const decisions = edits.flatMap((edit) => {
    const draftPartId = draftPartByProjection.get(edit.projectionPartId);
    if (!draftPartId) throw new Error("Test accepted Part is not present in the draft");
    return [
      ...(edit.quantityOverride !== undefined
        ? [{
            kind: "set_quantity_override" as const,
            partIds: [draftPartId],
            value: edit.quantityOverride,
          }]
        : []),
      ...(edit.included !== undefined
        ? [{ kind: "set_included" as const, partIds: [draftPartId], value: edit.included }]
        : []),
    ];
  });
  const edited = repo.editPlanDraftPartsBatch({
    profileId,
    draftId: created.draft.id,
    expectedSnapshotDigest: created.draft.snapshotDigest,
    decisions,
  });
  if (edited.kind !== "updated" && edited.kind !== "unchanged") {
    throw new Error(`Test Plan edit failed: ${edited.kind}`);
  }
  applyDraft(repo, edited.draft);
  const updated = repo.getAcceptedPlanRevision(profileId);
  if (!updated) throw new Error("Test edited Plan is missing");
  const projectionPartIdByPartKey = new Map(
    updated.parts.flatMap((part) =>
      part.projectionPartId == null ? [] : [[part.partKey, part.projectionPartId] as const],
    ),
  );
  return new Map(
    edits.map((edit) => {
      const prior = accepted.parts.find((part) => part.projectionPartId === edit.projectionPartId);
      const projectionPartId = prior && projectionPartIdByPartKey.get(prior.partKey);
      if (!projectionPartId) throw new Error("Test edited Part projection is missing");
      return [edit.projectionPartId, projectionPartId] as const;
    }),
  );
}
