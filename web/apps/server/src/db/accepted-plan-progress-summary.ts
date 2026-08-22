import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import type { DrizzleDb } from "./client.js";
import * as defaultSchema from "./schema.js";
import {
  ACCEPTED_READ_PAGE_SIZE,
  ACCEPTED_TEXT_PAGE_SIZE,
  AcceptedPlanOperationalIntegrityError,
  acceptedPlanStoredTextBytes,
  validateAcceptedPlanPointerRows,
  validateAcceptedPlanInputHeaderRows,
  validateAcceptedPlanProgressRows,
  validateAcceptedPlanProjectionRows,
  validateAcceptedPlanRequiredUnitRows,
  validateAcceptedPlanRevisionRows,
  validateAcceptedPlanStoredTextBytes,
  type AcceptedPlanCorruptionCode,
  type AcceptedPlanOperationalSchema,
  type AcceptedPlanProgressRow,
} from "./accepted-plan-operational.js";

export const MAX_ACCEPTED_PROGRESS_SUMMARY_BATCH = 64;

export type AcceptedPlanProgressRead =
  | {
      readonly kind: "ready";
      readonly profileId: number;
      readonly totalUnits: number;
      readonly remainingUnits: number;
    }
  | { readonly kind: "empty"; readonly profileId: number }
  | {
      readonly kind: "unavailable";
      readonly profileId: number;
      readonly reason: "compatibility_dirty" | "uninitialized";
    }
  | {
      readonly kind: "integrity_failure";
      readonly profileId: number;
      readonly code: AcceptedPlanCorruptionCode;
    }
  | { readonly kind: "concurrent_update"; readonly profileId: number }
  | { readonly kind: "missing"; readonly profileId: number };

export type AcceptedPlanProgressSummaryDependencies = {
  readonly db: DrizzleDb;
  readonly schema: AcceptedPlanOperationalSchema;
  readonly tenantId: string;
  readonly sqlite: boolean;
};

type AcceptedTerminalIdentity = {
  readonly acceptedPlanRevisionId: number | null;
  readonly acceptedPlanVersion: number | null;
  readonly acceptedInputSetId: number | null;
  readonly acceptedInputAcceptedAt: string | null;
  readonly requiredUnitMappingDigest: string | null;
};

type ProfileRow = typeof defaultSchema.buildProfiles.$inferSelect;

function canonicalProfileIds(profileIds: readonly number[]): readonly number[] {
  for (const profileId of profileIds) {
    if (!Number.isSafeInteger(profileId) || profileId <= 0) {
      throw new Error("Accepted Plan Progress profile IDs must be positive safe integers");
    }
  }
  const unique = [...new Set(profileIds)];
  if (unique.length > MAX_ACCEPTED_PROGRESS_SUMMARY_BATCH) {
    throw new Error(
      `Accepted Plan Progress batches contain at most ${MAX_ACCEPTED_PROGRESS_SUMMARY_BATCH} Plans`,
    );
  }
  return unique;
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

function readTerminalIdentities(
  dependencies: AcceptedPlanProgressSummaryDependencies,
  profileIds: readonly number[],
): {
  readonly identities: ReadonlyMap<number, AcceptedTerminalIdentity>;
  readonly profiles: ReadonlyMap<number, { readonly profile: ProfileRow; readonly textBytes: number }>;
} {
  const { db, schema } = dependencies;
  const identities = new Map<number, AcceptedTerminalIdentity>();
  const profiles = new Map<number, { readonly profile: ProfileRow; readonly textBytes: number }>();
  const lastRequestedProfileId = Math.max(...profileIds);
  let cursor: number | null = null;
  while (true) {
    const page = db
      .select({
        profile: schema.buildProfiles,
        profileId: schema.buildProfiles.id,
        acceptedPlanRevisionId: schema.buildProfiles.acceptedPlanRevisionId,
        acceptedPlanVersion: schema.buildProfiles.acceptedPlanVersion,
        acceptedInputSetId: schema.planAcceptedInputSets.inputSetId,
        acceptedInputAcceptedAt: schema.planAcceptedInputSets.acceptedAt,
        requiredUnitMappingDigest: schema.planRevisionRequiredUnitSets.mappingDigest,
        textBytes: acceptedPlanStoredTextBytes(dependencies.sqlite, [
          schema.buildProfiles.tenantId,
          schema.buildProfiles.name,
          schema.buildProfiles.orderNumber,
          schema.buildProfiles.specialRequest,
          schema.buildProfiles.archivedAt,
        ]),
      })
      .from(schema.buildProfiles)
      .leftJoin(
        schema.planAcceptedInputSets,
        and(
          eq(schema.planAcceptedInputSets.profileId, schema.buildProfiles.id),
          eq(schema.planAcceptedInputSets.tenantId, schema.buildProfiles.tenantId),
        ),
      )
      .leftJoin(
        schema.planRevisionRequiredUnitSets,
        and(
          eq(
            schema.planRevisionRequiredUnitSets.revisionId,
            schema.buildProfiles.acceptedPlanRevisionId,
          ),
          eq(schema.planRevisionRequiredUnitSets.tenantId, schema.buildProfiles.tenantId),
        ),
      )
      .where(
        cursor == null
          ? inArray(schema.buildProfiles.id, profileIds)
          : and(
              inArray(schema.buildProfiles.id, profileIds),
              gt(schema.buildProfiles.id, cursor),
            ),
      )
      .orderBy(asc(schema.buildProfiles.id))
      .limit(ACCEPTED_TEXT_PAGE_SIZE)
      .all();
    for (const row of page) {
      if (row.profile.tenantId === dependencies.tenantId) {
        identities.set(row.profileId, {
          acceptedPlanRevisionId: row.acceptedPlanRevisionId,
          acceptedPlanVersion: row.acceptedPlanVersion,
          acceptedInputSetId: row.acceptedInputSetId,
          acceptedInputAcceptedAt: row.acceptedInputAcceptedAt,
          requiredUnitMappingDigest: row.requiredUnitMappingDigest,
        });
      }
      profiles.set(row.profileId, { profile: row.profile, textBytes: row.textBytes });
    }
    if (
      page.length < ACCEPTED_TEXT_PAGE_SIZE ||
      page.at(-1)!.profileId >= lastRequestedProfileId
    ) {
      break;
    }
    cursor = page.at(-1)!.profileId;
  }
  const missing: AcceptedTerminalIdentity = {
    acceptedPlanRevisionId: null,
    acceptedPlanVersion: null,
    acceptedInputSetId: null,
    acceptedInputAcceptedAt: null,
    requiredUnitMappingDigest: null,
  };
  return {
    identities: new Map(
      profileIds.map((profileId) => [profileId, identities.get(profileId) ?? missing]),
    ),
    profiles,
  };
}

function readAcceptedInputPresenceByProfile(
  dependencies: AcceptedPlanProgressSummaryDependencies,
  profileIds: readonly number[],
): ReadonlySet<number> {
  const { db, schema } = dependencies;
  const found = new Set<number>();
  let cursor: number | null = null;
  while (true) {
    const page = db
      .select({ profileId: schema.planAcceptedInputSets.profileId })
      .from(schema.planAcceptedInputSets)
      .where(
        cursor == null
          ? inArray(schema.planAcceptedInputSets.profileId, profileIds)
          : and(
              inArray(schema.planAcceptedInputSets.profileId, profileIds),
              gt(schema.planAcceptedInputSets.profileId, cursor),
            ),
      )
      .orderBy(asc(schema.planAcceptedInputSets.profileId))
      .limit(ACCEPTED_READ_PAGE_SIZE)
      .all();
    for (const row of page) found.add(row.profileId);
    if (page.length < ACCEPTED_READ_PAGE_SIZE) break;
    cursor = page.at(-1)!.profileId;
  }
  return found;
}

function readProfiles(
  dependencies: AcceptedPlanProgressSummaryDependencies,
  profileIds: readonly number[],
): ReadonlyMap<number, { readonly profile: ProfileRow; readonly textBytes: number }> {
  const { db, schema } = dependencies;
  const profiles = new Map<number, { readonly profile: ProfileRow; readonly textBytes: number }>();
  const lastRequestedProfileId = Math.max(...profileIds);
  let cursor: number | null = null;
  while (true) {
    const page = db
      .select({
        profile: schema.buildProfiles,
        textBytes: acceptedPlanStoredTextBytes(dependencies.sqlite, [
          schema.buildProfiles.tenantId,
          schema.buildProfiles.name,
          schema.buildProfiles.orderNumber,
          schema.buildProfiles.specialRequest,
          schema.buildProfiles.archivedAt,
        ]),
      })
      .from(schema.buildProfiles)
      .where(
        cursor == null
          ? inArray(schema.buildProfiles.id, profileIds)
          : and(
              inArray(schema.buildProfiles.id, profileIds),
              gt(schema.buildProfiles.id, cursor),
            ),
      )
      .orderBy(asc(schema.buildProfiles.id))
      .limit(ACCEPTED_TEXT_PAGE_SIZE)
      .all();
    for (const row of page) profiles.set(row.profile.id, row);
    if (
      page.length < ACCEPTED_TEXT_PAGE_SIZE ||
      page.at(-1)!.profile.id >= lastRequestedProfileId
    ) {
      break;
    }
    cursor = page.at(-1)!.profile.id;
  }
  return profiles;
}

function readPresenceByProfile(input: {
  readonly dependencies: AcceptedPlanProgressSummaryDependencies;
  readonly profileIds: readonly number[];
  readonly table: "parts" | "revisions";
}): ReadonlySet<number> {
  const { db, schema } = input.dependencies;
  const found = new Set<number>();
  let cursor: number | null = null;
  while (true) {
    const source = input.table === "parts" ? schema.parts : schema.planRevisions;
    const page = db
      .select({ id: source.id, profileId: source.profileId })
      .from(source)
      .where(
        cursor == null
          ? inArray(source.profileId, input.profileIds)
          : and(inArray(source.profileId, input.profileIds), gt(source.id, cursor)),
      )
      .orderBy(asc(source.id))
      .limit(ACCEPTED_READ_PAGE_SIZE)
      .all();
    for (const row of page) found.add(row.profileId);
    if (page.length < ACCEPTED_READ_PAGE_SIZE) break;
    cursor = page.at(-1)!.id;
  }
  return found;
}

type AcceptedBatchRows = {
  readonly faults: ReadonlyMap<number, AcceptedPlanCorruptionCode>;
  readonly revisions: ReadonlyMap<number, typeof defaultSchema.planRevisions.$inferSelect>;
  readonly parents: ReadonlyMap<
    number,
    { readonly id: number; readonly tenantId: string; readonly profileId: number }
  >;
  readonly revisionParts: ReadonlyMap<
    number,
    readonly (typeof defaultSchema.planRevisionParts.$inferSelect)[]
  >;
  readonly revisionBooleans: ReadonlyMap<
    number,
    { readonly included: unknown; readonly geometrySame: unknown }
  >;
  readonly projectionParts: ReadonlyMap<
    number,
    readonly (typeof defaultSchema.parts.$inferSelect)[]
  >;
  readonly projectionBooleans: ReadonlyMap<
    number,
    { readonly included: unknown; readonly geometrySame: unknown }
  >;
  readonly requiredSets: ReadonlyMap<
    number,
    typeof defaultSchema.planRevisionRequiredUnitSets.$inferSelect
  >;
  readonly mappings: ReadonlyMap<
    number,
    readonly (typeof defaultSchema.planRevisionRequiredUnits.$inferSelect)[]
  >;
  readonly units: ReadonlyMap<string, typeof defaultSchema.requiredUnits.$inferSelect>;
  readonly creationRevisions: ReadonlyMap<
    number,
    { readonly id: number; readonly tenantId: string; readonly profileId: number }
  >;
  readonly createdHere: ReadonlyMap<
    number,
    readonly (typeof defaultSchema.requiredUnits.$inferSelect)[]
  >;
  readonly progress: readonly AcceptedPlanProgressRow[];
  readonly acceptedInputs: ReadonlyMap<
    number,
    typeof defaultSchema.planAcceptedInputSets.$inferSelect
  >;
  readonly inputSets: ReadonlyMap<
    number,
    typeof defaultSchema.planRevisionInputSets.$inferSelect
  >;
};

function appendGrouped<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const rows = map.get(key) ?? [];
  rows.push(value);
  map.set(key, rows);
}

function captureTextFault(input: {
  readonly faults: Map<number, AcceptedPlanCorruptionCode>;
  readonly profileId: number | undefined;
  readonly textBytes: number;
  readonly code: AcceptedPlanCorruptionCode;
  readonly message: string;
}): void {
  try {
    validateAcceptedPlanStoredTextBytes(input.textBytes, input.code, input.message);
  } catch (error) {
    if (!(error instanceof AcceptedPlanOperationalIntegrityError)) throw error;
    if (input.profileId != null && !input.faults.has(input.profileId)) {
      input.faults.set(input.profileId, error.code);
    }
  }
}

function loadAcceptedBatchRows(input: {
  readonly dependencies: AcceptedPlanProgressSummaryDependencies;
  readonly profiles: readonly ProfileRow[];
}): AcceptedBatchRows {
  const { db, schema } = input.dependencies;
  const revisionIds = input.profiles.flatMap((profile) =>
    profile.acceptedPlanRevisionId == null ? [] : [profile.acceptedPlanRevisionId],
  );
  const profileIds = input.profiles.map((profile) => profile.id);
  const profileIdByRevisionId = new Map(
    input.profiles.flatMap((profile) =>
      profile.acceptedPlanRevisionId == null
        ? []
        : [[profile.acceptedPlanRevisionId, profile.id] as const],
    ),
  );
  const faults = new Map<number, AcceptedPlanCorruptionCode>();
  const revisions = new Map<number, typeof defaultSchema.planRevisions.$inferSelect>();
  let revisionCursor: number | null = null;
  while (revisionIds.length > 0) {
    const page = db
      .select({
        revision: schema.planRevisions,
        textBytes: acceptedPlanStoredTextBytes(input.dependencies.sqlite, [
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
      .where(
        revisionCursor == null
          ? inArray(schema.planRevisions.id, revisionIds)
          : and(
              inArray(schema.planRevisions.id, revisionIds),
              gt(schema.planRevisions.id, revisionCursor),
            ),
      )
      .orderBy(asc(schema.planRevisions.id))
      .limit(ACCEPTED_TEXT_PAGE_SIZE)
      .all();
    for (const row of page) {
      captureTextFault({
        faults,
        profileId: profileIdByRevisionId.get(row.revision.id),
        textBytes: row.textBytes,
        code: "revision",
        message: "Accepted Plan revision text is corrupt",
      });
      revisions.set(row.revision.id, row.revision);
    }
    if (page.length < ACCEPTED_TEXT_PAGE_SIZE) break;
    revisionCursor = page.at(-1)!.revision.id;
  }

  const parentIds = [
    ...new Set([...revisions.values()].flatMap((row) => row.parentRevisionId ?? [])),
  ];
  const parents = new Map<
    number,
    { readonly id: number; readonly tenantId: string; readonly profileId: number }
  >();
  for (let index = 0; index < parentIds.length; index += ACCEPTED_TEXT_PAGE_SIZE) {
    const page = db
      .select({
        id: schema.planRevisions.id,
        tenantId: schema.planRevisions.tenantId,
        profileId: schema.planRevisions.profileId,
        textBytes: acceptedPlanStoredTextBytes(input.dependencies.sqlite, [
          schema.planRevisions.tenantId,
        ]),
      })
      .from(schema.planRevisions)
      .where(inArray(schema.planRevisions.id, parentIds.slice(index, index + ACCEPTED_TEXT_PAGE_SIZE)))
      .orderBy(asc(schema.planRevisions.id))
      .all();
    for (const row of page) {
      const owner = [...revisions.values()].find(
        (revision) => revision.parentRevisionId === row.id,
      );
      captureTextFault({
        faults,
        profileId: owner == null ? undefined : profileIdByRevisionId.get(owner.id),
        textBytes: row.textBytes,
        code: "revision",
        message: "Accepted Plan revision parent text is corrupt",
      });
      parents.set(row.id, row);
    }
  }

  const revisionParts = new Map<
    number,
    Array<typeof defaultSchema.planRevisionParts.$inferSelect>
  >();
  const revisionBooleans = new Map<
    number,
    { readonly included: unknown; readonly geometrySame: unknown }
  >();
  let revisionPartCursor: number | null = null;
  while (revisionIds.length > 0) {
    const page = db
      .select({
        part: schema.planRevisionParts,
        included: sql<unknown>`${schema.planRevisionParts.included}`,
        geometrySame: sql<unknown>`${schema.planRevisionParts.geometrySame}`,
        textBytes: acceptedPlanStoredTextBytes(input.dependencies.sqlite, [
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
        revisionPartCursor == null
          ? inArray(schema.planRevisionParts.revisionId, revisionIds)
          : and(
              inArray(schema.planRevisionParts.revisionId, revisionIds),
              gt(schema.planRevisionParts.id, revisionPartCursor),
            ),
      )
      .orderBy(asc(schema.planRevisionParts.id))
      .limit(ACCEPTED_TEXT_PAGE_SIZE)
      .all();
    for (const row of page) {
      captureTextFault({
        faults,
        profileId: profileIdByRevisionId.get(row.part.revisionId),
        textBytes: row.textBytes,
        code: "revision",
        message: "Accepted Plan revision Part text is corrupt",
      });
      appendGrouped(revisionParts, row.part.revisionId, row.part);
      revisionBooleans.set(row.part.id, {
        included: row.included,
        geometrySame: row.geometrySame,
      });
    }
    if (page.length < ACCEPTED_TEXT_PAGE_SIZE) break;
    revisionPartCursor = page.at(-1)!.part.id;
  }

  const projectionParts = new Map<number, Array<typeof defaultSchema.parts.$inferSelect>>();
  const projectionBooleans = new Map<
    number,
    { readonly included: unknown; readonly geometrySame: unknown }
  >();
  let projectionCursor: number | null = null;
  while (profileIds.length > 0) {
    const page = db
      .select({
        part: schema.parts,
        included: sql<unknown>`${schema.parts.included}`,
        geometrySame: sql<unknown>`${schema.parts.geometrySame}`,
        textBytes: acceptedPlanStoredTextBytes(input.dependencies.sqlite, [
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
        projectionCursor == null
          ? inArray(schema.parts.profileId, profileIds)
          : and(inArray(schema.parts.profileId, profileIds), gt(schema.parts.id, projectionCursor)),
      )
      .orderBy(asc(schema.parts.id))
      .limit(ACCEPTED_TEXT_PAGE_SIZE)
      .all();
    for (const row of page) {
      captureTextFault({
        faults,
        profileId: row.part.profileId,
        textBytes: row.textBytes,
        code: "projection",
        message: "Accepted Plan projection Part text is corrupt",
      });
      appendGrouped(projectionParts, row.part.profileId, row.part);
      projectionBooleans.set(row.part.id, {
        included: row.included,
        geometrySame: row.geometrySame,
      });
    }
    if (page.length < ACCEPTED_TEXT_PAGE_SIZE) break;
    projectionCursor = page.at(-1)!.part.id;
  }
  const profileIdByProjectionPartId = new Map(
    [...projectionParts.values()]
      .flat()
      .map((part) => [part.id, part.profileId] as const),
  );

  const requiredSets = new Map<
    number,
    typeof defaultSchema.planRevisionRequiredUnitSets.$inferSelect
  >();
  for (let index = 0; index < revisionIds.length; index += ACCEPTED_TEXT_PAGE_SIZE) {
    const page = db
      .select({
        requiredSet: schema.planRevisionRequiredUnitSets,
        textBytes: acceptedPlanStoredTextBytes(input.dependencies.sqlite, [
          schema.planRevisionRequiredUnitSets.tenantId,
          schema.planRevisionRequiredUnitSets.format,
          schema.planRevisionRequiredUnitSets.mappingDigest,
          schema.planRevisionRequiredUnitSets.createdAt,
        ]),
      })
      .from(schema.planRevisionRequiredUnitSets)
      .where(
        inArray(
          schema.planRevisionRequiredUnitSets.revisionId,
          revisionIds.slice(index, index + ACCEPTED_TEXT_PAGE_SIZE),
        ),
      )
      .orderBy(asc(schema.planRevisionRequiredUnitSets.revisionId))
      .all();
    for (const row of page) {
      captureTextFault({
        faults,
        profileId: profileIdByRevisionId.get(row.requiredSet.revisionId),
        textBytes: row.textBytes,
        code: "required_unit_map",
        message: "Accepted Plan Required-unit header text is corrupt",
      });
      requiredSets.set(row.requiredSet.revisionId, row.requiredSet);
    }
  }

  const mappings = new Map<
    number,
    Array<typeof defaultSchema.planRevisionRequiredUnits.$inferSelect>
  >();
  let mappingCursor:
    | { readonly revisionId: number; readonly revisionPartId: number; readonly unitIndex: number; readonly tenantId: string }
    | null = null;
  while (revisionIds.length > 0) {
    const page: Array<{
      readonly mapping: typeof defaultSchema.planRevisionRequiredUnits.$inferSelect;
      readonly textBytes: number;
    }> = db
      .select({
        mapping: schema.planRevisionRequiredUnits,
        textBytes: acceptedPlanStoredTextBytes(input.dependencies.sqlite, [
          schema.planRevisionRequiredUnits.tenantId,
          schema.planRevisionRequiredUnits.requiredUnitToken,
        ]),
      })
      .from(schema.planRevisionRequiredUnits)
      .where(
        mappingCursor == null
          ? inArray(schema.planRevisionRequiredUnits.revisionId, revisionIds)
          : and(
              inArray(schema.planRevisionRequiredUnits.revisionId, revisionIds),
              or(
                gt(schema.planRevisionRequiredUnits.revisionId, mappingCursor.revisionId),
                and(
                  eq(schema.planRevisionRequiredUnits.revisionId, mappingCursor.revisionId),
                  gt(schema.planRevisionRequiredUnits.revisionPartId, mappingCursor.revisionPartId),
                ),
                and(
                  eq(schema.planRevisionRequiredUnits.revisionId, mappingCursor.revisionId),
                  eq(schema.planRevisionRequiredUnits.revisionPartId, mappingCursor.revisionPartId),
                  gt(schema.planRevisionRequiredUnits.unitIndex, mappingCursor.unitIndex),
                ),
                and(
                  eq(schema.planRevisionRequiredUnits.revisionId, mappingCursor.revisionId),
                  eq(schema.planRevisionRequiredUnits.revisionPartId, mappingCursor.revisionPartId),
                  eq(schema.planRevisionRequiredUnits.unitIndex, mappingCursor.unitIndex),
                  gt(schema.planRevisionRequiredUnits.tenantId, mappingCursor.tenantId),
                ),
              ),
            ),
      )
      .orderBy(
        asc(schema.planRevisionRequiredUnits.revisionId),
        asc(schema.planRevisionRequiredUnits.revisionPartId),
        asc(schema.planRevisionRequiredUnits.unitIndex),
        asc(schema.planRevisionRequiredUnits.tenantId),
      )
      .limit(ACCEPTED_TEXT_PAGE_SIZE)
      .all();
    for (const row of page) {
      captureTextFault({
        faults,
        profileId: profileIdByRevisionId.get(row.mapping.revisionId),
        textBytes: row.textBytes,
        code: "required_unit_map",
        message: "Accepted Plan Required-unit mapping text is corrupt",
      });
      appendGrouped(mappings, row.mapping.revisionId, row.mapping);
    }
    if (page.length < ACCEPTED_TEXT_PAGE_SIZE) break;
    const last: typeof defaultSchema.planRevisionRequiredUnits.$inferSelect =
      page.at(-1)!.mapping;
    mappingCursor = {
      revisionId: last.revisionId,
      revisionPartId: last.revisionPartId,
      unitIndex: last.unitIndex,
      tenantId: last.tenantId,
    };
  }

  const tokens = [...new Set([...mappings.values()].flat().map((row) => row.requiredUnitToken))];
  const units = new Map<string, typeof defaultSchema.requiredUnits.$inferSelect>();
  for (let index = 0; index < tokens.length; index += ACCEPTED_TEXT_PAGE_SIZE) {
    const page = db
      .select({
        unit: schema.requiredUnits,
        textBytes: acceptedPlanStoredTextBytes(input.dependencies.sqlite, [
          schema.requiredUnits.token,
          schema.requiredUnits.tenantId,
          schema.requiredUnits.objectName,
          schema.requiredUnits.createdAt,
        ]),
      })
      .from(schema.requiredUnits)
      .where(inArray(schema.requiredUnits.token, tokens.slice(index, index + ACCEPTED_TEXT_PAGE_SIZE)))
      .orderBy(asc(schema.requiredUnits.token))
      .all();
    for (const row of page) {
      captureTextFault({
        faults,
        profileId: row.unit.profileId,
        textBytes: row.textBytes,
        code: "required_unit_map",
        message: "Accepted Plan Required-unit text is corrupt",
      });
      units.set(row.unit.token, row.unit);
    }
  }

  const creationRevisionIds = [...new Set([...units.values()].map((unit) => unit.createdInRevisionId))];
  const creationRevisions = new Map<
    number,
    { readonly id: number; readonly tenantId: string; readonly profileId: number }
  >();
  for (let index = 0; index < creationRevisionIds.length; index += ACCEPTED_TEXT_PAGE_SIZE) {
    const page = db
      .select({
        id: schema.planRevisions.id,
        tenantId: schema.planRevisions.tenantId,
        profileId: schema.planRevisions.profileId,
        textBytes: acceptedPlanStoredTextBytes(input.dependencies.sqlite, [
          schema.planRevisions.tenantId,
        ]),
      })
      .from(schema.planRevisions)
      .where(
        inArray(
          schema.planRevisions.id,
          creationRevisionIds.slice(index, index + ACCEPTED_TEXT_PAGE_SIZE),
        ),
      )
      .orderBy(asc(schema.planRevisions.id))
      .all();
    for (const row of page) {
      captureTextFault({
        faults,
        profileId: row.profileId,
        textBytes: row.textBytes,
        code: "required_unit_map",
        message: "Required-unit creation revision ownership is corrupt",
      });
      creationRevisions.set(row.id, row);
    }
  }

  const createdHere = new Map<number, Array<typeof defaultSchema.requiredUnits.$inferSelect>>();
  let createdCursor: string | null = null;
  while (revisionIds.length > 0) {
    const page = db
      .select({
        unit: schema.requiredUnits,
        textBytes: acceptedPlanStoredTextBytes(input.dependencies.sqlite, [
          schema.requiredUnits.token,
          schema.requiredUnits.tenantId,
          schema.requiredUnits.objectName,
          schema.requiredUnits.createdAt,
        ]),
      })
      .from(schema.requiredUnits)
      .where(
        createdCursor == null
          ? inArray(schema.requiredUnits.createdInRevisionId, revisionIds)
          : and(
              inArray(schema.requiredUnits.createdInRevisionId, revisionIds),
              gt(schema.requiredUnits.token, createdCursor),
            ),
      )
      .orderBy(asc(schema.requiredUnits.token))
      .limit(ACCEPTED_TEXT_PAGE_SIZE)
      .all();
    for (const row of page) {
      captureTextFault({
        faults,
        profileId: profileIdByRevisionId.get(row.unit.createdInRevisionId),
        textBytes: row.textBytes,
        code: "required_unit_map",
        message: "Accepted Plan Required-unit text is corrupt",
      });
      appendGrouped(createdHere, row.unit.createdInRevisionId, row.unit);
    }
    if (page.length < ACCEPTED_TEXT_PAGE_SIZE) break;
    createdCursor = page.at(-1)!.unit.token;
  }

  const projectionIds = [...projectionParts.values()].flat().map((part) => part.id);
  const progress: AcceptedPlanProgressRow[] = [];
  for (let index = 0; index < projectionIds.length; index += MAX_ACCEPTED_PROGRESS_SUMMARY_BATCH) {
    const partIds = projectionIds.slice(index, index + MAX_ACCEPTED_PROGRESS_SUMMARY_BATCH);
    let preflightCursor: number | null = null;
    while (true) {
      const page = db
        .select({
          id: schema.printProgress.id,
          partId: schema.printProgress.partId,
          textBytes: acceptedPlanStoredTextBytes(input.dependencies.sqlite, [
            schema.printProgress.tenantId,
          ]),
        })
        .from(schema.printProgress)
        .where(
          preflightCursor == null
            ? inArray(schema.printProgress.partId, partIds)
            : and(
                inArray(schema.printProgress.partId, partIds),
                gt(schema.printProgress.id, preflightCursor),
              ),
        )
        .orderBy(asc(schema.printProgress.id))
        .limit(ACCEPTED_READ_PAGE_SIZE)
        .all();
      for (const row of page) {
        captureTextFault({
          faults,
          profileId: profileIdByProjectionPartId.get(row.partId),
          textBytes: row.textBytes,
          code: "progress",
          message: "Accepted Plan progress text is corrupt",
        });
      }
      if (page.length < ACCEPTED_READ_PAGE_SIZE) break;
      preflightCursor = page.at(-1)!.id;
    }
    let progressCursor: number | null = null;
    while (true) {
      const page: AcceptedPlanProgressRow[] = db
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
          progressCursor == null
            ? inArray(schema.printProgress.partId, partIds)
            : and(
                inArray(schema.printProgress.partId, partIds),
                gt(schema.printProgress.id, progressCursor),
              ),
        )
        .orderBy(asc(schema.printProgress.id))
        .limit(ACCEPTED_TEXT_PAGE_SIZE)
        .all();
      progress.push(...page);
      if (page.length < ACCEPTED_TEXT_PAGE_SIZE) break;
      progressCursor = page.at(-1)!.id;
    }
  }

  const acceptedInputs = new Map<
    number,
    typeof defaultSchema.planAcceptedInputSets.$inferSelect
  >();
  for (let index = 0; index < profileIds.length; index += ACCEPTED_TEXT_PAGE_SIZE) {
    const page = db
      .select({
        acceptedInput: schema.planAcceptedInputSets,
        textBytes: acceptedPlanStoredTextBytes(input.dependencies.sqlite, [
          schema.planAcceptedInputSets.tenantId,
          schema.planAcceptedInputSets.acceptedAt,
        ]),
      })
      .from(schema.planAcceptedInputSets)
      .where(
        inArray(
          schema.planAcceptedInputSets.profileId,
          profileIds.slice(index, index + ACCEPTED_TEXT_PAGE_SIZE),
        ),
      )
      .orderBy(asc(schema.planAcceptedInputSets.profileId))
      .all();
    for (const row of page) {
      captureTextFault({
        faults,
        profileId: row.acceptedInput.profileId,
        textBytes: row.textBytes,
        code: "accepted_inputs",
        message: "Accepted Plan input pointer text is corrupt",
      });
      acceptedInputs.set(row.acceptedInput.profileId, row.acceptedInput);
    }
  }

  const inputSetIds = [...new Set([...revisions.values()].flatMap((row) => row.inputSetId ?? []))];
  const inputSets = new Map<number, typeof defaultSchema.planRevisionInputSets.$inferSelect>();
  for (let index = 0; index < inputSetIds.length; index += ACCEPTED_TEXT_PAGE_SIZE) {
    const page = db
      .select({
        inputSet: schema.planRevisionInputSets,
        textBytes: acceptedPlanStoredTextBytes(input.dependencies.sqlite, [
          schema.planRevisionInputSets.tenantId,
          schema.planRevisionInputSets.inputSetDigest,
          schema.planRevisionInputSets.recordedAt,
          schema.planRevisionInputSets.publishedAt,
        ]),
      })
      .from(schema.planRevisionInputSets)
      .where(
        inArray(
          schema.planRevisionInputSets.id,
          inputSetIds.slice(index, index + ACCEPTED_TEXT_PAGE_SIZE),
        ),
      )
      .orderBy(asc(schema.planRevisionInputSets.id))
      .all();
    for (const row of page) {
      const owner = [...revisions.values()].find(
        (revision) => revision.inputSetId === row.inputSet.id,
      );
      captureTextFault({
        faults,
        profileId: owner == null ? undefined : profileIdByRevisionId.get(owner.id),
        textBytes: row.textBytes,
        code: "accepted_inputs",
        message: "Accepted Plan input set text is corrupt",
      });
      inputSets.set(row.inputSet.id, row.inputSet);
    }
  }

  return {
    faults,
    revisions,
    parents,
    revisionParts,
    revisionBooleans,
    projectionParts,
    projectionBooleans,
    requiredSets,
    mappings,
    units,
    creationRevisions,
    createdHere,
    progress,
    acceptedInputs,
    inputSets,
  };
}

function readBatchAttempt(
  dependencies: AcceptedPlanProgressSummaryDependencies,
  profileIds: readonly number[],
  loadedProfiles?: ReadonlyMap<
    number,
    { readonly profile: ProfileRow; readonly textBytes: number }
  >,
): ReadonlyMap<number, AcceptedPlanProgressRead> {
  const profiles = loadedProfiles ?? readProfiles(dependencies, profileIds);
  const compatibilityParts = readPresenceByProfile({ dependencies, profileIds, table: "parts" });
  const historicalRevisions = readPresenceByProfile({
    dependencies,
    profileIds,
    table: "revisions",
  });
  const acceptedInputPresence = readAcceptedInputPresenceByProfile(dependencies, profileIds);
  const results = new Map<number, AcceptedPlanProgressRead>();
  const readyProfiles: ProfileRow[] = [];
  for (const profileId of profileIds) {
    try {
      const profile = profiles.get(profileId);
      if (profile?.profile.tenantId === dependencies.tenantId) {
        validateAcceptedPlanStoredTextBytes(
          profile.textBytes,
          "pointer",
          "Accepted Plan Build text is corrupt",
        );
      }
      const pointer = validateAcceptedPlanPointerRows({
        tenantId: dependencies.tenantId,
        profile: profile?.profile,
        hasCompatibilityPart: compatibilityParts.has(profileId),
        hasAcceptedInput: acceptedInputPresence.has(profileId),
        hasHistoricalRevision: historicalRevisions.has(profileId),
      });
      if (pointer.kind === "missing" || pointer.kind === "empty") {
        results.set(profileId, { kind: pointer.kind, profileId });
      } else if (pointer.kind === "compatibility_dirty") {
        results.set(profileId, {
          kind: "unavailable",
          profileId,
          reason: "compatibility_dirty",
        });
      } else {
        readyProfiles.push(pointer.profile);
      }
    } catch (error) {
      if (!(error instanceof AcceptedPlanOperationalIntegrityError)) throw error;
      results.set(profileId, { kind: "integrity_failure", profileId, code: error.code });
    }
  }
  if (readyProfiles.length === 0) return results;

  const rows = loadAcceptedBatchRows({ dependencies, profiles: readyProfiles });
  for (const profile of readyProfiles) {
    try {
      const fault = rows.faults.get(profile.id);
      if (fault) {
        throw new AcceptedPlanOperationalIntegrityError(
          fault,
          "Accepted Plan batch row text is corrupt",
        );
      }
      const revisionId = profile.acceptedPlanRevisionId!;
      const revision = rows.revisions.get(revisionId);
      if (!revision) {
        throw new AcceptedPlanOperationalIntegrityError(
          "revision",
          "Accepted Plan revision is corrupt",
        );
      }
      const revisionParts = rows.revisionParts.get(revisionId) ?? [];
      validateAcceptedPlanRevisionRows({
        tenantId: dependencies.tenantId,
        profileId: profile.id,
        revision,
        parent:
          revision.parentRevisionId == null
            ? null
            : (rows.parents.get(revision.parentRevisionId) ?? null),
        revisionParts,
      });
      const inputKind = validateAcceptedPlanInputHeaderRows({
        tenantId: dependencies.tenantId,
        profileId: profile.id,
        revision,
        acceptedInput: rows.acceptedInputs.get(profile.id),
        inputSet:
          revision.inputSetId == null ? undefined : rows.inputSets.get(revision.inputSetId),
      });
      const parts = validateAcceptedPlanProjectionRows({
        tenantId: dependencies.tenantId,
        revisionParts,
        projectionRows: rows.projectionParts.get(profile.id) ?? [],
        revisionBooleans: rows.revisionBooleans,
        projectionBooleans: rows.projectionBooleans,
      });
      const requiredSet = rows.requiredSets.get(revisionId);
      const mappings = rows.mappings.get(revisionId) ?? [];
      const createdHere = rows.createdHere.get(revisionId) ?? [];
      if (!requiredSet) {
        if (mappings.length > 0 || createdHere.length > 0) {
          throw new AcceptedPlanOperationalIntegrityError(
            "required_unit_map",
            "Accepted Plan Required-unit set is partial",
          );
        }
        results.set(profile.id, {
          kind: "unavailable",
          profileId: profile.id,
          reason: "uninitialized",
        });
        continue;
      }
      const planUnits = mappings.flatMap((mapping) => {
        const unit = rows.units.get(mapping.requiredUnitToken);
        return unit ? [unit] : [];
      });
      const creationRevisionIds = new Set(planUnits.map((unit) => unit.createdInRevisionId));
      validateAcceptedPlanRequiredUnitRows({
        tenantId: dependencies.tenantId,
        profileId: profile.id,
        revisionId,
        requiredSet,
        parts: parts.map((part) => ({
          revisionPartId: part.revisionPart.id,
          included: part.revisionPart.included,
          quantityEffective: part.revisionPart.quantityEffective,
        })),
        mappings,
        units: planUnits,
        creationRevisions: [...creationRevisionIds].flatMap((id) => {
          const creation = rows.creationRevisions.get(id);
          return creation ? [creation] : [];
        }),
        createdHere,
      });
      if (inputKind === "format1") {
        results.set(profile.id, {
          kind: "unavailable",
          profileId: profile.id,
          reason: "uninitialized",
        });
        continue;
      }
      const progress = validateAcceptedPlanProgressRows({
        tenantId: dependencies.tenantId,
        parts: parts.map((part) => ({
          projectionPartId: part.projectionPart.id,
          quantityEffective: part.revisionPart.quantityEffective,
        })),
        rows: rows.progress,
      });
      let totalUnits = 0;
      let remainingUnits = 0;
      for (const part of parts) {
        if (!part.revisionPart.included) continue;
        totalUnits += part.revisionPart.quantityEffective;
        for (let unitIndex = 0; unitIndex < part.revisionPart.quantityEffective; unitIndex += 1) {
          if (!progress.get(`${part.projectionPart.id}:${unitIndex}`)?.completed) {
            remainingUnits += 1;
          }
        }
      }
      results.set(profile.id, { kind: "ready", profileId: profile.id, totalUnits, remainingUnits });
    } catch (error) {
      if (!(error instanceof AcceptedPlanOperationalIntegrityError)) throw error;
      results.set(profile.id, {
        kind: "integrity_failure",
        profileId: profile.id,
        code: error.code,
      });
    }
  }
  return new Map(profileIds.map((profileId) => [profileId, results.get(profileId)!]));
}

function stableResults(input: {
  readonly profileIds: readonly number[];
  readonly before: ReadonlyMap<number, AcceptedTerminalIdentity>;
  readonly after: ReadonlyMap<number, AcceptedTerminalIdentity>;
  readonly reads: ReadonlyMap<number, AcceptedPlanProgressRead>;
}): {
  readonly stable: ReadonlyMap<number, AcceptedPlanProgressRead>;
  readonly changed: readonly number[];
} {
  const stable = new Map<number, AcceptedPlanProgressRead>();
  const changed: number[] = [];
  for (const profileId of input.profileIds) {
    if (terminalIdentityEqual(input.before.get(profileId)!, input.after.get(profileId)!)) {
      stable.set(profileId, input.reads.get(profileId)!);
    } else {
      changed.push(profileId);
    }
  }
  return { stable, changed };
}

function readPostgresBatch(
  dependencies: AcceptedPlanProgressSummaryDependencies,
  profileIds: readonly number[],
): ReadonlyMap<number, AcceptedPlanProgressRead> {
  const before = readTerminalIdentities(dependencies, profileIds);
  const firstReads = readBatchAttempt(
    dependencies,
    profileIds,
    before.profiles,
  );
  const after = readTerminalIdentities(dependencies, profileIds);
  const first = stableResults({
    profileIds,
    before: before.identities,
    after: after.identities,
    reads: firstReads,
  });
  if (first.changed.length === 0) return first.stable;

  const retryBefore = readTerminalIdentities(dependencies, first.changed);
  const retryReads = readBatchAttempt(
    dependencies,
    first.changed,
    retryBefore.profiles,
  );
  const retryAfter = readTerminalIdentities(dependencies, first.changed);
  const results = new Map(first.stable);
  for (const profileId of first.changed) {
    if (
      !terminalIdentityEqual(
        retryBefore.identities.get(profileId)!,
        retryAfter.identities.get(profileId)!,
      )
    ) {
      results.set(profileId, { kind: "concurrent_update", profileId });
    } else {
      results.set(profileId, retryReads.get(profileId)!);
    }
  }
  return new Map(profileIds.map((profileId) => [profileId, results.get(profileId)!]));
}

export function readAcceptedPlanProgressBatch(
  dependencies: AcceptedPlanProgressSummaryDependencies,
  profileIds: readonly number[],
): ReadonlyMap<number, AcceptedPlanProgressRead> {
  const canonical = canonicalProfileIds(profileIds);
  if (canonical.length === 0) return new Map();
  if (!dependencies.sqlite) return readPostgresBatch(dependencies, canonical);
  return dependencies.db.transaction(
    () => {
      const terminal = readTerminalIdentities(dependencies, canonical);
      return readBatchAttempt(
        dependencies,
        canonical,
        terminal.profiles,
      );
    },
    { behavior: "deferred" },
  );
}
