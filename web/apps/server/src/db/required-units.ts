import type Database from "better-sqlite3";
import {
  digestRequiredUnitMap,
  generateRequiredUnitToken,
  MAX_REQUIRED_UNIT_INDEX,
  parseRequiredUnitToken,
  REQUIRED_UNIT_MAP_FORMAT,
  requiredUnitObjectName,
  validateRequiredUnitObjectName,
  type RequiredUnitDigestRow,
} from "../services/required-units.js";

export const REQUIRED_UNIT_SCHEMA_VERSION = 23;
export const MAX_REQUIRED_UNIT_QUANTITY = MAX_REQUIRED_UNIT_INDEX + 1;

export type RequiredUnitBackfillDependencies = {
  readonly now?: () => string;
  readonly tokenFactory?: () => string;
  readonly maxCollisionAttempts?: number;
};

export type RequiredUnitBackfillResult = {
  readonly setsCreated: number;
  readonly setsReused: number;
  readonly unitsCreated: number;
  readonly buildsSkipped: number;
};

export type RequiredUnitBackfillCommandResult =
  | { readonly kind: "completed"; readonly summary: RequiredUnitBackfillResult }
  | { readonly kind: "transaction_unavailable" };

export type StoredRequiredUnitRow = RequiredUnitDigestRow & {
  readonly tenantId: string;
  readonly profileId: number;
  readonly required: boolean;
  readonly projectionPartId: number | null;
};

type CurrentProfile = {
  readonly id: number;
  readonly tenant_id: string;
  readonly accepted_plan_revision_id: number | null;
  readonly accepted_plan_version: number;
};

type RevisionPart = {
  readonly id: number;
  readonly tenant_id: string;
  readonly filename: string;
  readonly quantity_effective: number;
  readonly included: number;
  readonly projection_part_id: number | null;
};

type StoredSet = {
  readonly revision_id: number;
  readonly tenant_id: string;
  readonly profile_id: number;
  readonly format: string;
  readonly expected_unit_count: number;
  readonly mapping_digest: string;
};

type StoredMapping = {
  readonly tenant_id: string;
  readonly revision_id: number;
  readonly revision_part_id: number;
  readonly unit_index: number;
  readonly required_unit_token: string;
  readonly object_name: string;
};

function revisionParts(
  database: Database.Database,
  tenantId: string,
  revisionId: number,
): RevisionPart[] {
  return database
    .prepare(
      `SELECT id, tenant_id, filename, quantity_effective, included, projection_part_id
         FROM plan_revision_parts
        WHERE tenant_id = ? AND revision_id = ?
        ORDER BY id`,
    )
    .all(tenantId, revisionId) as RevisionPart[];
}

function validateRevisionParts(parts: readonly RevisionPart[]): number {
  let expected = 0;
  for (const part of parts) {
    if (
      !Number.isSafeInteger(part.quantity_effective) ||
      part.quantity_effective < 1 ||
      part.quantity_effective > MAX_REQUIRED_UNIT_QUANTITY
    ) {
      throw new Error(`Accepted Plan revision Part ${part.id} has invalid quantity`);
    }
    expected += part.quantity_effective;
  }
  if (!Number.isSafeInteger(expected)) {
    throw new Error("Accepted Plan revision has an invalid Required-unit count");
  }
  return expected;
}

function storedSet(
  database: Database.Database,
  tenantId: string,
  profileId: number,
  revisionId: number,
): StoredSet | undefined {
  return database
    .prepare(
      `SELECT revision_id, tenant_id, profile_id, format, expected_unit_count, mapping_digest
         FROM plan_revision_required_unit_sets
        WHERE revision_id = ? AND tenant_id = ? AND profile_id = ?`,
    )
    .get(revisionId, tenantId, profileId) as StoredSet | undefined;
}

function storedMappings(
  database: Database.Database,
  tenantId: string,
  revisionId: number,
): StoredMapping[] {
  return database
    .prepare(
      `SELECT mapping.tenant_id, mapping.revision_id, mapping.revision_part_id,
              mapping.unit_index, mapping.required_unit_token, unit.object_name
         FROM plan_revision_required_units mapping
         JOIN required_units unit ON unit.token = mapping.required_unit_token
        WHERE mapping.tenant_id = ? AND mapping.revision_id = ?
        ORDER BY mapping.revision_part_id, mapping.unit_index`,
    )
    .all(tenantId, revisionId) as StoredMapping[];
}

function verifyCompleteSet(input: {
  readonly database: Database.Database;
  readonly tenantId: string;
  readonly profileId: number;
  readonly revisionId: number;
  readonly parts: readonly RevisionPart[];
  readonly set: StoredSet;
}): StoredRequiredUnitRow[] {
  const { database, tenantId, profileId, revisionId, parts, set } = input;
  if (set.format !== REQUIRED_UNIT_MAP_FORMAT) {
    throw new Error(`Required-unit set for revision ${revisionId} has an invalid format`);
  }
  const expected = validateRevisionParts(parts);
  const mappings = storedMappings(database, tenantId, revisionId);
  const orphan = database
    .prepare(
      `SELECT unit.token
         FROM required_units unit
        WHERE unit.tenant_id = ?
          AND unit.profile_id = ?
          AND unit.created_in_revision_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM plan_revision_required_units mapping
             WHERE mapping.tenant_id = unit.tenant_id
               AND mapping.revision_id = ?
               AND mapping.required_unit_token = unit.token
          )
        LIMIT 1`,
    )
    .get(tenantId, profileId, revisionId, revisionId) as { token: string } | undefined;
  if (orphan) {
    throw new Error(`Required unit ${orphan.token} is orphaned from revision ${revisionId}`);
  }
  if (set.expected_unit_count !== expected || mappings.length !== expected) {
    throw new Error(`Required-unit set for revision ${revisionId} is incomplete`);
  }
  const partById = new Map(parts.map((part) => [part.id, part]));
  const nextIndex = new Map<number, number>();
  const rows = mappings.map((mapping): StoredRequiredUnitRow => {
    const part = partById.get(mapping.revision_part_id);
    if (!part || mapping.tenant_id !== tenantId || mapping.revision_id !== revisionId) {
      throw new Error(`Required-unit mapping for revision ${revisionId} has invalid ownership`);
    }
    const expectedIndex = nextIndex.get(part.id) ?? 0;
    if (mapping.unit_index !== expectedIndex || mapping.unit_index >= part.quantity_effective) {
      throw new Error(`Required-unit mapping for Part ${part.id} is incomplete`);
    }
    nextIndex.set(part.id, expectedIndex + 1);
    parseRequiredUnitToken(mapping.required_unit_token);
    validateRequiredUnitObjectName(mapping.object_name, mapping.required_unit_token);
    return {
      tenantId,
      profileId,
      revisionPartId: part.id,
      unitIndex: mapping.unit_index,
      token: mapping.required_unit_token,
      objectName: mapping.object_name,
      required: part.included === 1,
      projectionPartId: part.projection_part_id,
    };
  });
  for (const part of parts) {
    if ((nextIndex.get(part.id) ?? 0) !== part.quantity_effective) {
      throw new Error(`Required-unit mapping for Part ${part.id} is incomplete`);
    }
  }
  const digest = digestRequiredUnitMap({
    revisionId,
    expectedUnitCount: expected,
    rows,
  });
  if (digest !== set.mapping_digest) {
    throw new Error(`Required-unit set for revision ${revisionId} has an invalid digest`);
  }
  return rows;
}

export function backfillCurrentRequiredUnitSets(
  database: Database.Database,
  dependencies: RequiredUnitBackfillDependencies = {},
): RequiredUnitBackfillResult {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const tokenFactory = dependencies.tokenFactory ?? (() => generateRequiredUnitToken());
  const maxCollisionAttempts = dependencies.maxCollisionAttempts ?? 16;
  if (!Number.isSafeInteger(maxCollisionAttempts) || maxCollisionAttempts < 1) {
    throw new Error("Required-unit collision attempt limit is invalid");
  }

  const migrate = database.transaction(() => {
    const profiles = database
      .prepare(
        `SELECT id, tenant_id, accepted_plan_revision_id, accepted_plan_version
           FROM build_profiles
          ORDER BY tenant_id, id`,
      )
      .all() as CurrentProfile[];
    let setsCreated = 0;
    let setsReused = 0;
    let unitsCreated = 0;
    let buildsSkipped = 0;

    for (const profile of profiles) {
      const revisionId = profile.accepted_plan_revision_id;
      if (revisionId == null) {
        buildsSkipped += 1;
        continue;
      }
      if (profile.accepted_plan_version <= 0) {
        throw new Error(`Build ${profile.id} has an invalid accepted Plan version`);
      }
      const ownedRevision = database
        .prepare(
          `SELECT 1 AS found FROM plan_revisions
            WHERE id = ? AND tenant_id = ? AND profile_id = ?`,
        )
        .get(revisionId, profile.tenant_id, profile.id);
      if (!ownedRevision) {
        throw new Error(`Accepted Plan revision ${revisionId} does not belong to Build ${profile.id}`);
      }
      const parts = revisionParts(database, profile.tenant_id, revisionId);
      const expected = validateRevisionParts(parts);
      const existingSet = storedSet(database, profile.tenant_id, profile.id, revisionId);
      if (existingSet) {
        verifyCompleteSet({
          database,
          tenantId: profile.tenant_id,
          profileId: profile.id,
          revisionId,
          parts,
          set: existingSet,
        });
        setsReused += 1;
        continue;
      }
      const partialMapping = database
        .prepare(
          `SELECT 1 AS found FROM plan_revision_required_units
            WHERE tenant_id = ? AND revision_id = ? LIMIT 1`,
        )
        .get(profile.tenant_id, revisionId);
      const orphanUnit = database
        .prepare(
          `SELECT 1 AS found FROM required_units
            WHERE tenant_id = ? AND profile_id = ? AND created_in_revision_id = ? LIMIT 1`,
        )
        .get(profile.tenant_id, profile.id, revisionId);
      if (partialMapping || orphanUnit) {
        throw new Error(`Required-unit set for revision ${revisionId} is partial`);
      }

      const createdAt = now();
      for (const part of parts) {
        for (let unitIndex = 0; unitIndex < part.quantity_effective; unitIndex += 1) {
          let inserted = false;
          for (let attempt = 0; attempt < maxCollisionAttempts; attempt += 1) {
            const token = parseRequiredUnitToken(tokenFactory());
            const objectName = requiredUnitObjectName(part.filename, token);
            const collision = database
              .prepare(
                `SELECT 1 AS found FROM required_units
                  WHERE token = ? OR lower(object_name) = lower(?) LIMIT 1`,
              )
              .get(token, objectName);
            if (collision) continue;
            database
              .prepare(
                `INSERT INTO required_units (
                  token, tenant_id, profile_id, created_in_revision_id, object_name, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)`,
              )
              .run(token, profile.tenant_id, profile.id, revisionId, objectName, createdAt);
            database
              .prepare(
                `INSERT INTO plan_revision_required_units (
                  tenant_id, revision_id, revision_part_id, unit_index, required_unit_token
                ) VALUES (?, ?, ?, ?, ?)`,
              )
              .run(profile.tenant_id, revisionId, part.id, unitIndex, token);
            unitsCreated += 1;
            inserted = true;
            break;
          }
          if (!inserted) {
            throw new Error(`Required-unit collision limit reached for revision Part ${part.id}`);
          }
        }
      }
      const rows = storedMappings(database, profile.tenant_id, revisionId);
      if (rows.length !== expected) {
        throw new Error(`Required-unit set for revision ${revisionId} failed verification`);
      }
      const mappingDigest = digestRequiredUnitMap({
        revisionId,
        expectedUnitCount: expected,
        rows: rows.map((row) => ({
          revisionPartId: row.revision_part_id,
          unitIndex: row.unit_index,
          token: row.required_unit_token,
          objectName: row.object_name,
        })),
      });
      database
        .prepare(
          `INSERT INTO plan_revision_required_unit_sets (
            revision_id, tenant_id, profile_id, format, expected_unit_count,
            mapping_digest, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revisionId,
          profile.tenant_id,
          profile.id,
          REQUIRED_UNIT_MAP_FORMAT,
          expected,
          mappingDigest,
          createdAt,
        );
      const finalized = storedSet(database, profile.tenant_id, profile.id, revisionId);
      if (!finalized) throw new Error(`Required-unit set for revision ${revisionId} was not finalized`);
      verifyCompleteSet({
        database,
        tenantId: profile.tenant_id,
        profileId: profile.id,
        revisionId,
        parts,
        set: finalized,
      });
      setsCreated += 1;
    }
    return { setsCreated, setsReused, unitsCreated, buildsSkipped };
  });
  return migrate.immediate();
}
