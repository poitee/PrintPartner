import type Database from "better-sqlite3";
import { projectionPlanningFieldsMatch } from "./accepted-plan-operational.js";
import {
  schemaVersionKey,
  SQLITE_PARTS_INVALIDATE_ACCEPTED_REVISION_UPDATE,
} from "./schema.js";

export const ACCEPTED_FILAMENT_ASSIGNMENT_SCHEMA_VERSION = 29;

type DirtyProfile = {
  readonly id: number;
  readonly tenant_id: string;
};

type LivePart = {
  readonly id: number;
  readonly match_key: string;
  readonly relative_path: string;
  readonly filename: string;
  readonly source_layer: string;
  readonly status: string;
  readonly role: string;
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

type RevisionPart = {
  readonly projection_part_id: number | null;
  readonly part_key: string;
  readonly relative_path: string;
  readonly filename: string;
  readonly source_layer: string;
  readonly status: string;
  readonly role_inferred: string;
  readonly role_override: string | null;
  readonly quantity_inferred: number;
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

function storedBoolean(value: number | null): boolean | null {
  if (value === 0) return false;
  if (value === 1) return true;
  return null;
}

function latestRevisionMatchesPlanning(
  sqlite: Database.Database,
  tenantId: string,
  profileId: number,
  revisionId: number,
): boolean {
  const live = sqlite
    .prepare(
      `SELECT id, match_key, relative_path, filename, source_layer, status, role,
              quantity_auto, quantity_override, quantity_effective, included, notes,
              github_blob_url, geometry_same, requirement, option_group_id, manifest_source
         FROM parts
        WHERE tenant_id = ? AND profile_id = ?
        ORDER BY id`,
    )
    .all(tenantId, profileId) as LivePart[];
  const revisionParts = sqlite
    .prepare(
      `SELECT projection_part_id, part_key, relative_path, filename, source_layer, status,
              role_inferred, role_override, quantity_inferred, quantity_override,
              quantity_effective, included, notes, github_blob_url, geometry_same,
              requirement, option_group_id, manifest_source
         FROM plan_revision_parts
        WHERE tenant_id = ? AND revision_id = ?
        ORDER BY id`,
    )
    .all(tenantId, revisionId) as RevisionPart[];
  if (live.length !== revisionParts.length) return false;
  const liveById = new Map(live.map((part) => [part.id, part]));
  const seen = new Set<number>();
  for (const part of revisionParts) {
    if (part.projection_part_id == null || seen.has(part.projection_part_id)) return false;
    seen.add(part.projection_part_id);
    const projection = liveById.get(part.projection_part_id);
    if (
      !projection ||
      !projectionPlanningFieldsMatch(
        {
          matchKey: projection.match_key,
          relativePath: projection.relative_path,
          filename: projection.filename,
          sourceLayer: projection.source_layer,
          status: projection.status,
          role: projection.role,
          quantityAuto: projection.quantity_auto,
          quantityOverride: projection.quantity_override,
          quantityEffective: projection.quantity_effective,
          included: storedBoolean(projection.included) === true,
          notes: projection.notes,
          githubBlobUrl: projection.github_blob_url,
          geometrySame: storedBoolean(projection.geometry_same),
          requirement: projection.requirement,
          optionGroupId: projection.option_group_id,
          manifestSource: projection.manifest_source,
        },
        {
          partKey: part.part_key,
          relativePath: part.relative_path,
          filename: part.filename,
          sourceLayer: part.source_layer,
          status: part.status,
          role: part.role_override ?? part.role_inferred,
          quantityInferred: part.quantity_inferred,
          quantityOverride: part.quantity_override,
          quantityEffective: part.quantity_effective,
          included: storedBoolean(part.included) === true,
          notes: part.notes,
          githubBlobUrl: part.github_blob_url,
          geometrySame: storedBoolean(part.geometry_same),
          requirement: part.requirement,
          optionGroupId: part.option_group_id,
          manifestSource: part.manifest_source,
        },
      )
    ) {
      return false;
    }
  }
  return seen.size === liveById.size;
}

function restoreFilamentOnlyDirtyAcceptedPointers(sqlite: Database.Database): void {
  const dirty = sqlite
    .prepare(
      `SELECT id, tenant_id
         FROM build_profiles
        WHERE accepted_plan_revision_id IS NULL
          AND accepted_plan_version > 0`,
    )
    .all() as DirtyProfile[];
  const latest = sqlite.prepare(
    `SELECT id
       FROM plan_revisions
      WHERE tenant_id = ? AND profile_id = ?
      ORDER BY revision_number DESC, id DESC
      LIMIT 1`,
  );
  const restore = sqlite.prepare(
    `UPDATE build_profiles
        SET accepted_plan_revision_id = ?
      WHERE id = ? AND tenant_id = ? AND accepted_plan_revision_id IS NULL`,
  );
  for (const profile of dirty) {
    const revision = latest.get(profile.tenant_id, profile.id) as { id: number } | undefined;
    if (!revision) continue;
    if (latestRevisionMatchesPlanning(sqlite, profile.tenant_id, profile.id, revision.id)) {
      restore.run(revision.id, profile.id, profile.tenant_id);
    }
  }
}

export function applyAcceptedFilamentAssignmentSchema(sqlite: Database.Database): void {
  const migrate = sqlite.transaction(() => {
    sqlite.exec("DROP TRIGGER IF EXISTS trg_parts_invalidate_accepted_revision_update");
    sqlite.exec(SQLITE_PARTS_INVALIDATE_ACCEPTED_REVISION_UPDATE);
    restoreFilamentOnlyDirtyAcceptedPointers(sqlite);
    sqlite
      .prepare(
        `INSERT INTO app_settings (tenant_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`,
      )
      .run("default", schemaVersionKey, String(ACCEPTED_FILAMENT_ASSIGNMENT_SCHEMA_VERSION));
  });
  migrate.immediate();
}
