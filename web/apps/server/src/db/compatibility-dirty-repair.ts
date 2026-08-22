import type Database from "better-sqlite3";
import {
  digestPlanRevisionParts,
  PLAN_REVISION_DIGEST_FORMAT,
  validateAcceptedOperationalTextRow,
  type PlanRevisionDigestPart,
} from "../services/plan-publication.js";
import {
  digestRequiredUnitMap,
  generateRequiredUnitToken,
  MAX_REQUIRED_UNIT_INDEX,
  parseRequiredUnitToken,
  REQUIRED_UNIT_MAP_FORMAT,
  requiredUnitObjectName,
} from "../services/required-units.js";

export const COMPATIBILITY_DIRTY_REPAIR_SCHEMA_VERSION = 26;

export type CompatibilityDirtyRepairDependencies = {
  readonly now?: () => string;
  readonly tokenFactory?: () => string;
  readonly maxCollisionAttempts?: number;
  readonly beforeBuildRepair?: (profileId: number) => void;
};

export type CompatibilityDirtyRepairResult = {
  readonly buildsRepaired: number;
  readonly revisionsCreated: number;
  readonly partsCaptured: number;
  readonly unitsCreated: number;
};

type DirtyProfile = {
  readonly id: number;
  readonly tenant_id: string;
  readonly name: string;
  readonly order_number: string | null;
  readonly special_request: string | null;
  readonly archived_at: string | null;
  readonly accepted_plan_version: number;
};

type CompatibilityPart = {
  readonly id: number;
  readonly tenant_id: string;
  readonly match_key: string;
  readonly relative_path: string;
  readonly filename: string;
  readonly source_layer: string;
  readonly status: string;
  readonly role: string;
  readonly filament_color_id: string | null;
  readonly filament_custom_hex: string | null;
  readonly spoolman_spool_id: string | null;
  readonly quantity_auto: number;
  readonly quantity_override: number | null;
  readonly quantity_effective: number;
  readonly included: number;
  readonly notes: string;
  readonly github_blob_url: string | null;
  readonly geometry_same: number | null;
  readonly requirement: string | null;
  readonly option_group_id: string | null;
  readonly manifest_source: string | null;
};

type RevisionPart = CompatibilityPart & {
  readonly projection_part_id: number | null;
};

function digestParts(parts: readonly CompatibilityPart[]): string {
  return digestPlanRevisionParts(parts.map(digestPart));
}

function digestPart(part: CompatibilityPart): PlanRevisionDigestPart {
  validateAcceptedOperationalTextRow([
    part.tenant_id,
    part.match_key,
    part.relative_path,
    part.filename,
    part.source_layer,
    part.status,
    part.role,
    part.filament_color_id,
    part.filament_custom_hex,
    part.spoolman_spool_id,
    part.notes,
    part.github_blob_url,
    part.requirement,
    part.option_group_id,
    part.manifest_source,
  ]);
  return {
    partKey: part.match_key,
    relativePath: part.relative_path,
    filename: part.filename,
    sourceLayer: part.source_layer,
    status: part.status,
    roleInferred: part.role,
    roleOverride: null,
    filamentColorId: part.filament_color_id,
    filamentCustomHex: part.filament_custom_hex,
    spoolmanSpoolId: part.spoolman_spool_id,
    quantityInferred: part.quantity_auto,
    quantityOverride: part.quantity_override,
    quantityEffective: part.quantity_effective,
    included: part.included === 1,
    notes: part.notes,
    githubBlobUrl: part.github_blob_url,
    geometrySame: part.geometry_same == null ? null : part.geometry_same === 1,
    requirement: part.requirement,
    optionGroupId: part.option_group_id,
    manifestSource: part.manifest_source,
    artifactDigest: null,
  };
}

function readParts(
  database: Database.Database,
  tenantId: string,
  profileId: number,
): CompatibilityPart[] {
  return database
    .prepare(
      `SELECT id, tenant_id, match_key, relative_path, filename, source_layer,
              status, role, filament_color_id, filament_custom_hex,
              spoolman_spool_id, quantity_auto, quantity_override,
              quantity_effective, included, notes, github_blob_url,
              geometry_same, requirement, option_group_id, manifest_source
         FROM parts
        WHERE tenant_id = ? AND profile_id = ?
        ORDER BY match_key, id`,
    )
    .all(tenantId, profileId) as CompatibilityPart[];
}

function readRevisionParts(
  database: Database.Database,
  tenantId: string,
  revisionId: number,
): RevisionPart[] {
  return database
    .prepare(
      `SELECT projection_part_id AS id, tenant_id, part_key AS match_key, relative_path,
              filename, source_layer, status, role_inferred AS role,
              filament_color_id, filament_custom_hex, spoolman_spool_id,
              quantity_inferred AS quantity_auto, quantity_override,
              quantity_effective, included, notes, github_blob_url,
              geometry_same, requirement, option_group_id, manifest_source,
              projection_part_id
         FROM plan_revision_parts
        WHERE tenant_id = ? AND revision_id = ?
        ORDER BY part_key, projection_part_id`,
    )
    .all(tenantId, revisionId) as RevisionPart[];
}

export function repairCompatibilityDirtyBuilds(
  database: Database.Database,
  dependencies: CompatibilityDirtyRepairDependencies = {},
): CompatibilityDirtyRepairResult {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const tokenFactory = dependencies.tokenFactory ?? (() => generateRequiredUnitToken());
  const maxCollisionAttempts = dependencies.maxCollisionAttempts ?? 16;
  if (!Number.isSafeInteger(maxCollisionAttempts) || maxCollisionAttempts < 1) {
    throw new Error("Required-unit collision attempt limit is invalid");
  }
  const mismatchedPart = database
    .prepare(
      `SELECT part.id, part.profile_id
         FROM parts part
         JOIN build_profiles profile ON profile.id = part.profile_id
        WHERE part.tenant_id <> profile.tenant_id
        LIMIT 1`,
    )
    .get() as { id: number; profile_id: number } | undefined;
  if (mismatchedPart) {
    throw new Error(
      `Cannot repair Part ${mismatchedPart.id}: tenant does not match owning Build ${mismatchedPart.profile_id}`,
    );
  }
  const invalidVersion = database
    .prepare(
      `SELECT id, accepted_plan_version
         FROM build_profiles
        WHERE typeof(accepted_plan_version) <> 'integer'
           OR accepted_plan_version < 0
           OR accepted_plan_version >= ?
        LIMIT 1`,
    )
    .get(Number.MAX_SAFE_INTEGER) as
    | { id: number; accepted_plan_version: number }
    | undefined;
  if (invalidVersion) {
    throw new Error(
      `Build ${invalidVersion.id} has an invalid accepted Plan version ${invalidVersion.accepted_plan_version}`,
    );
  }
  const mismatchedInput = database
    .prepare(
      `SELECT accepted.profile_id, accepted.input_set_id
         FROM plan_accepted_input_sets accepted
         JOIN build_profiles profile ON profile.id = accepted.profile_id
         LEFT JOIN plan_revision_input_sets input_set ON input_set.id = accepted.input_set_id
        WHERE input_set.id IS NULL
           OR accepted.tenant_id <> profile.tenant_id
           OR input_set.tenant_id <> profile.tenant_id
           OR input_set.profile_id <> profile.id
        LIMIT 1`,
    )
    .get() as { profile_id: number; input_set_id: number } | undefined;
  if (mismatchedInput) {
    throw new Error(
      `Cannot repair Build ${mismatchedInput.profile_id}: accepted input set ${mismatchedInput.input_set_id} does not belong to it`,
    );
  }
  const profiles = database
    .prepare(
      `SELECT profile.id, profile.tenant_id, profile.name, profile.order_number,
              profile.special_request, profile.archived_at, profile.accepted_plan_version
         FROM build_profiles profile
        WHERE profile.accepted_plan_revision_id IS NULL
          AND (
            profile.accepted_plan_version > 0
            OR EXISTS (
              SELECT 1 FROM parts part
               WHERE part.tenant_id = profile.tenant_id
                 AND part.profile_id = profile.id
            )
          )
        ORDER BY profile.tenant_id, profile.id`,
    )
    .all() as DirtyProfile[];
  let partsCaptured = 0;
  let unitsCreated = 0;
  let buildsRepaired = 0;
  let revisionsCreated = 0;

  for (const profile of profiles) {
    dependencies.beforeBuildRepair?.(profile.id);
    const repair = database.transaction(() => {
      const current = database
        .prepare(
          `SELECT tenant_id, name, order_number, special_request, archived_at,
                  accepted_plan_revision_id, accepted_plan_version
             FROM build_profiles
            WHERE tenant_id = ? AND id = ?`,
        )
        .get(profile.tenant_id, profile.id) as
        | {
            tenant_id: string;
            name: string;
            order_number: string | null;
            special_request: string | null;
            archived_at: string | null;
            accepted_plan_revision_id: number | null;
            accepted_plan_version: number;
          }
        | undefined;
      if (!current) throw new Error(`Build ${profile.id} disappeared during compatibility repair`);
      if (current.accepted_plan_revision_id != null) {
        return { published: false, parts: 0, units: 0 };
      }
      if (
        !Number.isSafeInteger(current.accepted_plan_version) ||
        current.accepted_plan_version < 0 ||
        current.accepted_plan_version >= Number.MAX_SAFE_INTEGER
      ) {
        throw new Error(`Build ${profile.id} has an invalid accepted Plan version`);
      }
      validateAcceptedOperationalTextRow([
        current.tenant_id,
        current.name,
        current.order_number,
        current.special_request,
        current.archived_at,
      ]);
      const parts = readParts(database, profile.tenant_id, profile.id);
      if (current.accepted_plan_version === 0 && parts.length === 0) {
        return { published: false, parts: 0, units: 0 };
      }
      const parent = database
        .prepare(
          `SELECT id, revision_number
             FROM plan_revisions
            WHERE tenant_id = ? AND profile_id = ?
            ORDER BY revision_number DESC, id DESC
            LIMIT 1`,
        )
        .get(profile.tenant_id, profile.id) as
        | { id: number; revision_number: number }
        | undefined;
      const migratedAt = now();
      validateAcceptedOperationalTextRow([
        profile.tenant_id,
        "legacy",
        PLAN_REVISION_DIGEST_FORMAT,
        digestParts(parts),
        "migration:v26",
        "migration:v26",
        migratedAt,
        migratedAt,
      ]);
      const revision = database
        .prepare(
          `INSERT INTO plan_revisions (
            tenant_id, profile_id, revision_number, parent_revision_id, input_set_id,
            provenance_kind, digest_format, snapshot_digest, created_by, accepted_by,
            created_at, accepted_at
          ) VALUES (?, ?, ?, ?, NULL, 'legacy', ?, ?, 'migration:v26',
                    'migration:v26', ?, ?)`,
        )
        .run(
          profile.tenant_id,
          profile.id,
          (parent?.revision_number ?? 0) + 1,
          parent?.id ?? null,
          PLAN_REVISION_DIGEST_FORMAT,
          digestParts(parts),
          migratedAt,
          migratedAt,
        );
      const revisionId = Number(revision.lastInsertRowid);
      const insertPart = database.prepare(
        `INSERT INTO plan_revision_parts (
          tenant_id, revision_id, projection_part_id, part_key, relative_path,
          filename, source_layer, status, role_inferred, role_override,
          filament_color_id, filament_custom_hex, spoolman_spool_id,
          quantity_inferred, quantity_override, included, notes, github_blob_url,
          quantity_effective, geometry_same, requirement, option_group_id,
          manifest_source, artifact_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      );
      for (const part of parts) {
        if (
          !Number.isSafeInteger(part.quantity_effective) ||
          part.quantity_effective < 1 ||
          part.quantity_effective > MAX_REQUIRED_UNIT_INDEX + 1
        ) {
          throw new Error(`Part ${part.id} has an invalid Required-unit quantity`);
        }
        insertPart.run(
          profile.tenant_id,
          revisionId,
          part.id,
          part.match_key,
          part.relative_path,
          part.filename,
          part.source_layer,
          part.status,
          part.role,
          part.filament_color_id,
          part.filament_custom_hex,
          part.spoolman_spool_id,
          part.quantity_auto,
          part.quantity_override,
          part.included,
          part.notes,
          part.github_blob_url,
          part.quantity_effective,
          part.geometry_same,
          part.requirement,
          part.option_group_id,
          part.manifest_source,
        );
      }
      const captured = readRevisionParts(database, profile.tenant_id, revisionId);
      if (
        captured.length !== parts.length ||
        captured.some((part, index) => part.projection_part_id !== parts[index]?.id) ||
        digestParts(captured) !== digestParts(parts)
      ) {
        throw new Error(`Build ${profile.id} failed compatibility snapshot parity`);
      }
      const revisionPartByProjectionId = new Map(
        (
          database
            .prepare(
              `SELECT id, projection_part_id
                 FROM plan_revision_parts
                WHERE tenant_id = ? AND revision_id = ?`,
            )
            .all(profile.tenant_id, revisionId) as {
            id: number;
            projection_part_id: number;
          }[]
        ).map((part) => [part.projection_part_id, part.id]),
      );
      const mappings: {
        revisionPartId: number;
        unitIndex: number;
        token: string;
        objectName: string;
      }[] = [];
      for (const part of parts) {
        const revisionPartId = revisionPartByProjectionId.get(part.id);
        if (!revisionPartId) throw new Error(`Part ${part.id} failed compatibility projection`);
        for (let unitIndex = 0; unitIndex < part.quantity_effective; unitIndex += 1) {
          let inserted = false;
          for (let attempt = 0; attempt < maxCollisionAttempts; attempt += 1) {
            const token = parseRequiredUnitToken(tokenFactory());
            const objectName = requiredUnitObjectName(part.filename, token);
            validateAcceptedOperationalTextRow([
              token,
              profile.tenant_id,
              objectName,
              migratedAt,
            ]);
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
              .run(token, profile.tenant_id, profile.id, revisionId, objectName, migratedAt);
            database
              .prepare(
                `INSERT INTO plan_revision_required_units (
                  tenant_id, revision_id, revision_part_id, unit_index, required_unit_token
                ) VALUES (?, ?, ?, ?, ?)`,
              )
              .run(profile.tenant_id, revisionId, revisionPartId, unitIndex, token);
            mappings.push({ revisionPartId, unitIndex, token, objectName });
            inserted = true;
            break;
          }
          if (!inserted) {
            throw new Error(`Required-unit collision limit reached for Part ${part.id}`);
          }
        }
      }
      const mappingDigest = digestRequiredUnitMap({
        revisionId,
        expectedUnitCount: mappings.length,
        rows: mappings,
      });
      validateAcceptedOperationalTextRow([
        profile.tenant_id,
        REQUIRED_UNIT_MAP_FORMAT,
        mappingDigest,
        migratedAt,
      ]);
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
          mappings.length,
          mappingDigest,
          migratedAt,
        );
      const stored = database
        .prepare(
          `SELECT mapping.revision_part_id, mapping.unit_index,
                  mapping.required_unit_token, unit.object_name
             FROM plan_revision_required_units mapping
             JOIN required_units unit
               ON unit.token = mapping.required_unit_token
              AND unit.tenant_id = mapping.tenant_id
              AND unit.profile_id = ?
            WHERE mapping.tenant_id = ? AND mapping.revision_id = ?
            ORDER BY mapping.revision_part_id, mapping.unit_index`,
        )
        .all(profile.id, profile.tenant_id, revisionId) as {
        revision_part_id: number;
        unit_index: number;
        required_unit_token: string;
        object_name: string;
      }[];
      const storedDigest = digestRequiredUnitMap({
        revisionId,
        expectedUnitCount: stored.length,
        rows: stored.map((row) => ({
          revisionPartId: row.revision_part_id,
          unitIndex: row.unit_index,
          token: row.required_unit_token,
          objectName: row.object_name,
        })),
      });
      if (stored.length !== mappings.length || storedDigest !== mappingDigest) {
        throw new Error(`Build ${profile.id} failed Required-unit mapping verification`);
      }
      database
        .prepare(
          `DELETE FROM plan_accepted_input_sets
            WHERE tenant_id = ? AND profile_id = ?`,
        )
        .run(profile.tenant_id, profile.id);
      const published = database
        .prepare(
          `UPDATE build_profiles
              SET accepted_plan_revision_id = ?, accepted_plan_version = ?
            WHERE tenant_id = ? AND id = ?
              AND accepted_plan_revision_id IS NULL
              AND accepted_plan_version = ?`,
        )
        .run(
          revisionId,
          current.accepted_plan_version + 1,
          profile.tenant_id,
          profile.id,
          current.accepted_plan_version,
        );
      if (published.changes !== 1) {
        throw new Error(`Build ${profile.id} failed compatibility pointer publication`);
      }
      return { published: true, parts: parts.length, units: mappings.length };
    });
    const repaired = repair.immediate();
    if (repaired.published) {
      buildsRepaired += 1;
      revisionsCreated += 1;
    }
    partsCaptured += repaired.parts;
    unitsCreated += repaired.units;
  }

  return {
    buildsRepaired,
    revisionsCreated,
    partsCaptured,
    unitsCreated,
  };
}
