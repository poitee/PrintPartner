import { createHash } from "node:crypto";

export const PLAN_DRAFT_DIGEST_FORMAT = "plan-draft-v1";
export const PLAN_DRAFT_SELECTION_DIGEST_FORMAT = "plan-draft-v2";
export const MAX_PLAN_DRAFT_PART_QUANTITY = 10_000;
export const MAX_PLAN_DRAFT_LIFECYCLE_VERSION = 2_147_483_647;

export type PlanDraftState = "open" | "abandoned" | "consumed";

export type PlanSnapshotInput = {
  sourceId: number;
  sourceLayer: string;
  layerOrder: number;
  trackingKind: "revision" | "untracked";
  sourceRevisionId: number | null;
  manifestDigest: string | null;
  effectiveNamingDigest: string;
};

export type PlanSnapshotPart = {
  partKey: string;
  relativePath: string;
  filename: string;
  sourceLayer: string;
  status: string;
  roleInferred: string;
  roleOverride: string | null;
  filamentColorId: string | null;
  filamentCustomHex: string | null;
  spoolmanSpoolId: string | null;
  quantityInferred: number;
  quantityOverride: number | null;
  quantityEffective: number;
  included: boolean;
  notes: string;
  githubBlobUrl: string | null;
  geometrySame: boolean | null;
  requirement: string | null;
  optionGroupId: string | null;
  manifestSource: string | null;
  artifactDigest: string | null;
};

export type PlanDraftInput = PlanSnapshotInput & { id: number; draftId: number };
export type PlanDraftPart = PlanSnapshotPart & {
  id: number;
  draftId: number;
  baseRevisionPartId: number | null;
};

export type PlanDraftOrigin =
  | { readonly kind: "recompute" }
  | {
      readonly kind: "rebase";
      readonly sourceDraftId: number;
      readonly sourceLifecycleVersion: number;
      readonly sourceSnapshotDigest: string;
    };

export type PlanDraftSnapshot = {
  id: number;
  profileId: number;
  baseRevisionId: number | null;
  basePlanVersion: number;
  state: PlanDraftState;
  lifecycleVersion: number;
  consumedRevisionId?: number | null;
  consumedAt?: string | null;
  origin: PlanDraftOrigin;
  digestFormat: string;
  snapshotDigest: string;
  createdBy: string;
  idempotencyKey: string;
  createdAt: string;
  requiredUnitReconciliation?:
    | { readonly id: number; readonly format: string; readonly digest: string }
    | null;
  inputs: PlanDraftInput[];
  parts: PlanDraftPart[];
};

export type PlanDraftPartDecision =
  | {
      readonly kind: "set_included";
      readonly partIds: readonly number[];
      readonly value: boolean;
    }
  | {
      readonly kind: "set_quantity_override";
      readonly partIds: readonly number[];
      readonly value: number | null;
    };

export type RebasePartDecision =
  | {
      readonly kind: "set_included";
      readonly sourcePartId: number;
      readonly value: boolean;
    }
  | {
      readonly kind: "set_quantity_override";
      readonly sourcePartId: number;
      readonly value: number | null;
    };

export type RebaseAcceptedPart = PlanSnapshotPart & {
  readonly id: number;
  readonly projectionPartId: number | null;
};

export type RebaseConflict =
  | {
      readonly kind: "source_identity";
      readonly sourcePartId: number;
      readonly sourceLayer: string;
    }
  | {
      readonly kind: "target_missing" | "target_ambiguous";
      readonly sourcePartId: number;
      readonly targetPartIds: readonly number[];
    }
  | {
      readonly kind: "target_collision";
      readonly sourcePartIds: readonly number[];
      readonly targetPartId: number;
    }
  | {
      readonly kind: "concurrent_decision";
      readonly sourcePartId: number;
      readonly targetPartId: number;
      readonly field: "included" | "quantityOverride";
    };

export type RebasePlanDraftMergeResult =
  | { readonly kind: "merged"; readonly draft: PlanDraftSnapshot }
  | { readonly kind: "conflicts"; readonly conflicts: readonly RebaseConflict[] };

export class PlanDraftPartNotFoundError extends Error {}

type BasePart = PlanSnapshotPart & { id: number };

export function newPlanDraftPartDecisionBaseline(): Pick<
  PlanSnapshotPart,
  "included" | "quantityOverride"
> {
  return { included: true, quantityOverride: null };
}

export function extractRebasePartDecisions(input: {
  readonly source: PlanDraftSnapshot;
  readonly baseParts: readonly RebaseAcceptedPart[];
}): RebasePartDecision[] {
  const baseById = new Map(input.baseParts.map((part) => [part.id, part]));
  const decisions: RebasePartDecision[] = [];
  for (const part of [...input.source.parts].sort((left, right) => left.id - right.id)) {
    const baseline =
      part.baseRevisionPartId == null
        ? newPlanDraftPartDecisionBaseline()
        : baseById.get(part.baseRevisionPartId);
    if (!baseline) throw new Error("Plan draft rebase predecessor is missing");
    if (part.included !== baseline.included) {
      decisions.push({ kind: "set_included", sourcePartId: part.id, value: part.included });
    }
    if (part.quantityOverride !== baseline.quantityOverride) {
      decisions.push({
        kind: "set_quantity_override",
        sourcePartId: part.id,
        value: part.quantityOverride,
      });
    }
  }
  return decisions;
}

type PartEvidenceIndex = ReadonlyMap<
  number,
  ReadonlyMap<string, readonly PlanDraftPart[]>
>;

type DraftMatchIndex = {
  readonly sourceIdByLayer: ReadonlyMap<string, number | null>;
  readonly trackedSourceIds: ReadonlySet<number>;
  readonly byPartKey: PartEvidenceIndex;
  readonly byArtifactDigest: PartEvidenceIndex;
};

function addPartEvidence(
  index: Map<number, Map<string, PlanDraftPart[]>>,
  sourceId: number,
  value: string,
  part: PlanDraftPart,
): void {
  const byValue = index.get(sourceId) ?? new Map<string, PlanDraftPart[]>();
  const matches = byValue.get(value) ?? [];
  matches.push(part);
  byValue.set(value, matches);
  index.set(sourceId, byValue);
}

function indexDraftForRebase(draft: PlanDraftSnapshot): DraftMatchIndex {
  const sourceIdByLayer = new Map<string, number | null>();
  const trackedSourceIds = new Set<number>();
  for (const input of draft.inputs) {
    sourceIdByLayer.set(
      input.sourceLayer,
      sourceIdByLayer.has(input.sourceLayer) ? null : input.sourceId,
    );
    if (input.trackingKind === "revision") trackedSourceIds.add(input.sourceId);
  }
  const byPartKey = new Map<number, Map<string, PlanDraftPart[]>>();
  const byArtifactDigest = new Map<number, Map<string, PlanDraftPart[]>>();
  for (const part of draft.parts) {
    const sourceId = sourceIdByLayer.get(part.sourceLayer);
    if (sourceId == null) continue;
    addPartEvidence(byPartKey, sourceId, part.partKey, part);
    if (part.artifactDigest != null) {
      addPartEvidence(byArtifactDigest, sourceId, part.artifactDigest, part);
    }
  }
  return { sourceIdByLayer, trackedSourceIds, byPartKey, byArtifactDigest };
}

function indexedParts(
  index: PartEvidenceIndex,
  sourceId: number,
  value: string,
): readonly PlanDraftPart[] {
  return index.get(sourceId)?.get(value) ?? [];
}

function sortRebaseConflicts(conflicts: readonly RebaseConflict[]): RebaseConflict[] {
  return [...conflicts].sort((left, right) => {
    const leftSource =
      left.kind === "target_collision" ? left.sourcePartIds[0] ?? 0 : left.sourcePartId;
    const rightSource =
      right.kind === "target_collision" ? right.sourcePartIds[0] ?? 0 : right.sourcePartId;
    return leftSource - rightSource || left.kind.localeCompare(right.kind);
  });
}

export function mergeRebasedPlanDraft(input: {
  readonly source: PlanDraftSnapshot;
  readonly sourceBaseParts: readonly RebaseAcceptedPart[];
  readonly fresh: PlanDraftSnapshot;
  readonly currentBaseParts: readonly RebaseAcceptedPart[];
}): RebasePlanDraftMergeResult {
  const decisions = extractRebasePartDecisions({
    source: input.source,
    baseParts: input.sourceBaseParts,
  });
  if (decisions.length === 0) return { kind: "merged", draft: structuredClone(input.fresh) };
  const sourceById = new Map(input.source.parts.map((part) => [part.id, part]));
  const sourceIndex = indexDraftForRebase(input.source);
  const freshIndex = indexDraftForRebase(input.fresh);
  const oldBaseById = new Map(input.sourceBaseParts.map((part) => [part.id, part]));
  const currentBaseById = new Map(input.currentBaseParts.map((part) => [part.id, part]));
  const freshByProjection = new Map<number, PlanDraftPart[]>();
  const oldProjectionCounts = new Map<number, number>();
  const currentProjectionCounts = new Map<number, number>();
  for (const part of input.sourceBaseParts) {
    if (part.projectionPartId != null) {
      oldProjectionCounts.set(
        part.projectionPartId,
        (oldProjectionCounts.get(part.projectionPartId) ?? 0) + 1,
      );
    }
  }
  for (const part of input.currentBaseParts) {
    if (part.projectionPartId != null) {
      currentProjectionCounts.set(
        part.projectionPartId,
        (currentProjectionCounts.get(part.projectionPartId) ?? 0) + 1,
      );
    }
  }
  for (const part of input.fresh.parts) {
    if (part.baseRevisionPartId == null) continue;
    const projectionId = currentBaseById.get(part.baseRevisionPartId)?.projectionPartId;
    if (projectionId == null) continue;
    const matches = freshByProjection.get(projectionId) ?? [];
    matches.push(part);
    freshByProjection.set(projectionId, matches);
  }
  const sourcePartIds = [...new Set(decisions.map((decision) => decision.sourcePartId))].sort(
    (left, right) => left - right,
  );
  const targetBySource = new Map<number, PlanDraftPart>();
  const conflicts: RebaseConflict[] = [];
  for (const sourcePartId of sourcePartIds) {
    const sourcePart = sourceById.get(sourcePartId);
    if (!sourcePart) throw new Error("Plan draft rebase decision Part is missing");
    const sourceId = sourceIndex.sourceIdByLayer.get(sourcePart.sourceLayer);
    if (sourceId == null) {
      conflicts.push({
        kind: "source_identity",
        sourcePartId,
        sourceLayer: sourcePart.sourceLayer,
      });
      continue;
    }
    let candidates: readonly PlanDraftPart[] = [];
    let ambiguousEvidence = false;
    const oldAncestor =
      sourcePart.baseRevisionPartId == null
        ? null
        : oldBaseById.get(sourcePart.baseRevisionPartId) ?? null;
    const projectionId = oldAncestor?.projectionPartId ?? null;
    if (
      projectionId != null &&
      oldProjectionCounts.get(projectionId) === 1 &&
      currentProjectionCounts.get(projectionId) === 1
    ) {
      candidates = freshByProjection.get(projectionId) ?? [];
    }
    if (candidates.length === 0) {
      const exactCount = indexedParts(sourceIndex.byPartKey, sourceId, sourcePart.partKey).length;
      const exactTargets = indexedParts(freshIndex.byPartKey, sourceId, sourcePart.partKey);
      if (exactCount === 1 && exactTargets.length === 1) candidates = exactTargets;
      else if (exactTargets.length > 0) {
        candidates = exactTargets;
        ambiguousEvidence = true;
      }
    }
    if (!ambiguousEvidence && candidates.length === 0 && sourcePart.artifactDigest != null) {
      const sourceDigestCount = indexedParts(
        sourceIndex.byArtifactDigest,
        sourceId,
        sourcePart.artifactDigest,
      ).length;
      const freshDigestTargets = freshIndex.trackedSourceIds.has(sourceId)
        ? indexedParts(freshIndex.byArtifactDigest, sourceId, sourcePart.artifactDigest)
        : [];
      const sourceTracked = sourceIndex.trackedSourceIds.has(sourceId);
      if (sourceTracked && sourceDigestCount === 1 && freshDigestTargets.length === 1) {
        candidates = freshDigestTargets;
      } else if (freshDigestTargets.length > 0) {
        candidates = freshDigestTargets;
        ambiguousEvidence = true;
      }
    }
    if (ambiguousEvidence || candidates.length !== 1) {
      conflicts.push({
        kind: candidates.length === 0 ? "target_missing" : "target_ambiguous",
        sourcePartId,
        targetPartIds: candidates.map((part) => part.id).sort((left, right) => left - right),
      });
      continue;
    }
    const target = candidates[0];
    if (!target) throw new Error("Plan draft rebase target is missing");
    targetBySource.set(sourcePartId, target);
  }
  const sourcesByTarget = new Map<number, number[]>();
  for (const [sourcePartId, target] of targetBySource) {
    const sourceIds = sourcesByTarget.get(target.id) ?? [];
    sourceIds.push(sourcePartId);
    sourcesByTarget.set(target.id, sourceIds);
  }
  for (const [targetPartId, claimedSources] of sourcesByTarget) {
    if (claimedSources.length > 1) {
      conflicts.push({
        kind: "target_collision",
        sourcePartIds: claimedSources.sort((left, right) => left - right),
        targetPartId,
      });
    }
  }
  if (conflicts.length) return { kind: "conflicts", conflicts: sortRebaseConflicts(conflicts) };

  const next = structuredClone(input.fresh);
  const nextById = new Map(next.parts.map((part) => [part.id, part]));
  for (const decision of decisions) {
    const sourcePart = sourceById.get(decision.sourcePartId);
    if (!sourcePart) throw new Error("Plan draft rebase decision Part is missing");
    const baseline =
      sourcePart.baseRevisionPartId == null
        ? newPlanDraftPartDecisionBaseline()
        : oldBaseById.get(sourcePart.baseRevisionPartId);
    if (!baseline) throw new Error("Plan draft rebase predecessor is missing");
    const target = targetBySource.get(decision.sourcePartId);
    if (!target) throw new Error("Plan draft rebase target is missing");
    const nextTarget = nextById.get(target.id);
    if (!nextTarget) throw new Error("Plan draft rebase target snapshot is missing");
    if (decision.kind === "set_included") {
      if (target.included !== baseline.included && target.included !== decision.value) {
        conflicts.push({
          kind: "concurrent_decision",
          sourcePartId: decision.sourcePartId,
          targetPartId: target.id,
          field: "included",
        });
      } else {
        nextTarget.included = decision.value;
      }
    } else if (
      target.quantityOverride !== baseline.quantityOverride &&
      target.quantityOverride !== decision.value
    ) {
      conflicts.push({
        kind: "concurrent_decision",
        sourcePartId: decision.sourcePartId,
        targetPartId: target.id,
        field: "quantityOverride",
      });
    } else {
      nextTarget.quantityOverride = decision.value;
      nextTarget.quantityEffective = decision.value ?? nextTarget.quantityInferred;
    }
  }
  if (conflicts.length) return { kind: "conflicts", conflicts: sortRebaseConflicts(conflicts) };
  next.snapshotDigest = digestPlanDraft(next);
  return { kind: "merged", draft: next };
}

export type PlanDraftDiff = {
  baseRevisionId: number | null;
  basePlanVersion: number;
  baseIsCurrent: boolean;
  inputs: {
    added: PlanDraftInput[];
    removed: PlanSnapshotInput[];
    changed: Array<{ before: PlanSnapshotInput; after: PlanDraftInput }>;
  };
  parts: {
    added: Array<{ after: PlanDraftPart }>;
    removed: Array<{ before: BasePart }>;
    changed: Array<{ before: BasePart; after: PlanDraftPart; fields: string[] }>;
  };
};

function compareSerialized(left: unknown, right: unknown): number {
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function canonicalInputs(inputs: readonly PlanSnapshotInput[]): PlanSnapshotInput[] {
  return inputs
    .map((input) => ({
      sourceId: input.sourceId,
      sourceLayer: input.sourceLayer,
      layerOrder: input.layerOrder,
      trackingKind: input.trackingKind,
      sourceRevisionId: input.sourceRevisionId,
      manifestDigest: input.manifestDigest,
      effectiveNamingDigest: input.effectiveNamingDigest,
    }))
    .sort(
      (left, right) =>
        left.layerOrder - right.layerOrder ||
        left.sourceId - right.sourceId ||
        compareSerialized(left, right),
    );
}

type DigestPart = PlanSnapshotPart & { baseRevisionPartId: number | null };

function canonicalParts(parts: readonly DigestPart[]): DigestPart[] {
  return parts
    .map((part) => ({
      baseRevisionPartId: part.baseRevisionPartId,
      partKey: part.partKey,
      relativePath: part.relativePath,
      filename: part.filename,
      sourceLayer: part.sourceLayer,
      status: part.status,
      roleInferred: part.roleInferred,
      roleOverride: part.roleOverride,
      filamentColorId: part.filamentColorId,
      filamentCustomHex: part.filamentCustomHex,
      spoolmanSpoolId: part.spoolmanSpoolId,
      quantityInferred: part.quantityInferred,
      quantityOverride: part.quantityOverride,
      quantityEffective: part.quantityEffective,
      included: part.included,
      notes: part.notes,
      githubBlobUrl: part.githubBlobUrl,
      geometrySame: part.geometrySame,
      requirement: part.requirement,
      optionGroupId: part.optionGroupId,
      manifestSource: part.manifestSource,
      artifactDigest: part.artifactDigest,
    }))
    .sort(compareSerialized);
}

export function digestPlanDraft(input: {
  baseRevisionId: number | null;
  basePlanVersion: number;
  inputs: readonly PlanSnapshotInput[];
  parts: readonly DigestPart[];
}): string {
  const canonical = JSON.stringify({
    format: PLAN_DRAFT_DIGEST_FORMAT,
    base_revision_id: input.baseRevisionId,
    base_plan_version: input.basePlanVersion,
    inputs: canonicalInputs(input.inputs),
    parts: canonicalParts(input.parts),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function digestPlanDraftSelection(input: {
  readonly planningDigest: string;
  readonly requiredUnitReconciliation: {
    readonly format: string;
    readonly digest: string;
  } | null;
}): string {
  const canonical = JSON.stringify({
    format: PLAN_DRAFT_SELECTION_DIGEST_FORMAT,
    planning_digest: input.planningDigest,
    required_unit_reconciliation: input.requiredUnitReconciliation,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function validatedDecisionPartIds(partIds: readonly number[]): ReadonlySet<number> {
  if (partIds.length === 0) throw new Error("Plan draft decision requires at least one Part");
  const unique = new Set<number>();
  for (const partId of partIds) {
    if (!Number.isInteger(partId) || partId <= 0) {
      throw new Error("Plan draft Part IDs must be positive integers");
    }
    if (unique.has(partId)) throw new Error("Plan draft decision Part IDs must be unique");
    unique.add(partId);
  }
  return unique;
}

export function applyPlanDraftPartDecision(input: {
  readonly draft: PlanDraftSnapshot;
  readonly decision: PlanDraftPartDecision;
}): PlanDraftSnapshot {
  const targetIds = validatedDecisionPartIds(input.decision.partIds);
  if (
    input.decision.kind === "set_quantity_override" &&
    input.decision.value !== null &&
    (!Number.isSafeInteger(input.decision.value) ||
      input.decision.value <= 0 ||
      input.decision.value > MAX_PLAN_DRAFT_PART_QUANTITY)
  ) {
    throw new Error(
      `Plan draft quantity override must be null or a positive safe integer no greater than ${MAX_PLAN_DRAFT_PART_QUANTITY}`,
    );
  }
  const foundIds = new Set<number>();
  const parts = input.draft.parts.map((part): PlanDraftPart => {
    if (!targetIds.has(part.id)) return { ...part };
    if (part.draftId !== input.draft.id) {
      throw new PlanDraftPartNotFoundError(
        "Plan draft decision Part does not belong to this draft",
      );
    }
    foundIds.add(part.id);
    switch (input.decision.kind) {
      case "set_included":
        return { ...part, included: input.decision.value };
      case "set_quantity_override":
        return {
          ...part,
          quantityOverride: input.decision.value,
          quantityEffective: input.decision.value ?? part.quantityInferred,
        };
      default: {
        const exhaustive: never = input.decision;
        throw new Error(`Unsupported Plan draft decision: ${String(exhaustive)}`);
      }
    }
  });
  if (foundIds.size !== targetIds.size) {
    throw new PlanDraftPartNotFoundError("Plan draft decision Part not found in this draft");
  }
  const next = {
    ...input.draft,
    inputs: input.draft.inputs.map((row) => ({ ...row })),
    parts,
    snapshotDigest: input.draft.snapshotDigest,
  };
  const planningDigest = digestPlanDraft(next);
  return {
    ...next,
    snapshotDigest:
      input.draft.digestFormat === PLAN_DRAFT_SELECTION_DIGEST_FORMAT
        ? digestPlanDraftSelection({
            planningDigest,
            requiredUnitReconciliation: input.draft.requiredUnitReconciliation
              ? {
                  format: input.draft.requiredUnitReconciliation.format,
                  digest: input.draft.requiredUnitReconciliation.digest,
                }
              : null,
          })
        : planningDigest,
  };
}

function changedFields(before: PlanSnapshotPart, after: PlanSnapshotPart): string[] {
  const fields: Array<keyof PlanSnapshotPart> = [
    "partKey",
    "relativePath",
    "filename",
    "sourceLayer",
    "status",
    "roleInferred",
    "roleOverride",
    "filamentColorId",
    "filamentCustomHex",
    "spoolmanSpoolId",
    "quantityInferred",
    "quantityOverride",
    "quantityEffective",
    "included",
    "notes",
    "githubBlobUrl",
    "geometrySame",
    "requirement",
    "optionGroupId",
    "manifestSource",
    "artifactDigest",
  ];
  return fields.filter((field) => before[field] !== after[field]);
}

export function diffPlanDraftSnapshot(input: {
  draft: PlanDraftSnapshot;
  baseInputs: readonly PlanSnapshotInput[];
  baseParts: readonly BasePart[];
  baseIsCurrent: boolean;
}): PlanDraftDiff {
  const baseInputsBySource = new Map(input.baseInputs.map((row) => [row.sourceId, row]));
  const draftInputsBySource = new Map(input.draft.inputs.map((row) => [row.sourceId, row]));
  const addedInputs = input.draft.inputs.filter((row) => !baseInputsBySource.has(row.sourceId));
  const removedInputs = input.baseInputs.filter((row) => !draftInputsBySource.has(row.sourceId));
  const changedInputs = input.draft.inputs.flatMap((after) => {
    const before = baseInputsBySource.get(after.sourceId);
    if (!before) return [];
    const comparableAfter: PlanSnapshotInput = {
      sourceId: after.sourceId,
      sourceLayer: after.sourceLayer,
      layerOrder: after.layerOrder,
      trackingKind: after.trackingKind,
      sourceRevisionId: after.sourceRevisionId,
      manifestDigest: after.manifestDigest,
      effectiveNamingDigest: after.effectiveNamingDigest,
    };
    return compareSerialized(before, comparableAfter) === 0 ? [] : [{ before, after }];
  });

  const basePartsById = new Map(input.baseParts.map((row) => [row.id, row]));
  const linkedBaseIds = new Set<number>();
  const addedParts: Array<{ after: PlanDraftPart }> = [];
  const changedParts: Array<{
    before: BasePart;
    after: PlanDraftPart;
    fields: string[];
  }> = [];
  for (const after of input.draft.parts) {
    const before =
      after.baseRevisionPartId == null
        ? undefined
        : basePartsById.get(after.baseRevisionPartId);
    if (!before) {
      addedParts.push({ after });
      continue;
    }
    linkedBaseIds.add(before.id);
    const fields = changedFields(before, after);
    if (fields.length) changedParts.push({ before, after, fields });
  }

  return {
    baseRevisionId: input.draft.baseRevisionId,
    basePlanVersion: input.draft.basePlanVersion,
    baseIsCurrent: input.baseIsCurrent,
    inputs: {
      added: [...addedInputs].sort(
        (left, right) => left.layerOrder - right.layerOrder || left.sourceId - right.sourceId,
      ),
      removed: canonicalInputs(removedInputs),
      changed: changedInputs.sort((left, right) => left.after.sourceId - right.after.sourceId),
    },
    parts: {
      added: addedParts.sort((left, right) => compareSerialized(left.after, right.after)),
      removed: input.baseParts
        .filter((row) => !linkedBaseIds.has(row.id))
        .sort(compareSerialized)
        .map((before) => ({ before })),
      changed: changedParts.sort((left, right) => compareSerialized(left.after, right.after)),
    },
  };
}
