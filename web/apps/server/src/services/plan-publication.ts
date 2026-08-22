import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { PlanDraftPart, PlanDraftSnapshot } from "./plan-drafts.js";
import { parseRequiredUnitToken } from "./required-units.js";
import type { RequiredUnitAssignment } from "./required-unit-reconciliation.js";

export const PLAN_REVISION_DIGEST_FORMAT = "plan-revision-parts-v1";
export const MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES = 64 * 1024;

export class AcceptedOperationalRowTextLimitError extends Error {
  readonly code = "accepted_operational_row_text_limit" as const;

  constructor() {
    super("Accepted operational row text exceeds the UTF-8 byte limit");
    this.name = "AcceptedOperationalRowTextLimitError";
  }
}

export function validateAcceptedOperationalTextRow(
  values: readonly (string | null)[],
): void {
  const bytes = values.reduce(
    (total, value) => total + (value == null ? 0 : Buffer.byteLength(value, "utf8")),
    0,
  );
  if (bytes > MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES) {
    throw new AcceptedOperationalRowTextLimitError();
  }
}

export type PlanPublicationPart = Omit<PlanDraftPart, "id" | "draftId" | "baseRevisionPartId"> & {
  readonly draftPartId: number;
  readonly effectiveRole: string;
};

export type PlanPublicationBaseUnit = {
  readonly token: string;
  readonly objectName: string;
  readonly completed: boolean;
  readonly assembled: boolean;
};

export type PlanPublicationMappingIntent = RequiredUnitAssignment;

export type PlanPublicationProgressIntent = {
  readonly draftPartId: number;
  readonly unitIndex: number;
  readonly assignment: "reuse" | "create";
  readonly token: string | null;
  readonly completed: boolean;
  readonly assembled: boolean;
};

export type PreparedPlanPublication = {
  readonly parts: readonly PlanPublicationPart[];
  readonly mappings: readonly PlanPublicationMappingIntent[];
  readonly progress: readonly PlanPublicationProgressIntent[];
  readonly expectedUnitCount: number;
  readonly revisionDigest: string;
};

export type PlanRevisionDigestPart = {
  readonly partKey: string;
  readonly relativePath: string;
  readonly filename: string;
  readonly sourceLayer: string;
  readonly status: string;
  readonly roleInferred: string;
  readonly roleOverride: string | null;
  readonly filamentColorId: string | null;
  readonly filamentCustomHex: string | null;
  readonly spoolmanSpoolId: string | null;
  readonly quantityInferred: number;
  readonly quantityOverride: number | null;
  readonly quantityEffective: number;
  readonly included: boolean;
  readonly notes: string;
  readonly githubBlobUrl: string | null;
  readonly geometrySame: boolean | null;
  readonly requirement: string | null;
  readonly optionGroupId: string | null;
  readonly manifestSource: string | null;
  readonly artifactDigest: string | null;
};

export type PublishedPlanRevisionPart = PlanRevisionDigestPart & {
  readonly id: number;
  readonly projectionPartId: number | null;
};

export type PublishedPlanProjectionPart = {
  readonly id: number;
  readonly matchKey: string;
  readonly relativePath: string;
  readonly filename: string;
  readonly sourceLayer: string;
  readonly status: string;
  readonly role: string;
  readonly filamentColorId: string | null;
  readonly filamentCustomHex: string | null;
  readonly spoolmanSpoolId: string | null;
  readonly quantityAuto: number;
  readonly quantityOverride: number | null;
  readonly quantityEffective: number;
  readonly included: boolean;
  readonly notes: string;
  readonly githubBlobUrl: string | null;
  readonly geometrySame: boolean | null;
  readonly requirement: string | null;
  readonly optionGroupId: string | null;
  readonly manifestSource: string | null;
};

export function publishedPlanPartsMatch(input: {
  readonly preparedParts: readonly PlanPublicationPart[];
  readonly revisionParts: readonly PublishedPlanRevisionPart[];
  readonly projectionParts: readonly PublishedPlanProjectionPart[];
  readonly revisionPartIdByDraftPart: ReadonlyMap<number, number>;
  readonly projectionPartIdByDraftPart: ReadonlyMap<number, number>;
}): boolean {
  if (
    input.revisionParts.length !== input.preparedParts.length ||
    input.projectionParts.length !== input.preparedParts.length ||
    input.revisionPartIdByDraftPart.size !== input.preparedParts.length ||
    input.projectionPartIdByDraftPart.size !== input.preparedParts.length
  ) {
    return false;
  }
  const revisionById = new Map(input.revisionParts.map((part) => [part.id, part]));
  const projectionById = new Map(input.projectionParts.map((part) => [part.id, part]));
  return input.preparedParts.every((expected) => {
    const revisionPartId = input.revisionPartIdByDraftPart.get(expected.draftPartId);
    const projectionPartId = input.projectionPartIdByDraftPart.get(expected.draftPartId);
    const revision = revisionPartId == null ? null : revisionById.get(revisionPartId);
    const projection = projectionPartId == null ? null : projectionById.get(projectionPartId);
    return (
      revision != null &&
      projection != null &&
      revision.projectionPartId === projectionPartId &&
      revision.partKey === expected.partKey &&
      revision.relativePath === expected.relativePath &&
      revision.filename === expected.filename &&
      revision.sourceLayer === expected.sourceLayer &&
      revision.status === expected.status &&
      revision.roleInferred === expected.roleInferred &&
      revision.roleOverride === expected.roleOverride &&
      revision.filamentColorId === expected.filamentColorId &&
      revision.filamentCustomHex === expected.filamentCustomHex &&
      revision.spoolmanSpoolId === expected.spoolmanSpoolId &&
      revision.quantityInferred === expected.quantityInferred &&
      revision.quantityOverride === expected.quantityOverride &&
      revision.quantityEffective === expected.quantityEffective &&
      revision.included === expected.included &&
      revision.notes === expected.notes &&
      revision.githubBlobUrl === expected.githubBlobUrl &&
      revision.geometrySame === expected.geometrySame &&
      revision.requirement === expected.requirement &&
      revision.optionGroupId === expected.optionGroupId &&
      revision.manifestSource === expected.manifestSource &&
      revision.artifactDigest === expected.artifactDigest &&
      projection.matchKey === expected.partKey &&
      projection.relativePath === expected.relativePath &&
      projection.filename === expected.filename &&
      projection.sourceLayer === expected.sourceLayer &&
      projection.status === expected.status &&
      projection.role === expected.effectiveRole &&
      projection.filamentColorId === expected.filamentColorId &&
      projection.filamentCustomHex === expected.filamentCustomHex &&
      projection.spoolmanSpoolId === expected.spoolmanSpoolId &&
      projection.quantityAuto === expected.quantityInferred &&
      projection.quantityOverride === expected.quantityOverride &&
      projection.quantityEffective === expected.quantityEffective &&
      projection.included === expected.included &&
      projection.notes === expected.notes &&
      projection.githubBlobUrl === expected.githubBlobUrl &&
      projection.geometrySame === expected.geometrySame &&
      projection.requirement === expected.requirement &&
      projection.optionGroupId === expected.optionGroupId &&
      projection.manifestSource === expected.manifestSource
    );
  });
}

export function canonicalPlanRevisionSnapshot(
  parts: readonly PlanRevisionDigestPart[],
): string {
  const canonicalParts = parts
    .map((part) => ({
      part_key: part.partKey,
      relative_path: part.relativePath,
      filename: part.filename,
      source_layer: part.sourceLayer,
      status: part.status,
      role_inferred: part.roleInferred,
      role_override: part.roleOverride,
      filament_color_id: part.filamentColorId,
      filament_custom_hex: part.filamentCustomHex,
      spoolman_spool_id: part.spoolmanSpoolId,
      quantity_inferred: part.quantityInferred,
      quantity_override: part.quantityOverride,
      quantity_effective: part.quantityEffective,
      included: part.included,
      notes: part.notes,
      github_blob_url: part.githubBlobUrl,
      geometry_same: part.geometrySame,
      requirement: part.requirement,
      option_group_id: part.optionGroupId,
      manifest_source: part.manifestSource,
      artifact_digest: part.artifactDigest,
    }))
    .map((part) => ({ part, serialized: JSON.stringify(part) }))
    .sort((left, right) =>
      left.serialized < right.serialized ? -1 : left.serialized > right.serialized ? 1 : 0,
    )
    .map(({ part }) => part);
  return JSON.stringify({ format: PLAN_REVISION_DIGEST_FORMAT, parts: canonicalParts });
}

export function digestPlanRevisionParts(parts: readonly PlanRevisionDigestPart[]): string {
  return createHash("sha256").update(canonicalPlanRevisionSnapshot(parts)).digest("hex");
}

export function preparePlanPublication(input: {
  readonly draft: PlanDraftSnapshot;
  readonly assignments: readonly RequiredUnitAssignment[];
  readonly baseUnits: readonly PlanPublicationBaseUnit[];
}): PreparedPlanPublication {
  const draftParts = [...input.draft.parts].sort((left, right) => left.id - right.id);
  const partIds = new Set<number>();
  const parts = draftParts.map((part): PlanPublicationPart => {
    if (partIds.has(part.id)) throw new Error("Plan publication draft Part is duplicated");
    partIds.add(part.id);
    if (
      !Number.isSafeInteger(part.quantityEffective) ||
      part.quantityEffective < 1 ||
      part.quantityEffective > 10_000 ||
      part.quantityEffective !== (part.quantityOverride ?? part.quantityInferred)
    ) {
      throw new Error("Plan publication quantity is invalid");
    }
    validateAcceptedOperationalTextRow([
      part.partKey,
      part.relativePath,
      part.filename,
      part.sourceLayer,
      part.status,
      part.roleInferred,
      part.roleOverride,
      part.filamentColorId,
      part.filamentCustomHex,
      part.spoolmanSpoolId,
      part.notes,
      part.githubBlobUrl,
      part.requirement,
      part.optionGroupId,
      part.manifestSource,
      part.artifactDigest,
    ]);
    const { id, draftId: _draftId, baseRevisionPartId: _baseRevisionPartId, ...values } = part;
    return {
      draftPartId: id,
      ...values,
      effectiveRole: part.roleOverride ?? part.roleInferred,
    };
  });
  const baseByToken = new Map<string, PlanPublicationBaseUnit>();
  for (const unit of input.baseUnits) {
    const token = parseRequiredUnitToken(unit.token);
    if (baseByToken.has(token)) throw new Error("Plan publication base token is duplicated");
    if (unit.assembled && !unit.completed) {
      throw new Error("Plan publication base progress is corrupt");
    }
    baseByToken.set(token, { ...unit, token });
  }
  const assignments = [...input.assignments].sort(
    (left, right) =>
      left.draftPartId - right.draftPartId || left.unitIndex - right.unitIndex,
  );
  const reused = new Set<string>();
  const nextIndex = new Map<number, number>();
  const progress = assignments.map((assignment): PlanPublicationProgressIntent => {
    if (!partIds.has(assignment.draftPartId)) {
      throw new Error("Plan publication assignment Part is missing");
    }
    const expectedIndex = nextIndex.get(assignment.draftPartId) ?? 0;
    if (assignment.unitIndex !== expectedIndex) {
      throw new Error("Plan publication assignment indexes are not contiguous");
    }
    nextIndex.set(assignment.draftPartId, expectedIndex + 1);
    if (assignment.kind === "create") {
      return {
        draftPartId: assignment.draftPartId,
        unitIndex: assignment.unitIndex,
        assignment: "create",
        token: null,
        completed: false,
        assembled: false,
      };
    }
    const token = parseRequiredUnitToken(assignment.token);
    const base = baseByToken.get(token);
    if (!base) throw new Error("Plan publication reused token is unknown");
    if (reused.has(token)) throw new Error("Plan publication reused token is duplicated");
    reused.add(token);
    return {
      draftPartId: assignment.draftPartId,
      unitIndex: assignment.unitIndex,
      assignment: "reuse",
      token,
      completed: base.completed,
      assembled: base.assembled,
    };
  });
  let expectedUnitCount = 0;
  for (const part of parts) {
    expectedUnitCount += part.quantityEffective;
    if ((nextIndex.get(part.draftPartId) ?? 0) !== part.quantityEffective) {
      throw new Error("Plan publication assignment count is incomplete");
    }
  }
  if (assignments.length !== expectedUnitCount) {
    throw new Error("Plan publication assignment count is incomplete");
  }
  return {
    parts,
    mappings: assignments,
    progress,
    expectedUnitCount,
    revisionDigest: digestPlanRevisionParts(parts),
  };
}
