import { and, asc, eq, gt, inArray, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { DrizzleDb } from "./client.js";
import * as defaultSchema from "./schema.js";
import {
  digestPlanRevisionParts,
  MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES,
  PLAN_REVISION_DIGEST_FORMAT,
} from "../services/plan-publication.js";
import { digestPlanInputs } from "../services/plan-freshness.js";
import {
  digestRequiredUnitMap,
  parseRequiredUnitToken,
  REQUIRED_UNIT_MAP_FORMAT,
  validateRequiredUnitObjectName,
} from "../services/required-units.js";
import type { PlanRevisionInput } from "@print-partner/contracts";
import { resolveStoredSnapshotPath } from "./stored-snapshot-path.js";

export type AcceptedPlanCorruptionCode =
  | "pointer"
  | "revision"
  | "revision_digest"
  | "accepted_inputs"
  | "source_revision"
  | "projection"
  | "required_unit_map"
  | "progress"
  | "artifact_linkage";

export class AcceptedPlanOperationalIntegrityError extends Error {
  readonly code: AcceptedPlanCorruptionCode;

  constructor(code: AcceptedPlanCorruptionCode, message: string) {
    super(message);
    this.name = "AcceptedPlanOperationalIntegrityError";
    this.code = code;
  }
}

type AcceptedOperationalInputCommon = {
  readonly inputId: number;
  readonly sourceId: number;
  readonly sourceLayer: string;
  readonly layerOrder: number;
  readonly effectiveNamingDigest: string;
};

export type AcceptedOperationalInput =
  | (AcceptedOperationalInputCommon & {
      readonly trackingKind: "revision";
      readonly sourceRevisionId: number;
      readonly manifestDigest: string;
      readonly snapshotRoot: string;
      readonly sourceSyncedAt: string;
    })
  | (AcceptedOperationalInputCommon & {
      readonly trackingKind: "untracked";
      readonly sourceRevisionId: null;
      readonly manifestDigest: null;
      readonly snapshotRoot: null;
      readonly sourceSyncedAt: null;
    });

export type AcceptedOperationalArtifact =
  | {
      readonly kind: "tracked";
      readonly sourceId: number;
      readonly sourceRevisionId: number;
      readonly snapshotRoot: string;
      readonly relativePath: string;
      readonly expectedSha256: string;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "legacy" | "untracked_source";
    };

export type AcceptedOperationalUnit = {
  readonly unitIndex: number;
  readonly required: boolean;
  readonly token: string;
  readonly objectName: string;
  readonly completed: boolean;
  readonly assembled: boolean;
};

export type AcceptedOperationalPart = {
  readonly revisionPartId: number;
  readonly projectionPartId: number;
  readonly partKey: string;
  readonly relativePath: string;
  readonly filename: string;
  readonly sourceLayer: string;
  readonly status: string;
  readonly roleInferred: string;
  readonly roleOverride: string | null;
  readonly effectiveRole: string;
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
  readonly artifact: AcceptedOperationalArtifact;
  readonly units: readonly AcceptedOperationalUnit[];
};

export type AcceptedPlanOperationalSnapshot = {
  readonly format: "accepted-plan-operational-v1";
  readonly profile: {
    readonly id: number;
    readonly name: string;
    readonly orderNumber: string | null;
    readonly specialRequest: string | null;
    readonly archivedAt: string | null;
  };
  readonly planVersion: number;
  readonly revisionId: number;
  readonly revisionNumber: number;
  readonly revisionDigest: string;
  readonly acceptedAt: string;
  readonly provenance:
    | { readonly kind: "legacy" }
    | {
        readonly kind: "tracked";
        readonly inputSetId: number;
        readonly inputSetDigest: string;
        readonly inputs: readonly AcceptedOperationalInput[];
      };
  readonly requiredUnitMappingDigest: string;
  readonly parts: readonly AcceptedOperationalPart[];
};

export type ReadAcceptedPlanOperationalSnapshotResult =
  | { readonly kind: "ready"; readonly snapshot: AcceptedPlanOperationalSnapshot }
  | { readonly kind: "empty" | "compatibility_dirty" | "uninitialized" };

export type AcceptedPlanOperationalSchema = Pick<
  typeof defaultSchema,
  | "buildProfiles"
  | "parts"
  | "planAcceptedInputSets"
  | "planRevisions"
  | "planRevisionParts"
  | "requiredUnits"
  | "planRevisionRequiredUnitSets"
  | "planRevisionRequiredUnits"
  | "planRevisionInputSets"
  | "planRevisionInputs"
  | "projects"
  | "sourceRevisions"
  | "printProgress"
>;

type AcceptedPlanOperationalReadDependencies = {
  readonly db: DrizzleDb;
  readonly schema: AcceptedPlanOperationalSchema;
  readonly tenantId: string;
  readonly profileId: number;
  readonly reposDir: string;
  readonly sqlite: boolean;
};

function corrupt(code: AcceptedPlanCorruptionCode, message: string): never {
  throw new AcceptedPlanOperationalIntegrityError(code, message);
}

function validateStoredRequiredUnit(token: string, objectName: string): void {
  try {
    parseRequiredUnitToken(token);
    validateRequiredUnitObjectName(objectName, token);
  } catch {
    corrupt("required_unit_map", "Accepted Plan Required-unit syntax is corrupt");
  }
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const ACCEPTED_READ_PAGE_SIZE = 256;
export const ACCEPTED_TEXT_PAGE_SIZE = 16;
export const ACCEPTED_IN_LIST_SIZE = 64;

function chunks<T>(items: readonly T[], size = ACCEPTED_IN_LIST_SIZE): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function digestFormat1Inputs(
  rows: readonly { readonly sourceRevisionId: number; readonly manifestDigest: string }[],
): string {
  const canonical = [...rows]
    .map((row) => ({
      source_revision_id: row.sourceRevisionId,
      manifest_digest: row.manifestDigest,
    }))
    .sort((left, right) => left.source_revision_id - right.source_revision_id);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function storedTextBytes(sqlite: boolean, columns: readonly AnyColumn[]): SQL<number> {
  return columns.reduce<SQL<number>>(
    (total, column) =>
      sqlite
        ? sql<number>`${total} + length(cast(coalesce(${column}, '') as blob))`
        : sql<number>`${total} + octet_length(coalesce(${column}, ''))`,
    sql<number>`0`,
  );
}

export const acceptedPlanStoredTextBytes = storedTextBytes;

function validateStoredTextBytes(
  bytes: number,
  code: AcceptedPlanCorruptionCode,
  message: string,
): void {
  if (!Number.isSafeInteger(bytes) || bytes > MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES) {
    corrupt(code, message);
  }
}

export const validateAcceptedPlanStoredTextBytes = validateStoredTextBytes;

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isSafeLayerOrder(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isSafeRelativePath(value: string): boolean {
  const segments = value.split("/");
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/.test(value) &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function storedBoolean(value: unknown): boolean | null {
  if (value === false || value === 0) return false;
  if (value === true || value === 1) return true;
  return null;
}

function revisionDigestParts(
  rows: readonly (typeof defaultSchema.planRevisionParts.$inferSelect)[],
) {
  return rows.map((part) => ({
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
  }));
}

export type AcceptedPlanValidatedPart = {
  readonly revisionPart: typeof defaultSchema.planRevisionParts.$inferSelect;
  readonly projectionPart: typeof defaultSchema.parts.$inferSelect;
};

export type ProjectionPlanningFields = Readonly<{
  matchKey: string;
  relativePath: string;
  filename: string;
  sourceLayer: string;
  status: string;
  role: string;
  quantityAuto: number;
  quantityOverride: number | null;
  quantityEffective: number;
  included: boolean;
  notes: string;
  githubBlobUrl: string | null;
  geometrySame: boolean | null;
  requirement: string | null;
  optionGroupId: string | null;
  manifestSource: string | null;
}>;

export type RevisionPlanningFields = Readonly<{
  partKey: string;
  relativePath: string;
  filename: string;
  sourceLayer: string;
  status: string;
  role: string;
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
}>;

export function projectionPlanningFieldsMatch(
  projection: ProjectionPlanningFields,
  revision: RevisionPlanningFields,
): boolean {
  return (
    projection.matchKey === revision.partKey &&
    projection.relativePath === revision.relativePath &&
    projection.filename === revision.filename &&
    projection.sourceLayer === revision.sourceLayer &&
    projection.status === revision.status &&
    projection.role === revision.role &&
    projection.quantityAuto === revision.quantityInferred &&
    projection.quantityOverride === revision.quantityOverride &&
    projection.quantityEffective === revision.quantityEffective &&
    projection.included === revision.included &&
    projection.notes === revision.notes &&
    projection.githubBlobUrl === revision.githubBlobUrl &&
    projection.geometrySame === revision.geometrySame &&
    projection.requirement === revision.requirement &&
    projection.optionGroupId === revision.optionGroupId &&
    projection.manifestSource === revision.manifestSource
  );
}

export type AcceptedPlanPointerValidation =
  | { readonly kind: "missing" }
  | { readonly kind: "empty" }
  | { readonly kind: "compatibility_dirty" }
  | {
      readonly kind: "ready";
      readonly profile: typeof defaultSchema.buildProfiles.$inferSelect & {
        readonly acceptedPlanRevisionId: number;
      };
    };

export const validateAcceptedPlanPointerRows = (input: {
  readonly tenantId: string;
  readonly profile: typeof defaultSchema.buildProfiles.$inferSelect | undefined;
  readonly hasCompatibilityPart: boolean;
  readonly hasAcceptedInput: boolean;
  readonly hasHistoricalRevision: boolean;
}): AcceptedPlanPointerValidation => {
  const { profile } = input;
  if (!profile || profile.tenantId !== input.tenantId) return { kind: "missing" };
  if (!Number.isSafeInteger(profile.acceptedPlanVersion) || profile.acceptedPlanVersion < 0) {
    corrupt("pointer", "Accepted Plan pointer is corrupt");
  }
  if (profile.acceptedPlanRevisionId == null) {
    if (profile.acceptedPlanVersion === 0 && input.hasHistoricalRevision) {
      corrupt("pointer", "Accepted Plan history has no pointer");
    }
    if (
      profile.acceptedPlanVersion > 0 ||
      input.hasCompatibilityPart ||
      input.hasAcceptedInput
    ) {
      return { kind: "compatibility_dirty" };
    }
    return { kind: "empty" };
  }
  if (profile.acceptedPlanVersion === 0) {
    corrupt("pointer", "Accepted Plan pointer has a zero version");
  }
  return {
    kind: "ready",
    profile: {
      ...profile,
      acceptedPlanRevisionId: profile.acceptedPlanRevisionId,
    },
  };
};

export const validateAcceptedPlanRevisionRows = (input: {
  readonly tenantId: string;
  readonly profileId: number;
  readonly revision: typeof defaultSchema.planRevisions.$inferSelect;
  readonly parent: { readonly tenantId: string; readonly profileId: number } | null;
  readonly revisionParts: readonly (typeof defaultSchema.planRevisionParts.$inferSelect)[];
}): void => {
  const { revision } = input;
  if (
    revision.tenantId !== input.tenantId ||
    revision.profileId !== input.profileId ||
    !Number.isSafeInteger(revision.revisionNumber) ||
    revision.revisionNumber <= 0 ||
    revision.digestFormat !== PLAN_REVISION_DIGEST_FORMAT ||
    !isCanonicalTimestamp(revision.createdAt) ||
    !isCanonicalTimestamp(revision.acceptedAt) ||
    revision.createdBy.length === 0 ||
    revision.acceptedBy.length === 0 ||
    ((revision.provenanceKind === "legacy" && revision.inputSetId != null) ||
      (revision.provenanceKind === "tracked" && revision.inputSetId == null))
  ) {
    corrupt("revision", "Accepted Plan revision is corrupt");
  }
  if (
    revision.parentRevisionId != null &&
    (!input.parent ||
      input.parent.tenantId !== input.tenantId ||
      input.parent.profileId !== input.profileId)
  ) {
    corrupt("revision", "Accepted Plan revision parent is corrupt");
  }
  if (
    input.revisionParts.some(
      (part) => !isPositiveSafeInteger(part.id) || part.tenantId !== input.tenantId,
    )
  ) {
    corrupt("revision", "Accepted Plan revision Part ownership is corrupt");
  }
  if (
    digestPlanRevisionParts(revisionDigestParts(input.revisionParts)) !== revision.snapshotDigest
  ) {
    corrupt("revision_digest", "Accepted Plan revision digest is corrupt");
  }
};

export const validateAcceptedPlanInputHeaderRows = (input: {
  readonly tenantId: string;
  readonly profileId: number;
  readonly revision: typeof defaultSchema.planRevisions.$inferSelect;
  readonly acceptedInput:
    | typeof defaultSchema.planAcceptedInputSets.$inferSelect
    | undefined;
  readonly inputSet: typeof defaultSchema.planRevisionInputSets.$inferSelect | undefined;
}): "legacy" | "format1" | "format2" => {
  if (input.revision.provenanceKind === "legacy") {
    if (input.revision.inputSetId != null || input.acceptedInput) {
      corrupt("accepted_inputs", "Legacy accepted Plan has input provenance");
    }
    return "legacy";
  }
  const inputSetId = input.revision.inputSetId;
  if (
    input.revision.provenanceKind !== "tracked" ||
    inputSetId == null ||
    !input.acceptedInput ||
    input.acceptedInput.tenantId !== input.tenantId ||
    input.acceptedInput.profileId !== input.profileId ||
    input.acceptedInput.inputSetId !== inputSetId ||
    input.acceptedInput.acceptedAt !== input.revision.acceptedAt ||
    !input.inputSet ||
    input.inputSet.id !== inputSetId ||
    input.inputSet.tenantId !== input.tenantId ||
    input.inputSet.profileId !== input.profileId ||
    input.inputSet.publishedAt == null ||
    !isCanonicalTimestamp(input.inputSet.recordedAt) ||
    !isCanonicalTimestamp(input.inputSet.publishedAt) ||
    !Number.isSafeInteger(input.inputSet.expectedInputCount) ||
    input.inputSet.expectedInputCount < 0 ||
    (input.inputSet.formatVersion !== 1 && input.inputSet.formatVersion !== 2)
  ) {
    corrupt("accepted_inputs", "Accepted Plan input header is corrupt");
  }
  return input.inputSet.formatVersion === 1 ? "format1" : "format2";
};

export const validateAcceptedPlanProjectionRows = (input: {
  readonly tenantId: string;
  readonly revisionParts: readonly (typeof defaultSchema.planRevisionParts.$inferSelect)[];
  readonly projectionRows: readonly (typeof defaultSchema.parts.$inferSelect)[];
  readonly revisionBooleans: ReadonlyMap<
    number,
    { readonly included: unknown; readonly geometrySame: unknown }
  >;
  readonly projectionBooleans: ReadonlyMap<
    number,
    { readonly included: unknown; readonly geometrySame: unknown }
  >;
}): readonly AcceptedPlanValidatedPart[] => {
  if (
    input.projectionRows.length !== input.revisionParts.length ||
    input.projectionRows.some(
      (row) =>
        row.tenantId !== input.tenantId ||
        !isPositiveSafeInteger(row.id) ||
        storedBoolean(input.projectionBooleans.get(row.id)?.included) == null ||
        (input.projectionBooleans.get(row.id)?.geometrySame != null &&
          storedBoolean(input.projectionBooleans.get(row.id)?.geometrySame) == null),
    ) ||
    input.revisionParts.some(
      (row) =>
        storedBoolean(input.revisionBooleans.get(row.id)?.included) == null ||
        (input.revisionBooleans.get(row.id)?.geometrySame != null &&
          storedBoolean(input.revisionBooleans.get(row.id)?.geometrySame) == null),
    )
  ) {
    corrupt("projection", "Accepted Plan Part booleans or ownership are corrupt");
  }
  const projectionById = new Map(input.projectionRows.map((row) => [row.id, row]));
  const projectionIds = new Set<number>();
  const partKeys = new Set<string>();
  const validated = [...input.revisionParts]
    .sort((left, right) => left.id - right.id)
    .map((part): AcceptedPlanValidatedPart => {
      if (
        !isPositiveSafeInteger(part.projectionPartId ?? 0) ||
        projectionIds.has(part.projectionPartId!) ||
        part.partKey.length === 0 ||
        partKeys.has(part.partKey) ||
        !isPositiveSafeInteger(part.quantityInferred) ||
        part.quantityInferred > 10_000 ||
        (part.quantityOverride != null &&
          (!isPositiveSafeInteger(part.quantityOverride) || part.quantityOverride > 10_000)) ||
        !isPositiveSafeInteger(part.quantityEffective) ||
        part.quantityEffective > 10_000 ||
        part.quantityEffective !== (part.quantityOverride ?? part.quantityInferred)
      ) {
        corrupt("projection", "Accepted Plan revision Part identity is corrupt");
      }
      projectionIds.add(part.projectionPartId!);
      partKeys.add(part.partKey);
      const projection = projectionById.get(part.projectionPartId!);
      const effectiveRole = part.roleOverride ?? part.roleInferred;
      if (
        !projection ||
        !projectionPlanningFieldsMatch(projection, {
          partKey: part.partKey,
          relativePath: part.relativePath,
          filename: part.filename,
          sourceLayer: part.sourceLayer,
          status: part.status,
          role: effectiveRole,
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
        })
      ) {
        corrupt("projection", "Accepted Plan projection differs from its revision");
      }
      return { revisionPart: part, projectionPart: projection };
    });
  if (projectionById.size !== projectionIds.size) {
    corrupt("projection", "Accepted Plan projection has extra Parts");
  }
  return validated;
};

export type AcceptedPlanRequiredUnitMappingRow =
  typeof defaultSchema.planRevisionRequiredUnits.$inferSelect;
export type AcceptedPlanRequiredUnitRow = typeof defaultSchema.requiredUnits.$inferSelect;
export type AcceptedPlanProgressRow = {
  readonly id: number;
  readonly tenantId: string;
  readonly partId: number;
  readonly unitIndex: number;
  readonly completed: unknown;
  readonly assembled: unknown;
};

export const validateAcceptedPlanRequiredUnitRows = (input: {
  readonly tenantId: string;
  readonly profileId: number;
  readonly revisionId: number;
  readonly requiredSet: typeof defaultSchema.planRevisionRequiredUnitSets.$inferSelect;
  readonly parts: readonly {
    readonly revisionPartId: number;
    readonly included: boolean;
    readonly quantityEffective: number;
  }[];
  readonly mappings: readonly AcceptedPlanRequiredUnitMappingRow[];
  readonly units: readonly AcceptedPlanRequiredUnitRow[];
  readonly creationRevisions: readonly {
    readonly id: number;
    readonly tenantId: string;
    readonly profileId: number;
  }[];
  readonly createdHere: readonly AcceptedPlanRequiredUnitRow[];
}): {
  readonly mappingDigest: string;
  readonly byPart: ReadonlyMap<number, readonly UnitWithoutProgress[]>;
} => {
  const expectedUnitCount = input.parts.reduce(
    (sum, part) => sum + part.quantityEffective,
    0,
  );
  if (
    input.requiredSet.tenantId !== input.tenantId ||
    input.requiredSet.profileId !== input.profileId ||
    input.requiredSet.format !== REQUIRED_UNIT_MAP_FORMAT ||
    !Number.isSafeInteger(input.requiredSet.expectedUnitCount) ||
    input.requiredSet.expectedUnitCount !== expectedUnitCount ||
    input.mappings.length !== expectedUnitCount
  ) {
    corrupt("required_unit_map", "Accepted Plan Required-unit header or mappings are corrupt");
  }
  const unitByToken = new Map(input.units.map((unit) => [unit.token, unit]));
  const creationById = new Map(input.creationRevisions.map((revision) => [revision.id, revision]));
  const partById = new Map(input.parts.map((part) => [part.revisionPartId, part]));
  const nextIndex = new Map<number, number>();
  const seenTokens = new Set<string>();
  const seenObjectNames = new Set<string>();
  const byPart = new Map<number, UnitWithoutProgress[]>();
  const digestRows = [...input.mappings]
    .sort(
      (left, right) =>
        left.revisionPartId - right.revisionPartId ||
        left.unitIndex - right.unitIndex ||
        left.tenantId.localeCompare(right.tenantId),
    )
    .map((mapping) => {
      const part = partById.get(mapping.revisionPartId);
      const unit = unitByToken.get(mapping.requiredUnitToken);
      const creationRevision = unit ? creationById.get(unit.createdInRevisionId) : null;
      const expectedIndex = part ? (nextIndex.get(mapping.revisionPartId) ?? 0) : -1;
      if (
        mapping.tenantId !== input.tenantId ||
        mapping.revisionId !== input.revisionId ||
        !part ||
        mapping.unitIndex !== expectedIndex ||
        mapping.unitIndex >= part.quantityEffective ||
        seenTokens.has(mapping.requiredUnitToken) ||
        !unit ||
        unit.tenantId !== input.tenantId ||
        unit.profileId !== input.profileId ||
        !creationRevision ||
        creationRevision.tenantId !== input.tenantId ||
        creationRevision.profileId !== input.profileId
      ) {
        corrupt("required_unit_map", "Accepted Plan Required-unit ownership is corrupt");
      }
      validateStoredRequiredUnit(unit.token, unit.objectName);
      const objectNameKey = unit.objectName.toLowerCase();
      if (seenObjectNames.has(objectNameKey)) {
        corrupt("required_unit_map", "Accepted Plan Required-unit Object name is duplicated");
      }
      seenTokens.add(unit.token);
      seenObjectNames.add(objectNameKey);
      nextIndex.set(mapping.revisionPartId, expectedIndex + 1);
      const partUnits = byPart.get(mapping.revisionPartId) ?? [];
      partUnits.push({
        unitIndex: mapping.unitIndex,
        required: part.included,
        token: unit.token,
        objectName: unit.objectName,
      });
      byPart.set(mapping.revisionPartId, partUnits);
      return {
        revisionPartId: mapping.revisionPartId,
        unitIndex: mapping.unitIndex,
        token: unit.token,
        objectName: unit.objectName,
      };
    });
  for (const part of input.parts) {
    if ((nextIndex.get(part.revisionPartId) ?? 0) !== part.quantityEffective) {
      corrupt("required_unit_map", "Accepted Plan Required-unit coordinates are incomplete");
    }
  }
  if (
    input.createdHere.some(
      (unit) =>
        unit.tenantId !== input.tenantId ||
        unit.profileId !== input.profileId ||
        !seenTokens.has(unit.token),
    )
  ) {
    corrupt("required_unit_map", "Accepted Plan Required unit is orphaned");
  }
  let digest: string;
  try {
    digest = digestRequiredUnitMap({
      revisionId: input.revisionId,
      expectedUnitCount,
      rows: digestRows,
    });
  } catch {
    corrupt("required_unit_map", "Accepted Plan Required-unit digest input is corrupt");
  }
  if (digest !== input.requiredSet.mappingDigest) {
    corrupt("required_unit_map", "Accepted Plan Required-unit digest is corrupt");
  }
  return { mappingDigest: digest, byPart };
};

export const validateAcceptedPlanProgressRows = (input: {
  readonly tenantId: string;
  readonly parts: readonly {
    readonly projectionPartId: number;
    readonly quantityEffective: number;
  }[];
  readonly rows: readonly AcceptedPlanProgressRow[];
}): ReadonlyMap<string, { readonly completed: boolean; readonly assembled: boolean }> => {
  const currentCoordinates = new Set(
    input.parts.flatMap((part) =>
      Array.from(
        { length: part.quantityEffective },
        (_, unitIndex) => `${part.projectionPartId}:${unitIndex}`,
      ),
    ),
  );
  const progress = new Map<string, { completed: boolean; assembled: boolean }>();
  for (const row of input.rows) {
    const key = `${row.partId}:${row.unitIndex}`;
    if (!currentCoordinates.has(key)) continue;
    const completed = storedBoolean(row.completed);
    const assembled = storedBoolean(row.assembled);
    if (
      row.tenantId !== input.tenantId ||
      progress.has(key) ||
      completed == null ||
      assembled == null ||
      (assembled && !completed)
    ) {
      corrupt("progress", "Accepted Plan progress is corrupt");
    }
    progress.set(key, { completed, assembled });
  }
  return progress;
};

type AcceptedInputState =
  | { readonly kind: "legacy" }
  | { readonly kind: "format1" }
  | {
      readonly kind: "tracked";
      readonly inputSetId: number;
      readonly inputSetDigest: string;
      readonly inputs: readonly AcceptedOperationalInput[];
      readonly byLayer: ReadonlyMap<string, AcceptedOperationalInput>;
     };

function validateSourceRevisionText(input: {
  readonly db: DrizzleDb;
  readonly schema: AcceptedPlanOperationalSchema;
  readonly sqlite: boolean;
  readonly sourceRevisionId: number;
}): void {
  const row = input.db
    .select({
      bytes: storedTextBytes(input.sqlite, [
        input.schema.sourceRevisions.tenantId,
        input.schema.sourceRevisions.upstreamRevisionKey,
        input.schema.sourceRevisions.manifestDigest,
        input.schema.sourceRevisions.snapshotLocator,
        input.schema.sourceRevisions.syncedAt,
        input.schema.sourceRevisions.completeness,
      ]),
    })
    .from(input.schema.sourceRevisions)
    .where(eq(input.schema.sourceRevisions.id, input.sourceRevisionId))
    .get();
  if (row) {
    validateStoredTextBytes(
      row.bytes,
      "source_revision",
      "Accepted Plan Source revision text is corrupt",
    );
  }
}

function loadAcceptedInputs(input: {
  readonly db: DrizzleDb;
  readonly schema: AcceptedPlanOperationalSchema;
  readonly tenantId: string;
  readonly profileId: number;
  readonly reposDir: string;
  readonly sqlite: boolean;
  readonly revision: typeof defaultSchema.planRevisions.$inferSelect;
  readonly acceptedInputs: readonly (typeof defaultSchema.planAcceptedInputSets.$inferSelect)[];
}): AcceptedInputState {
  const { db, schema, tenantId, profileId, reposDir, revision, acceptedInputs } = input;
  if (revision.provenanceKind === "legacy") {
    validateAcceptedPlanInputHeaderRows({
      tenantId,
      profileId,
      revision,
      acceptedInput: acceptedInputs[0],
      inputSet: undefined,
    });
    return { kind: "legacy" };
  }
  if (revision.inputSetId == null) {
    corrupt("revision", "Accepted Plan revision provenance is corrupt");
  }
  const setText = db
    .select({
      bytes: storedTextBytes(input.sqlite, [
        schema.planRevisionInputSets.tenantId,
        schema.planRevisionInputSets.inputSetDigest,
        schema.planRevisionInputSets.recordedAt,
        schema.planRevisionInputSets.publishedAt,
      ]),
    })
    .from(schema.planRevisionInputSets)
    .where(eq(schema.planRevisionInputSets.id, revision.inputSetId))
    .get();
  if (setText) {
    validateStoredTextBytes(
      setText.bytes,
      "accepted_inputs",
      "Accepted Plan input set text is corrupt",
    );
  }
  const set = db
    .select()
    .from(schema.planRevisionInputSets)
    .where(eq(schema.planRevisionInputSets.id, revision.inputSetId))
    .get();
  validateAcceptedPlanInputHeaderRows({
    tenantId,
    profileId,
    revision,
    acceptedInput: acceptedInputs.length === 1 ? acceptedInputs[0] : undefined,
    inputSet: set,
  });
  if (!set) corrupt("accepted_inputs", "Accepted Plan input set is corrupt");
  let lastInputPreflightId: number | null = null;
  while (true) {
    const page: Array<{ readonly id: number; readonly bytes: number }> = db
      .select({
        id: schema.planRevisionInputs.id,
        bytes: storedTextBytes(input.sqlite, [
          schema.planRevisionInputs.tenantId,
          schema.planRevisionInputs.manifestDigest,
          schema.planRevisionInputs.sourceLayer,
          schema.planRevisionInputs.trackingKind,
          schema.planRevisionInputs.effectiveNamingDigest,
        ]),
      })
      .from(schema.planRevisionInputs)
      .where(
        lastInputPreflightId == null
          ? eq(schema.planRevisionInputs.inputSetId, set.id)
          : and(
              eq(schema.planRevisionInputs.inputSetId, set.id),
              gt(schema.planRevisionInputs.id, lastInputPreflightId),
            ),
      )
      .orderBy(asc(schema.planRevisionInputs.id))
      .limit(ACCEPTED_READ_PAGE_SIZE)
      .all();
    for (const row of page) {
      if (!isPositiveSafeInteger(row.id)) {
        corrupt("accepted_inputs", "Accepted Plan input row ID is corrupt");
      }
      validateStoredTextBytes(
        row.bytes,
        "accepted_inputs",
        "Accepted Plan input row text is corrupt",
      );
    }
    if (page.length < ACCEPTED_READ_PAGE_SIZE) break;
    lastInputPreflightId = page.at(-1)!.id;
  }
  const rows: Array<typeof defaultSchema.planRevisionInputs.$inferSelect> = [];
  let lastInputId: number | null = null;
  while (true) {
    const page: Array<typeof defaultSchema.planRevisionInputs.$inferSelect> = db
      .select()
      .from(schema.planRevisionInputs)
      .where(
        lastInputId == null
          ? eq(schema.planRevisionInputs.inputSetId, set.id)
          : and(
              eq(schema.planRevisionInputs.inputSetId, set.id),
              gt(schema.planRevisionInputs.id, lastInputId),
            ),
      )
      .orderBy(asc(schema.planRevisionInputs.id))
      .limit(ACCEPTED_TEXT_PAGE_SIZE)
      .all();
    rows.push(...page);
    if (page.length < ACCEPTED_TEXT_PAGE_SIZE) break;
    lastInputId = page.at(-1)!.id;
  }
  if (
    rows.length !== set.expectedInputCount ||
    rows.some((row) => row.tenantId !== tenantId)
  ) {
    corrupt("accepted_inputs", "Accepted Plan input set is incomplete");
  }
  if (set.formatVersion === 1) {
    const sourceIds = new Set<number>();
    const sourceLayers = new Set<string>();
    for (const row of rows) {
      const source = db
        .select({ id: schema.projects.id, tenantId: schema.projects.tenantId })
        .from(schema.projects)
        .where(eq(schema.projects.id, row.sourceId))
        .get();
      if (
        !isPositiveSafeInteger(row.sourceId) ||
        sourceIds.has(row.sourceId) ||
        row.sourceLayer !== `legacy:${row.sourceId}` ||
        sourceLayers.has(row.sourceLayer) ||
        row.layerOrder !== 0 ||
        row.trackingKind !== "revision" ||
        row.effectiveNamingDigest != null ||
        row.sourceRevisionId == null ||
        row.manifestDigest == null ||
        !SHA256_PATTERN.test(row.manifestDigest) ||
        !source ||
        source.tenantId !== tenantId
      ) {
        corrupt("accepted_inputs", "Format-1 accepted Plan input set is corrupt");
      }
      validateSourceRevisionText({
        db,
        schema,
        sqlite: input.sqlite,
        sourceRevisionId: row.sourceRevisionId,
      });
      const sourceRevision = db
        .select()
        .from(schema.sourceRevisions)
        .where(eq(schema.sourceRevisions.id, row.sourceRevisionId))
        .get();
      const snapshotRoot = sourceRevision
        ? resolveStoredSnapshotPath(reposDir, sourceRevision.snapshotLocator)
        : null;
      if (
        !sourceRevision ||
        sourceRevision.tenantId !== tenantId ||
        sourceRevision.projectId !== row.sourceId ||
        sourceRevision.completeness !== "complete" ||
        sourceRevision.manifestDigest !== row.manifestDigest ||
        snapshotRoot == null ||
        !isCanonicalTimestamp(sourceRevision.syncedAt)
      ) {
        corrupt("source_revision", "Format-1 accepted Plan Source revision is corrupt");
      }
      sourceIds.add(row.sourceId);
      sourceLayers.add(row.sourceLayer);
    }
    if (
      digestFormat1Inputs(
        rows.map((row) => ({
          sourceRevisionId: row.sourceRevisionId!,
          manifestDigest: row.manifestDigest!,
        })),
      ) !== set.inputSetDigest
    ) {
      corrupt("accepted_inputs", "Format-1 accepted Plan input digest is corrupt");
    }
    return { kind: "format1" };
  }
  const sourceIds = new Set<number>();
  const sourceLayers = new Set<string>();
  const layerOrders = new Set<number>();
  const operationalInputs: AcceptedOperationalInput[] = [];
  const canonicalInputs: PlanRevisionInput[] = [];
  for (const row of rows) {
    if (
      !isPositiveSafeInteger(row.sourceId) ||
      sourceIds.has(row.sourceId) ||
      row.sourceLayer.length === 0 ||
      sourceLayers.has(row.sourceLayer) ||
      !isSafeLayerOrder(row.layerOrder) ||
      layerOrders.has(row.layerOrder) ||
      row.effectiveNamingDigest == null ||
      !SHA256_PATTERN.test(row.effectiveNamingDigest)
    ) {
      corrupt("accepted_inputs", "Accepted Plan input identity is corrupt");
    }
    sourceIds.add(row.sourceId);
    sourceLayers.add(row.sourceLayer);
    layerOrders.add(row.layerOrder);
      const source = db
      .select({ id: schema.projects.id, tenantId: schema.projects.tenantId })
      .from(schema.projects)
      .where(eq(schema.projects.id, row.sourceId))
      .get();
    if (!source || source.tenantId !== tenantId) {
      corrupt("source_revision", "Accepted Plan Source ownership is corrupt");
    }
    if (row.trackingKind === "revision") {
      if (
        row.sourceRevisionId == null ||
        row.manifestDigest == null ||
        !SHA256_PATTERN.test(row.manifestDigest)
      ) {
        corrupt("source_revision", "Accepted Plan Source revision identity is corrupt");
      }
      validateSourceRevisionText({
        db,
        schema,
        sqlite: input.sqlite,
        sourceRevisionId: row.sourceRevisionId,
      });
      const sourceRevision = db
        .select()
        .from(schema.sourceRevisions)
        .where(eq(schema.sourceRevisions.id, row.sourceRevisionId))
        .get();
      const snapshotRoot = sourceRevision
        ? resolveStoredSnapshotPath(reposDir, sourceRevision.snapshotLocator)
        : null;
      if (
        !sourceRevision ||
        sourceRevision.tenantId !== tenantId ||
        sourceRevision.projectId !== row.sourceId ||
        sourceRevision.completeness !== "complete" ||
        sourceRevision.manifestDigest !== row.manifestDigest ||
        snapshotRoot == null ||
        !isCanonicalTimestamp(sourceRevision.syncedAt)
      ) {
        corrupt("source_revision", "Accepted Plan Source revision is corrupt");
      }
      operationalInputs.push({
        inputId: row.id,
        sourceId: row.sourceId,
        sourceLayer: row.sourceLayer,
        layerOrder: row.layerOrder,
        effectiveNamingDigest: row.effectiveNamingDigest,
        trackingKind: "revision",
        sourceRevisionId: row.sourceRevisionId,
        manifestDigest: row.manifestDigest,
        snapshotRoot,
        sourceSyncedAt: sourceRevision.syncedAt,
      });
      canonicalInputs.push({
        source_id: row.sourceId,
        source_layer: row.sourceLayer,
        layer_order: row.layerOrder,
        tracking_kind: "revision",
        source_revision_id: row.sourceRevisionId,
        manifest_digest: row.manifestDigest,
        effective_naming_digest: row.effectiveNamingDigest,
      });
      continue;
    }
    if (
      row.trackingKind !== "untracked" ||
      row.sourceRevisionId != null ||
      row.manifestDigest != null
    ) {
      corrupt("source_revision", "Accepted Plan untracked Source identity is corrupt");
    }
    operationalInputs.push({
      inputId: row.id,
      sourceId: row.sourceId,
      sourceLayer: row.sourceLayer,
      layerOrder: row.layerOrder,
      effectiveNamingDigest: row.effectiveNamingDigest,
      trackingKind: "untracked",
      sourceRevisionId: null,
      manifestDigest: null,
      snapshotRoot: null,
      sourceSyncedAt: null,
    });
    canonicalInputs.push({
      source_id: row.sourceId,
      source_layer: row.sourceLayer,
      layer_order: row.layerOrder,
      tracking_kind: "untracked",
      source_revision_id: null,
      manifest_digest: null,
      effective_naming_digest: row.effectiveNamingDigest,
    });
  }
  if (digestPlanInputs(canonicalInputs) !== set.inputSetDigest) {
    corrupt("accepted_inputs", "Accepted Plan input digest is corrupt");
  }
  operationalInputs.sort(
    (left, right) => left.layerOrder - right.layerOrder || left.sourceId - right.sourceId,
  );
  return {
    kind: "tracked",
    inputSetId: set.id,
    inputSetDigest: set.inputSetDigest,
    inputs: operationalInputs,
    byLayer: new Map(operationalInputs.map((row) => [row.sourceLayer, row])),
  };
}

type LoadedAcceptedPart = {
  readonly value: Omit<AcceptedOperationalPart, "units">;
  readonly included: boolean;
  readonly quantityEffective: number;
};

function loadAcceptedParts(input: {
  readonly db: DrizzleDb;
  readonly schema: AcceptedPlanOperationalSchema;
  readonly tenantId: string;
  readonly profileId: number;
  readonly revisionParts: readonly (typeof defaultSchema.planRevisionParts.$inferSelect)[];
  readonly inputState: AcceptedInputState;
  readonly sqlite: boolean;
}): LoadedAcceptedPart[] {
  const { db, schema, tenantId, profileId, revisionParts, inputState, sqlite } = input;
  let lastProjectionPreflightId: number | null = null;
  while (true) {
    const page = db
      .select({
        id: schema.parts.id,
        bytes: storedTextBytes(sqlite, [
          schema.parts.tenantId,
          schema.parts.matchKey,
          schema.parts.relativePath,
          schema.parts.filename,
          schema.parts.sourceLayer,
          schema.parts.status,
          schema.parts.role,
          schema.parts.filamentColorId,
          schema.parts.filamentCustomHex,
          schema.parts.spoolmanSpoolId,
          schema.parts.notes,
          schema.parts.githubBlobUrl,
          schema.parts.requirement,
          schema.parts.optionGroupId,
          schema.parts.manifestSource,
        ]),
      })
      .from(schema.parts)
      .where(
        lastProjectionPreflightId == null
          ? eq(schema.parts.profileId, profileId)
          : and(
              eq(schema.parts.profileId, profileId),
              gt(schema.parts.id, lastProjectionPreflightId),
            ),
      )
      .orderBy(asc(schema.parts.id))
      .limit(ACCEPTED_READ_PAGE_SIZE)
      .all();
    for (const row of page) {
      if (!isPositiveSafeInteger(row.id)) {
        corrupt("projection", "Accepted Plan projection Part ID is corrupt");
      }
      validateStoredTextBytes(
        row.bytes,
        "projection",
        "Accepted Plan projection Part text is corrupt",
      );
    }
    if (page.length < ACCEPTED_READ_PAGE_SIZE) break;
    lastProjectionPreflightId = page.at(-1)!.id;
  }
  const projectionRows: Array<typeof defaultSchema.parts.$inferSelect> = [];
  const projectionBooleanEvidence: Array<{
    id: number;
    included: unknown;
    geometrySame: unknown;
  }> = [];
  let lastProjectionId: number | null = null;
  while (true) {
    const page = db
      .select()
      .from(schema.parts)
      .where(
        lastProjectionId == null
          ? eq(schema.parts.profileId, profileId)
          : and(eq(schema.parts.profileId, profileId), gt(schema.parts.id, lastProjectionId)),
      )
      .orderBy(asc(schema.parts.id))
      .limit(ACCEPTED_TEXT_PAGE_SIZE)
      .all();
    projectionRows.push(...page);
    if (page.length < ACCEPTED_TEXT_PAGE_SIZE) break;
    lastProjectionId = page.at(-1)!.id;
  }
  lastProjectionId = null;
  while (true) {
    const page = db
      .select({
        id: schema.parts.id,
        included: sql<unknown>`${schema.parts.included}`,
        geometrySame: sql<unknown>`${schema.parts.geometrySame}`,
      })
      .from(schema.parts)
      .where(
        lastProjectionId == null
          ? eq(schema.parts.profileId, profileId)
          : and(eq(schema.parts.profileId, profileId), gt(schema.parts.id, lastProjectionId)),
      )
      .orderBy(asc(schema.parts.id))
      .limit(ACCEPTED_TEXT_PAGE_SIZE)
      .all();
    projectionBooleanEvidence.push(...page);
    if (page.length < ACCEPTED_TEXT_PAGE_SIZE) break;
    lastProjectionId = page.at(-1)!.id;
  }
  const revisionBooleanEvidence: Array<{
    id: number;
    included: unknown;
    geometrySame: unknown;
  }> = [];
  for (const ids of chunks(revisionParts.map((part) => part.id))) {
    revisionBooleanEvidence.push(
      ...db
        .select({
          id: schema.planRevisionParts.id,
          included: sql<unknown>`${schema.planRevisionParts.included}`,
          geometrySame: sql<unknown>`${schema.planRevisionParts.geometrySame}`,
        })
        .from(schema.planRevisionParts)
        .where(inArray(schema.planRevisionParts.id, ids))
        .orderBy(asc(schema.planRevisionParts.id))
        .all(),
    );
  }
  return validateAcceptedPlanProjectionRows({
    tenantId,
    revisionParts,
    projectionRows,
    revisionBooleans: new Map(
      revisionBooleanEvidence.map((row) => [
        row.id,
        { included: row.included, geometrySame: row.geometrySame },
      ]),
    ),
    projectionBooleans: new Map(
      projectionBooleanEvidence.map((row) => [
        row.id,
        { included: row.included, geometrySame: row.geometrySame },
      ]),
    ),
  }).map(({ revisionPart: part, projectionPart: projection }): LoadedAcceptedPart => {
      const effectiveRole = part.roleOverride ?? part.roleInferred;
      let artifact: AcceptedOperationalArtifact;
      if (inputState.kind === "legacy" || inputState.kind === "format1") {
        artifact = { kind: "unavailable", reason: "legacy" };
      } else {
        const acceptedInput = inputState.byLayer.get(part.sourceLayer);
        if (!acceptedInput) {
          corrupt("artifact_linkage", "Accepted Plan Part has no pinned input");
        }
        if (acceptedInput.trackingKind === "untracked") {
          if (part.artifactDigest != null) {
            corrupt("artifact_linkage", "Untracked accepted Plan Part claims an artifact digest");
          }
          artifact = { kind: "unavailable", reason: "untracked_source" };
        } else {
          if (!isSafeRelativePath(part.relativePath) || !SHA256_PATTERN.test(part.artifactDigest ?? "")) {
            corrupt("artifact_linkage", "Tracked accepted Plan Part artifact is corrupt");
          }
          artifact = {
            kind: "tracked",
            sourceId: acceptedInput.sourceId,
            sourceRevisionId: acceptedInput.sourceRevisionId,
            snapshotRoot: acceptedInput.snapshotRoot,
            relativePath: part.relativePath,
            expectedSha256: part.artifactDigest!,
          };
        }
      }
    return {
        included: part.included,
        quantityEffective: part.quantityEffective,
        value: {
          revisionPartId: part.id,
          projectionPartId: part.projectionPartId!,
          partKey: part.partKey,
          relativePath: part.relativePath,
          filename: part.filename,
          sourceLayer: part.sourceLayer,
          status: part.status,
          roleInferred: part.roleInferred,
          roleOverride: part.roleOverride,
          effectiveRole,
          filamentColorId: projection.filamentColorId,
          filamentCustomHex: projection.filamentCustomHex,
          spoolmanSpoolId: projection.spoolmanSpoolId,
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
          artifact,
        },
    };
  });
}

type UnitWithoutProgress = Omit<AcceptedOperationalUnit, "completed" | "assembled">;

function loadRequiredUnits(input: {
  readonly db: DrizzleDb;
  readonly schema: AcceptedPlanOperationalSchema;
  readonly tenantId: string;
  readonly profileId: number;
  readonly revisionId: number;
  readonly requiredSet: typeof defaultSchema.planRevisionRequiredUnitSets.$inferSelect;
  readonly parts: readonly LoadedAcceptedPart[];
  readonly sqlite: boolean;
}): {
  readonly mappingDigest: string;
  readonly byPart: ReadonlyMap<number, readonly UnitWithoutProgress[]>;
} {
  const { db, schema, tenantId, profileId, revisionId, requiredSet, parts, sqlite } = input;
  let lastMappingPreflight:
    | { readonly revisionPartId: number; readonly unitIndex: number; readonly tenantId: string }
    | null = null;
  while (true) {
    const page: Array<{
      readonly revisionPartId: number;
      readonly unitIndex: number;
      readonly tenantId: string;
      readonly bytes: number;
    }> = db
      .select({
        revisionPartId: schema.planRevisionRequiredUnits.revisionPartId,
        unitIndex: schema.planRevisionRequiredUnits.unitIndex,
        tenantId: schema.planRevisionRequiredUnits.tenantId,
        bytes: storedTextBytes(sqlite, [
          schema.planRevisionRequiredUnits.tenantId,
          schema.planRevisionRequiredUnits.requiredUnitToken,
        ]),
      })
      .from(schema.planRevisionRequiredUnits)
      .where(
        lastMappingPreflight == null
          ? eq(schema.planRevisionRequiredUnits.revisionId, revisionId)
          : and(
              eq(schema.planRevisionRequiredUnits.revisionId, revisionId),
              or(
                gt(
                  schema.planRevisionRequiredUnits.revisionPartId,
                  lastMappingPreflight.revisionPartId,
                ),
                and(
                  eq(
                    schema.planRevisionRequiredUnits.revisionPartId,
                    lastMappingPreflight.revisionPartId,
                  ),
                  gt(schema.planRevisionRequiredUnits.unitIndex, lastMappingPreflight.unitIndex),
                ),
                and(
                  eq(
                    schema.planRevisionRequiredUnits.revisionPartId,
                    lastMappingPreflight.revisionPartId,
                  ),
                  eq(schema.planRevisionRequiredUnits.unitIndex, lastMappingPreflight.unitIndex),
                  gt(schema.planRevisionRequiredUnits.tenantId, lastMappingPreflight.tenantId),
                ),
              ),
            ),
      )
      .orderBy(
        asc(schema.planRevisionRequiredUnits.revisionPartId),
        asc(schema.planRevisionRequiredUnits.unitIndex),
        asc(schema.planRevisionRequiredUnits.tenantId),
      )
      .limit(ACCEPTED_TEXT_PAGE_SIZE)
      .all();
    for (const row of page) {
      validateStoredTextBytes(
        row.bytes,
        "required_unit_map",
        "Accepted Plan Required-unit mapping text is corrupt",
      );
    }
    if (page.length < ACCEPTED_TEXT_PAGE_SIZE) break;
    const last: (typeof page)[number] = page.at(-1)!;
    lastMappingPreflight = {
      revisionPartId: last.revisionPartId,
      unitIndex: last.unitIndex,
      tenantId: last.tenantId,
    };
  }
  const mappings: Array<typeof defaultSchema.planRevisionRequiredUnits.$inferSelect> = [];
  let lastMapping:
    | { readonly revisionPartId: number; readonly unitIndex: number; readonly tenantId: string }
    | null = null;
  while (true) {
    const page: Array<typeof defaultSchema.planRevisionRequiredUnits.$inferSelect> = db
      .select()
      .from(schema.planRevisionRequiredUnits)
      .where(
        lastMapping == null
          ? eq(schema.planRevisionRequiredUnits.revisionId, revisionId)
          : and(
              eq(schema.planRevisionRequiredUnits.revisionId, revisionId),
              or(
                gt(
                  schema.planRevisionRequiredUnits.revisionPartId,
                  lastMapping.revisionPartId,
                ),
                and(
                  eq(
                    schema.planRevisionRequiredUnits.revisionPartId,
                    lastMapping.revisionPartId,
                  ),
                  gt(schema.planRevisionRequiredUnits.unitIndex, lastMapping.unitIndex),
                ),
                and(
                  eq(
                    schema.planRevisionRequiredUnits.revisionPartId,
                    lastMapping.revisionPartId,
                  ),
                  eq(schema.planRevisionRequiredUnits.unitIndex, lastMapping.unitIndex),
                  gt(schema.planRevisionRequiredUnits.tenantId, lastMapping.tenantId),
                ),
              ),
            ),
      )
      .orderBy(
        asc(schema.planRevisionRequiredUnits.revisionPartId),
        asc(schema.planRevisionRequiredUnits.unitIndex),
        asc(schema.planRevisionRequiredUnits.tenantId),
      )
      .limit(ACCEPTED_TEXT_PAGE_SIZE)
      .all();
    mappings.push(...page);
    if (page.length < ACCEPTED_TEXT_PAGE_SIZE) break;
    const last: (typeof page)[number] = page.at(-1)!;
    lastMapping = {
      revisionPartId: last.revisionPartId,
      unitIndex: last.unitIndex,
      tenantId: last.tenantId,
    };
  }
  const tokens = mappings.map((mapping) => mapping.requiredUnitToken);
  const units: Array<typeof defaultSchema.requiredUnits.$inferSelect> = [];
  for (const tokenChunk of chunks(tokens, ACCEPTED_TEXT_PAGE_SIZE)) {
    const preflight = db
      .select({
        token: schema.requiredUnits.token,
        bytes: storedTextBytes(sqlite, [
          schema.requiredUnits.token,
          schema.requiredUnits.tenantId,
          schema.requiredUnits.objectName,
          schema.requiredUnits.createdAt,
        ]),
      })
      .from(schema.requiredUnits)
      .where(inArray(schema.requiredUnits.token, tokenChunk))
      .orderBy(asc(schema.requiredUnits.token))
      .all();
    for (const row of preflight) {
      validateStoredTextBytes(
        row.bytes,
        "required_unit_map",
        "Accepted Plan Required-unit text is corrupt",
      );
    }
    units.push(
      ...db
        .select()
        .from(schema.requiredUnits)
        .where(inArray(schema.requiredUnits.token, tokenChunk))
        .orderBy(asc(schema.requiredUnits.token))
        .all(),
    );
  }
  const creationRevisionIds = [...new Set(units.map((unit) => unit.createdInRevisionId))];
  const creationRevisions: Array<{ id: number; tenantId: string; profileId: number }> = [];
  for (const revisionIds of chunks(creationRevisionIds, ACCEPTED_TEXT_PAGE_SIZE)) {
    const preflight = db
      .select({
        id: schema.planRevisions.id,
        bytes: storedTextBytes(sqlite, [schema.planRevisions.tenantId]),
      })
      .from(schema.planRevisions)
      .where(inArray(schema.planRevisions.id, revisionIds))
      .orderBy(asc(schema.planRevisions.id))
      .all();
    for (const row of preflight) {
      validateStoredTextBytes(
        row.bytes,
        "required_unit_map",
        "Required-unit creation revision ownership is corrupt",
      );
    }
    creationRevisions.push(
      ...db
        .select({
          id: schema.planRevisions.id,
          tenantId: schema.planRevisions.tenantId,
          profileId: schema.planRevisions.profileId,
        })
        .from(schema.planRevisions)
        .where(inArray(schema.planRevisions.id, revisionIds))
        .orderBy(asc(schema.planRevisions.id))
        .all(),
    );
  }
  let lastCreatedPreflightToken: string | null = null;
  while (true) {
    const page = db
      .select({
        token: schema.requiredUnits.token,
        bytes: storedTextBytes(sqlite, [
          schema.requiredUnits.token,
          schema.requiredUnits.tenantId,
          schema.requiredUnits.objectName,
          schema.requiredUnits.createdAt,
        ]),
      })
      .from(schema.requiredUnits)
      .where(
        lastCreatedPreflightToken == null
          ? eq(schema.requiredUnits.createdInRevisionId, revisionId)
          : and(
              eq(schema.requiredUnits.createdInRevisionId, revisionId),
              gt(schema.requiredUnits.token, lastCreatedPreflightToken),
            ),
      )
      .orderBy(asc(schema.requiredUnits.token))
      .limit(ACCEPTED_TEXT_PAGE_SIZE)
      .all();
    for (const row of page) {
      validateStoredTextBytes(
        row.bytes,
        "required_unit_map",
        "Accepted Plan Required-unit text is corrupt",
      );
    }
    if (page.length < ACCEPTED_TEXT_PAGE_SIZE) break;
    lastCreatedPreflightToken = page.at(-1)!.token;
  }
  const createdHere: Array<typeof defaultSchema.requiredUnits.$inferSelect> = [];
  let lastCreatedToken: string | null = null;
  while (true) {
    const page = db
      .select()
      .from(schema.requiredUnits)
      .where(
        lastCreatedToken == null
          ? eq(schema.requiredUnits.createdInRevisionId, revisionId)
          : and(
              eq(schema.requiredUnits.createdInRevisionId, revisionId),
              gt(schema.requiredUnits.token, lastCreatedToken),
            ),
      )
      .orderBy(asc(schema.requiredUnits.token))
      .limit(ACCEPTED_TEXT_PAGE_SIZE)
      .all();
    createdHere.push(...page);
    if (page.length < ACCEPTED_TEXT_PAGE_SIZE) break;
    lastCreatedToken = page.at(-1)!.token;
  }
  return validateAcceptedPlanRequiredUnitRows({
    tenantId,
    profileId,
    revisionId,
    requiredSet,
    parts: parts.map((part) => ({
      revisionPartId: part.value.revisionPartId,
      included: part.included,
      quantityEffective: part.quantityEffective,
    })),
    mappings,
    units,
    creationRevisions,
    createdHere,
  });
}

function loadProgress(input: {
  readonly db: DrizzleDb;
  readonly schema: AcceptedPlanOperationalSchema;
  readonly tenantId: string;
  readonly parts: readonly LoadedAcceptedPart[];
  readonly sqlite: boolean;
}): ReadonlyMap<string, { readonly completed: boolean; readonly assembled: boolean }> {
  const { db, schema, tenantId, parts } = input;
  const projectionIds = parts.map((part) => part.value.projectionPartId);
  if (projectionIds.length === 0) return new Map();
  const rows: Array<{
    id: number;
    tenantId: string;
    partId: number;
    unitIndex: number;
    completed: unknown;
    assembled: unknown;
  }> = [];
  for (const projectionIdChunk of chunks(projectionIds)) {
    let lastProgressPreflightId: number | null = null;
    while (true) {
      const page = db
        .select({
          id: schema.printProgress.id,
          bytes: storedTextBytes(input.sqlite, [schema.printProgress.tenantId]),
        })
        .from(schema.printProgress)
        .where(
          lastProgressPreflightId == null
            ? inArray(schema.printProgress.partId, projectionIdChunk)
            : and(
                inArray(schema.printProgress.partId, projectionIdChunk),
                gt(schema.printProgress.id, lastProgressPreflightId),
              ),
        )
        .orderBy(asc(schema.printProgress.id))
        .limit(ACCEPTED_READ_PAGE_SIZE)
        .all();
      for (const row of page) {
        validateStoredTextBytes(row.bytes, "progress", "Accepted Plan progress text is corrupt");
      }
      if (page.length < ACCEPTED_READ_PAGE_SIZE) break;
      lastProgressPreflightId = page.at(-1)!.id;
    }
    let lastProgressId: number | null = null;
    while (true) {
      const page = db
        .select({
          id: schema.printProgress.id,
          tenantId: schema.printProgress.tenantId,
          partId: schema.printProgress.partId,
          unitIndex: schema.printProgress.unitIndex,
          completed: sql<unknown>`${schema.printProgress.completed}`,
          assembled: sql<unknown>`${schema.printProgress.assembled}`,
        })
        .from(schema.printProgress)
        .where(
          lastProgressId == null
            ? inArray(schema.printProgress.partId, projectionIdChunk)
            : and(
                inArray(schema.printProgress.partId, projectionIdChunk),
                gt(schema.printProgress.id, lastProgressId),
              ),
        )
        .orderBy(asc(schema.printProgress.id))
        .limit(ACCEPTED_TEXT_PAGE_SIZE)
        .all();
      rows.push(...page);
      if (page.length < ACCEPTED_TEXT_PAGE_SIZE) break;
      lastProgressId = page.at(-1)!.id;
    }
  }
  return validateAcceptedPlanProgressRows({
    tenantId,
    parts: parts.map((part) => ({
      projectionPartId: part.value.projectionPartId,
      quantityEffective: part.quantityEffective,
    })),
    rows,
  });
}

type AcceptedTerminalIdentity = {
  readonly acceptedPlanRevisionId: number | null;
  readonly acceptedPlanVersion: number | null;
  readonly acceptedInputSetId: number | null;
  readonly acceptedInputAcceptedAt: string | null;
  readonly requiredUnitMappingDigest: string | null;
};

function readTerminalIdentity(
  input: AcceptedPlanOperationalReadDependencies,
): AcceptedTerminalIdentity {
  const row = input.db
    .select({
      acceptedPlanRevisionId: input.schema.buildProfiles.acceptedPlanRevisionId,
      acceptedPlanVersion: input.schema.buildProfiles.acceptedPlanVersion,
      acceptedInputSetId: input.schema.planAcceptedInputSets.inputSetId,
      acceptedInputAcceptedAt: input.schema.planAcceptedInputSets.acceptedAt,
      requiredUnitMappingDigest: input.schema.planRevisionRequiredUnitSets.mappingDigest,
    })
    .from(input.schema.buildProfiles)
    .leftJoin(
      input.schema.planAcceptedInputSets,
      eq(input.schema.planAcceptedInputSets.profileId, input.schema.buildProfiles.id),
    )
    .leftJoin(
      input.schema.planRevisionRequiredUnitSets,
      eq(
        input.schema.planRevisionRequiredUnitSets.revisionId,
        input.schema.buildProfiles.acceptedPlanRevisionId,
      ),
    )
    .where(eq(input.schema.buildProfiles.id, input.profileId))
    .get();
  return row ?? {
    acceptedPlanRevisionId: null,
    acceptedPlanVersion: null,
    acceptedInputSetId: null,
    acceptedInputAcceptedAt: null,
    requiredUnitMappingDigest: null,
  };
}

function terminalIdentityEqual(
  left: AcceptedTerminalIdentity,
  right: AcceptedTerminalIdentity,
): boolean {
  return (
    left.acceptedPlanRevisionId === right.acceptedPlanRevisionId &&
    left.acceptedPlanVersion === right.acceptedPlanVersion &&
    left.acceptedInputSetId === right.acceptedInputSetId &&
    left.acceptedInputAcceptedAt === right.acceptedInputAcceptedAt &&
    left.requiredUnitMappingDigest === right.requiredUnitMappingDigest
  );
}

function loadAcceptedPlanOperationalSnapshot(
  dependencies: AcceptedPlanOperationalReadDependencies,
): ReadAcceptedPlanOperationalSnapshotResult {
  const { db, schema, tenantId, profileId } = dependencies;
  const profileText = db
    .select({
      bytes: storedTextBytes(dependencies.sqlite, [
        schema.buildProfiles.tenantId,
        schema.buildProfiles.name,
        schema.buildProfiles.orderNumber,
        schema.buildProfiles.specialRequest,
        schema.buildProfiles.archivedAt,
      ]),
    })
    .from(schema.buildProfiles)
    .where(eq(schema.buildProfiles.id, profileId))
    .get();
  if (profileText) {
    validateStoredTextBytes(profileText.bytes, "pointer", "Accepted Plan Build text is corrupt");
  }
  const profile = db
    .select()
    .from(schema.buildProfiles)
    .where(eq(schema.buildProfiles.id, profileId))
    .get();
  const compatibilityPart = db
    .select({ id: schema.parts.id })
    .from(schema.parts)
    .where(eq(schema.parts.profileId, profileId))
    .get();
  const acceptedInputPointerText = db
    .select({
      bytes: storedTextBytes(dependencies.sqlite, [
        schema.planAcceptedInputSets.tenantId,
        schema.planAcceptedInputSets.acceptedAt,
      ]),
    })
    .from(schema.planAcceptedInputSets)
    .where(eq(schema.planAcceptedInputSets.profileId, profileId))
    .get();
  if (acceptedInputPointerText) {
    validateStoredTextBytes(
      acceptedInputPointerText.bytes,
      "accepted_inputs",
      "Accepted Plan input pointer text is corrupt",
    );
  }
  const acceptedInputs = db
    .select()
    .from(schema.planAcceptedInputSets)
    .where(eq(schema.planAcceptedInputSets.profileId, profileId))
    .all();
  const historicalRevision = db
    .select({ id: schema.planRevisions.id })
    .from(schema.planRevisions)
    .where(eq(schema.planRevisions.profileId, profileId))
    .get();
  const pointer = validateAcceptedPlanPointerRows({
    tenantId,
    profile,
    hasCompatibilityPart: compatibilityPart != null,
    hasAcceptedInput: acceptedInputs.length > 0,
    hasHistoricalRevision: historicalRevision != null,
  });
  if (pointer.kind === "missing") throw new Error("Profile not found");
  if (pointer.kind === "empty" || pointer.kind === "compatibility_dirty") return pointer;
  const acceptedProfile = pointer.profile;
  const revisionText = db
    .select({
      bytes: storedTextBytes(dependencies.sqlite, [
        schema.planRevisions.tenantId,
        schema.planRevisions.provenanceKind,
        schema.planRevisions.digestFormat,
        schema.planRevisions.snapshotDigest,
        schema.planRevisions.createdBy,
        schema.planRevisions.acceptedBy,
        schema.planRevisions.createdAt,
        schema.planRevisions.acceptedAt,
      ]),
    })
    .from(schema.planRevisions)
    .where(eq(schema.planRevisions.id, acceptedProfile.acceptedPlanRevisionId))
    .get();
  if (revisionText) {
    validateStoredTextBytes(
      revisionText.bytes,
      "revision",
      "Accepted Plan revision text is corrupt",
    );
  }
  const revision = db
    .select()
    .from(schema.planRevisions)
    .where(eq(schema.planRevisions.id, acceptedProfile.acceptedPlanRevisionId))
    .get();
  if (!revision) corrupt("revision", "Accepted Plan revision is corrupt");
  const parent =
    revision.parentRevisionId == null
      ? null
      : db
      .select({
        tenantId: schema.planRevisions.tenantId,
        profileId: schema.planRevisions.profileId,
      })
      .from(schema.planRevisions)
      .where(eq(schema.planRevisions.id, revision.parentRevisionId))
      .get();
  let lastRevisionPartPreflightId: number | null = null;
  while (true) {
    const page = db
      .select({
        id: schema.planRevisionParts.id,
        bytes: storedTextBytes(dependencies.sqlite, [
          schema.planRevisionParts.tenantId,
          schema.planRevisionParts.partKey,
          schema.planRevisionParts.relativePath,
          schema.planRevisionParts.filename,
          schema.planRevisionParts.sourceLayer,
          schema.planRevisionParts.status,
          schema.planRevisionParts.roleInferred,
          schema.planRevisionParts.roleOverride,
          schema.planRevisionParts.filamentColorId,
          schema.planRevisionParts.filamentCustomHex,
          schema.planRevisionParts.spoolmanSpoolId,
          schema.planRevisionParts.notes,
          schema.planRevisionParts.githubBlobUrl,
          schema.planRevisionParts.requirement,
          schema.planRevisionParts.optionGroupId,
          schema.planRevisionParts.manifestSource,
          schema.planRevisionParts.artifactDigest,
        ]),
      })
      .from(schema.planRevisionParts)
      .where(
        lastRevisionPartPreflightId == null
          ? eq(schema.planRevisionParts.revisionId, revision.id)
          : and(
              eq(schema.planRevisionParts.revisionId, revision.id),
              gt(schema.planRevisionParts.id, lastRevisionPartPreflightId),
            ),
      )
      .orderBy(asc(schema.planRevisionParts.id))
      .limit(ACCEPTED_READ_PAGE_SIZE)
      .all();
    for (const row of page) {
      if (!isPositiveSafeInteger(row.id)) {
        corrupt("revision", "Accepted Plan revision Part ID is corrupt");
      }
      validateStoredTextBytes(
        row.bytes,
        "revision",
        "Accepted Plan revision Part text is corrupt",
      );
    }
    if (page.length < ACCEPTED_READ_PAGE_SIZE) break;
    lastRevisionPartPreflightId = page.at(-1)!.id;
  }
  const revisionParts: Array<typeof defaultSchema.planRevisionParts.$inferSelect> = [];
  let lastRevisionPartId: number | null = null;
  while (true) {
    const page = db
      .select()
      .from(schema.planRevisionParts)
      .where(
        lastRevisionPartId == null
          ? eq(schema.planRevisionParts.revisionId, revision.id)
          : and(
              eq(schema.planRevisionParts.revisionId, revision.id),
              gt(schema.planRevisionParts.id, lastRevisionPartId),
            ),
      )
      .orderBy(asc(schema.planRevisionParts.id))
      .limit(ACCEPTED_TEXT_PAGE_SIZE)
      .all();
    revisionParts.push(...page);
    if (page.length < ACCEPTED_TEXT_PAGE_SIZE) break;
    lastRevisionPartId = page.at(-1)!.id;
  }
  validateAcceptedPlanRevisionRows({
    tenantId,
    profileId,
    revision,
    parent: parent ?? null,
    revisionParts,
  });
  const inputState = loadAcceptedInputs({
    db,
    schema,
    tenantId,
    profileId,
    reposDir: dependencies.reposDir,
    sqlite: dependencies.sqlite,
    revision,
    acceptedInputs,
  });
  const parts = loadAcceptedParts({
    db,
    schema,
    tenantId,
    profileId,
    revisionParts,
    inputState,
    sqlite: dependencies.sqlite,
  });
  const requiredSetText = db
    .select({
      bytes: storedTextBytes(dependencies.sqlite, [
        schema.planRevisionRequiredUnitSets.tenantId,
        schema.planRevisionRequiredUnitSets.format,
        schema.planRevisionRequiredUnitSets.mappingDigest,
        schema.planRevisionRequiredUnitSets.createdAt,
      ]),
    })
    .from(schema.planRevisionRequiredUnitSets)
    .where(eq(schema.planRevisionRequiredUnitSets.revisionId, revision.id))
    .get();
  if (requiredSetText) {
    validateStoredTextBytes(
      requiredSetText.bytes,
      "required_unit_map",
      "Accepted Plan Required-unit header text is corrupt",
    );
  }
  const requiredSet = db
    .select()
    .from(schema.planRevisionRequiredUnitSets)
    .where(eq(schema.planRevisionRequiredUnitSets.revisionId, revision.id))
    .get();
  if (!requiredSet) {
    const mapping = db
      .select({ revisionId: schema.planRevisionRequiredUnits.revisionId })
      .from(schema.planRevisionRequiredUnits)
      .where(eq(schema.planRevisionRequiredUnits.revisionId, revision.id))
      .get();
    const createdUnit = db
      .select({ token: schema.requiredUnits.token })
      .from(schema.requiredUnits)
      .where(eq(schema.requiredUnits.createdInRevisionId, revision.id))
      .get();
    if (mapping || createdUnit) {
      corrupt("required_unit_map", "Accepted Plan Required-unit set is partial");
    }
    return { kind: "uninitialized" };
  }
  const mapped = loadRequiredUnits({
    db,
    schema,
    tenantId,
    profileId,
    revisionId: revision.id,
    requiredSet,
    parts,
    sqlite: dependencies.sqlite,
  });
  if (inputState.kind === "format1") return { kind: "uninitialized" };
  const progressByCoordinate = loadProgress({
    db,
    schema,
    tenantId,
    parts,
    sqlite: dependencies.sqlite,
  });
  return {
    kind: "ready",
    snapshot: {
      format: "accepted-plan-operational-v1",
      profile: {
        id: acceptedProfile.id,
        name: acceptedProfile.name,
        orderNumber: acceptedProfile.orderNumber,
        specialRequest: acceptedProfile.specialRequest,
        archivedAt: acceptedProfile.archivedAt,
      },
      planVersion: acceptedProfile.acceptedPlanVersion,
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber,
      revisionDigest: revision.snapshotDigest,
      acceptedAt: revision.acceptedAt,
      provenance:
        inputState.kind === "legacy"
          ? { kind: "legacy" }
          : {
              kind: "tracked",
              inputSetId: inputState.inputSetId,
              inputSetDigest: inputState.inputSetDigest,
              inputs: inputState.inputs,
            },
      requiredUnitMappingDigest: mapped.mappingDigest,
      parts: parts.map((part) => ({
        ...part.value,
        units: mapped.byPart.get(part.value.revisionPartId)!.map((unit) => {
          const progress = progressByCoordinate.get(
            `${part.value.projectionPartId}:${unit.unitIndex}`,
          );
          return {
            ...unit,
            completed: progress?.completed ?? false,
            assembled: progress?.assembled ?? false,
          };
        }),
      })),
    },
  };
}

export function readAcceptedPlanOperationalSnapshotInternal(
  dependencies: AcceptedPlanOperationalReadDependencies,
): ReadAcceptedPlanOperationalSnapshotResult {
  const load = () => loadAcceptedPlanOperationalSnapshot(dependencies);
  if (dependencies.sqlite) return load();
  const firstIdentity = readTerminalIdentity(dependencies);
  const first = load();
  if (terminalIdentityEqual(firstIdentity, readTerminalIdentity(dependencies))) return first;
  const secondIdentity = readTerminalIdentity(dependencies);
  const second = load();
  if (terminalIdentityEqual(secondIdentity, readTerminalIdentity(dependencies))) return second;
  corrupt("pointer", "Accepted Plan identity changed during verification");
}
