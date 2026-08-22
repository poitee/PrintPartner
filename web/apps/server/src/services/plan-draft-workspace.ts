import type {
  ApplyPlanDraftRequest,
  AbandonPlanDraftRequest,
  EditPlanDraftPartsRequest,
  PlanDraftIdentity,
  PlanDraftPartView,
  PlanDraftWorkspace,
  ReconcilePlanDraftRequest,
  RebasePlanDraftRequest,
  RequiredUnitDecisionContract,
} from "@print-partner/contracts";
import type {
  AppliedPlanReceipt,
  AppRepository,
  ApplyPlanChangesResult,
  EditPlanDraftPartsResult,
  RecomputePlanDraftResult,
  SavePlanDraftRequiredUnitReconciliationResult,
  RebasePlanDraftResult,
  TransitionPlanDraftResult,
} from "../db/repository.js";
import type { PlanDraftPart, PlanDraftSnapshot } from "./plan-drafts.js";
import type { RequiredUnitReconciliationDecision } from "./required-unit-reconciliation.js";

export type PlanDraftWorkspaceFailure =
  | { readonly kind: "profile_not_found" | "draft_not_found" }
  | {
      readonly kind:
        | "accepted_baseline_required"
        | "base_changed"
        | "inputs_changed"
        | "draft_changed"
        | "idempotency_conflict"
        | "not_open"
        | "base_unchanged";
      readonly workspace?: PlanDraftWorkspace;
    }
  | { readonly kind: "reconciliation_required"; readonly reason: "missing" | "unresolved" | "stale" }
  | { readonly kind: "production_active"; readonly checkoff_link_count: number; readonly send_queue_item_count: number }
  | {
      readonly kind: "checkoff_remap_unsafe";
      readonly unmappable: readonly { linkId: string; filename: string; reason: string }[];
    }
  | { readonly kind: "transaction_unavailable" }
  | { readonly kind: "merge_conflicts"; readonly conflicts: readonly Record<string, unknown>[] }
  | { readonly kind: "domain_error"; readonly code: string };

export type PlanDraftWorkspaceResult =
  | { readonly kind: "ready"; readonly workspace: PlanDraftWorkspace }
  | PlanDraftWorkspaceFailure;

export type ApplyDraftWorkspaceResult =
  | { readonly kind: "applied"; readonly receipt: AppliedPlanReceipt }
  | PlanDraftWorkspaceFailure;

export type PlanDraftIdentityResult =
  | { readonly kind: "ready"; readonly draft: PlanDraftIdentity }
  | PlanDraftWorkspaceFailure;

function identity(draft: PlanDraftSnapshot): PlanDraftIdentity {
  return {
    draft_id: draft.id,
    state: draft.state,
    lifecycle_version: draft.lifecycleVersion,
    snapshot_digest: draft.snapshotDigest,
    base: {
      revision_id: draft.baseRevisionId,
      plan_version: draft.basePlanVersion,
    },
  };
}

function partView(part: PlanDraftPart): PlanDraftPartView {
  return {
    draft_part_id: part.id,
    base_revision_part_id: part.baseRevisionPartId,
    part_key: part.partKey,
    filename: part.filename,
    relative_path: part.relativePath,
    source_layer: part.sourceLayer,
    role: part.roleOverride ?? part.roleInferred,
    quantity_inferred: part.quantityInferred,
    quantity_override: part.quantityOverride,
    quantity_effective: part.quantityEffective,
    included: part.included,
  };
}

function acceptedReference(part: {
  readonly id: number;
  readonly filename: string;
  readonly relativePath: string;
  readonly sourceLayer: string;
}) {
  return {
    revision_part_id: part.id,
    filename: part.filename,
    relative_path: part.relativePath,
    source_layer: part.sourceLayer,
  };
}

function requiredUnitDecision(decision: RequiredUnitDecisionContract): RequiredUnitReconciliationDecision {
  if (decision.kind === "replace") {
    return { kind: "replace", targetDraftPartId: decision.target_draft_part_id };
  }
  return {
    kind: decision.kind,
    targetDraftPartId: decision.target_draft_part_id,
    predecessorRevisionPartId: decision.predecessor_revision_part_id,
  };
}

export class PlanDraftWorkspaceService {
  constructor(private readonly repo: AppRepository) {}

  list(profileId: number): PlanDraftIdentity[] | null {
    if (!this.repo.getOwnedProfileIdentity(profileId)) return null;
    return this.repo.listPlanDrafts(profileId).map(identity);
  }

  read(profileId: number, draftId: number): PlanDraftWorkspaceResult {
    if (!this.repo.getOwnedProfileIdentity(profileId)) return { kind: "profile_not_found" };
    const draft = this.repo.getPlanDraft(profileId, draftId);
    if (!draft) return { kind: "draft_not_found" };
    return { kind: "ready", workspace: this.workspace(draft) };
  }

  recompute(input: {
    readonly profileId: number;
    readonly actorId: string;
    readonly idempotencyKey: string;
  }): PlanDraftWorkspaceResult {
    if (!this.repo.canMutateAcceptedPlan()) return { kind: "transaction_unavailable" };
    if (!this.repo.getOwnedProfileIdentity(input.profileId)) return { kind: "profile_not_found" };
    const result = this.repo.recomputePlanDraft({
      profileId: input.profileId,
      actor: input.actorId,
      idempotencyKey: input.idempotencyKey,
    });
    if (result.kind !== "created" && result.kind !== "existing") {
      return this.recomputeFailure(result);
    }
    return this.autoReconcile(result.draft, input.actorId);
  }

  editParts(input: {
    readonly profileId: number;
    readonly draftId: number;
    readonly actorId: string;
    readonly request: EditPlanDraftPartsRequest;
  }): PlanDraftWorkspaceResult {
    if (!this.repo.canMutateAcceptedPlan()) return { kind: "transaction_unavailable" };
    if (!this.repo.getOwnedProfileIdentity(input.profileId)) return { kind: "profile_not_found" };
    const contractDecisions = "decision" in input.request
      ? [input.request.decision]
      : input.request.decisions;
    const decisions = contractDecisions.map((decision) => decision.kind === "set_included"
      ? {
          kind: "set_included" as const,
          partIds: decision.draft_part_ids,
          value: decision.value,
        }
      : {
          kind: "set_quantity_override" as const,
          partIds: decision.draft_part_ids,
          value: decision.value,
        });
    const result = this.repo.editPlanDraftPartsBatch({
      profileId: input.profileId,
      draftId: input.draftId,
      expectedSnapshotDigest: input.request.expected_snapshot_digest,
      decisions,
    });
    if (result.kind !== "updated" && result.kind !== "unchanged") {
      return this.editFailure(input.profileId, input.draftId, result);
    }
    return this.autoReconcile(result.draft, input.actorId);
  }

  reconcile(input: {
    readonly profileId: number;
    readonly draftId: number;
    readonly actorId: string;
    readonly idempotencyKey: string;
    readonly request: ReconcilePlanDraftRequest;
  }): PlanDraftWorkspaceResult {
    if (!this.repo.canMutateAcceptedPlan()) return { kind: "transaction_unavailable" };
    if (!this.repo.getOwnedProfileIdentity(input.profileId)) return { kind: "profile_not_found" };
    const result = this.repo.savePlanDraftRequiredUnitReconciliation({
      profileId: input.profileId,
      draftId: input.draftId,
      expectedSnapshotDigest: input.request.expected_snapshot_digest,
      decisions: input.request.decisions.map(requiredUnitDecision),
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
    });
    if (result.kind === "saved" || result.kind === "existing") {
      return { kind: "ready", workspace: this.workspace(result.draft) };
    }
    return this.reconciliationFailure(input.profileId, input.draftId, result);
  }

  apply(input: {
    readonly profileId: number;
    readonly draftId: number;
    readonly actorId: string;
    readonly idempotencyKey: string;
    readonly request: ApplyPlanDraftRequest;
  }): ApplyDraftWorkspaceResult {
    if (!this.repo.canMutateAcceptedPlan()) return { kind: "transaction_unavailable" };
    if (!this.repo.getOwnedProfileIdentity(input.profileId)) return { kind: "profile_not_found" };
    const expectedBase = input.request.expected_base.revision_id == null
      ? { kind: "empty" as const, planVersion: 0 as const }
      : {
          kind: "revision" as const,
          revisionId: input.request.expected_base.revision_id,
          planVersion: input.request.expected_base.plan_version,
        };
    const result = this.repo.applyPlanChanges({
      profileId: input.profileId,
      draftId: input.draftId,
      expectedSnapshotDigest: input.request.expected_snapshot_digest,
      expectedLifecycleVersion: input.request.expected_lifecycle_version,
      expectedBase,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      remapCheckoffLinks: input.request.remap_checkoff_links,
    });
    return this.applyResult(result);
  }

  abandon(input: {
    readonly profileId: number;
    readonly draftId: number;
    readonly request: AbandonPlanDraftRequest;
  }): PlanDraftIdentityResult {
    if (!this.repo.canMutateAcceptedPlan()) return { kind: "transaction_unavailable" };
    if (!this.repo.getOwnedProfileIdentity(input.profileId)) return { kind: "profile_not_found" };
    const result = this.repo.transitionPlanDraft({
      profileId: input.profileId,
      draftId: input.draftId,
      transition: {
        kind: "abandon",
        expectedLifecycleVersion: input.request.expected_lifecycle_version,
      },
    });
    if (result.kind === "transitioned" || result.kind === "unchanged") {
      return { kind: "ready", draft: identity(result.draft) };
    }
    return this.transitionFailure(input.profileId, input.draftId, result);
  }

  rebase(input: {
    readonly profileId: number;
    readonly draftId: number;
    readonly actorId: string;
    readonly idempotencyKey: string;
    readonly request: RebasePlanDraftRequest;
  }): PlanDraftWorkspaceResult {
    if (!this.repo.canMutateAcceptedPlan()) return { kind: "transaction_unavailable" };
    if (!this.repo.getOwnedProfileIdentity(input.profileId)) return { kind: "profile_not_found" };
    const result = this.repo.rebasePlanDraft({
      profileId: input.profileId,
      sourceDraftId: input.draftId,
      expectedSourceLifecycleVersion: input.request.expected_source_lifecycle_version,
      expectedSourceSnapshotDigest: input.request.expected_source_snapshot_digest,
      actor: input.actorId,
      idempotencyKey: input.idempotencyKey,
    });
    if (result.kind === "rebased" || result.kind === "existing") {
      return this.autoReconcile(result.draft, input.actorId);
    }
    return this.rebaseFailure(input.profileId, input.draftId, result);
  }

  private workspace(draft: PlanDraftSnapshot): PlanDraftWorkspace {
    const diff = this.repo.diffPlanDraft(draft.profileId, draft.id);
    const selected = draft.requiredUnitReconciliation
      ? this.repo.getPlanDraftRequiredUnitReconciliation(
          draft.profileId,
          draft.id,
          draft.requiredUnitReconciliation.id,
        )
      : null;
    if (draft.requiredUnitReconciliation && !selected) {
      throw new Error("Selected Plan draft reconciliation is missing");
    }
    const reconciliation: PlanDraftWorkspace["reconciliation"] = selected?.resultKind === "ready"
      ? {
          kind: "ready",
          reused_units: selected.assignments.filter((row) => row.kind === "reuse").length,
          new_units: selected.assignments.filter((row) => row.kind === "create").length,
          surplus_units: selected.surplus.length,
        }
      : {
          kind: "unresolved",
          conflicts: (selected?.conflicts ?? []).map((conflict) => {
            if (conflict.kind === "ambiguous_exact_match") {
              return {
                kind: conflict.kind,
                target_draft_part_id: conflict.targetDraftPartId,
                candidate_revision_part_ids: [...conflict.candidateRevisionPartIds],
              };
            }
            return {
              kind: conflict.kind,
              target_draft_part_id: conflict.targetDraftPartId,
              predecessor_revision_part_id: conflict.predecessorRevisionPartId,
            };
          }),
        };
    return {
      profile_id: draft.profileId,
      draft: identity(draft),
      parts: draft.parts.map(partView),
      diff: {
        base_is_current: diff.baseIsCurrent,
        added: diff.parts.added.map(({ after }) => partView(after)),
        removed: diff.parts.removed.map(({ before }) => acceptedReference(before)),
        changed: diff.parts.changed.map(({ before, after, fields }) => ({
          before: acceptedReference(before),
          after: partView(after),
          fields,
        })),
      },
      reconciliation,
    };
  }

  private autoReconcile(draft: PlanDraftSnapshot, actorId: string): PlanDraftWorkspaceResult {
    if (draft.requiredUnitReconciliation) {
      return { kind: "ready", workspace: this.workspace(draft) };
    }
    const result = this.repo.savePlanDraftRequiredUnitReconciliation({
      profileId: draft.profileId,
      draftId: draft.id,
      expectedSnapshotDigest: draft.snapshotDigest,
      decisions: [],
      actorId,
      idempotencyKey: `auto-${draft.snapshotDigest}`,
    });
    if (result.kind === "saved" || result.kind === "existing") {
      return { kind: "ready", workspace: this.workspace(result.draft) };
    }
    return this.reconciliationFailure(draft.profileId, draft.id, result);
  }

  private recomputeFailure(result: Exclude<RecomputePlanDraftResult, { kind: "created" | "existing" }>): PlanDraftWorkspaceFailure {
    switch (result.kind) {
      case "accepted_baseline_required":
      case "base_changed":
      case "inputs_changed":
      case "idempotency_conflict":
      case "transaction_unavailable":
        return result;
      case "no_layers":
      case "no_stls":
      case "would_wipe":
        return { kind: "domain_error", code: result.kind };
    }
  }

  private editFailure(profileId: number, draftId: number, result: Exclude<EditPlanDraftPartsResult, { kind: "updated" | "unchanged" }>): PlanDraftWorkspaceFailure {
    switch (result.kind) {
      case "not_found":
        return { kind: "draft_not_found" };
      case "conflict":
      case "base_changed":
        return { kind: result.kind === "conflict" ? "draft_changed" : "base_changed", workspace: this.workspace(result.draft) };
      case "not_open":
      {
        const current = this.repo.getPlanDraft(profileId, draftId);
        return {
          kind: "not_open",
          workspace: current ? this.workspace(current) : undefined,
        };
      }
      case "accepted_baseline_required":
      case "transaction_unavailable":
        return result;
    }
  }

  private reconciliationFailure(profileId: number, draftId: number, result: SavePlanDraftRequiredUnitReconciliationResult): PlanDraftWorkspaceFailure {
    switch (result.kind) {
      case "saved":
      case "existing":
        throw new Error("Successful reconciliation reached the failure mapper");
      case "not_found":
        return { kind: "draft_not_found" };
      case "conflict":
      case "base_changed":
        return { kind: result.kind === "conflict" ? "draft_changed" : "base_changed", workspace: this.workspace(result.draft) };
      case "not_open": {
        const read = this.read(profileId, draftId);
        return { kind: "not_open", workspace: read.kind === "ready" ? read.workspace : undefined };
      }
      case "accepted_baseline_required":
      case "idempotency_conflict":
      case "transaction_unavailable":
        return result;
      case "superseded":
        return { kind: "draft_changed" };
      case "required_unit_set_unavailable":
        return { kind: "domain_error", code: "required_unit_set_unavailable" };
    }
  }

  private transitionFailure(
    profileId: number,
    draftId: number,
    result: Exclude<TransitionPlanDraftResult, { kind: "transitioned" | "unchanged" }>,
  ): PlanDraftWorkspaceFailure {
    if (result.kind === "not_found") return { kind: "draft_not_found" };
    if (result.kind === "transaction_unavailable" || result.kind === "accepted_baseline_required") {
      return result;
    }
    if (result.kind === "base_changed" || result.kind === "conflict") {
      return {
        kind: result.kind === "conflict" ? "draft_changed" : "base_changed",
        workspace: this.workspace(result.draft),
      };
    }
    const current = this.read(profileId, draftId);
    return { kind: "not_open", workspace: current.kind === "ready" ? current.workspace : undefined };
  }

  private rebaseFailure(
    profileId: number,
    draftId: number,
    result: Exclude<RebasePlanDraftResult, { kind: "rebased" | "existing" }>,
  ): PlanDraftWorkspaceFailure {
    switch (result.kind) {
      case "not_found":
        return { kind: "draft_not_found" };
      case "transaction_unavailable":
      case "accepted_baseline_required":
      case "base_changed":
      case "inputs_changed":
      case "idempotency_conflict":
      case "base_unchanged":
        return result;
      case "source_conflict":
        return { kind: "draft_changed", workspace: this.workspace(result.draft) };
      case "not_abandoned": {
        const current = this.read(profileId, draftId);
        return { kind: "not_open", workspace: current.kind === "ready" ? current.workspace : undefined };
      }
      case "merge_conflicts":
        return { kind: "merge_conflicts", conflicts: result.conflicts.map((conflict) => ({ ...conflict })) };
      case "no_layers":
      case "no_stls":
      case "would_wipe":
        return { kind: "domain_error", code: result.kind };
    }
  }

  private applyResult(result: ApplyPlanChangesResult): ApplyDraftWorkspaceResult {
    switch (result.kind) {
      case "applied":
      case "existing":
      case "already_applied":
        return { kind: "applied", receipt: result.receipt };
      case "not_found":
        return { kind: "draft_not_found" };
      case "production_active":
        return {
          kind: "production_active",
          checkoff_link_count: result.checkoffLinkCount,
          send_queue_item_count: result.sendQueueItemCount,
        };
      case "checkoff_remap_unsafe":
        return {
          kind: "checkoff_remap_unsafe",
          unmappable: result.unmappable.map((item) => ({
            linkId: item.linkId,
            filename: item.filename,
            reason: item.reason,
          })),
        };
      case "reconciliation_required":
        return result;
      case "not_open":
        return { kind: "not_open" };
      case "idempotency_conflict":
      case "draft_changed":
      case "accepted_baseline_required":
      case "base_changed":
      case "transaction_unavailable":
        return result;
      case "build_archived":
      case "token_allocation_failed":
        return { kind: "domain_error", code: result.kind };
    }
  }
}
