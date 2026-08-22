import type Database from "better-sqlite3";
import {
  digestPlanRevisionParts,
  PLAN_REVISION_DIGEST_FORMAT,
} from "../services/plan-publication.js";

export { PLAN_REVISION_DIGEST_FORMAT };
export const ACCEPTED_PLAN_REVISION_SCHEMA_VERSION = 19;

type LegacyProfile = {
  id: number;
  tenant_id: string;
  input_set_id: number | null;
  input_accepted_at: string | null;
};

type LegacyPart = {
  id: number;
  tenant_id: string;
  match_key: string;
  relative_path: string;
  filename: string;
  source_layer: string;
  status: string;
  role: string;
  filament_color_id: string | null;
  filament_custom_hex: string | null;
  spoolman_spool_id: string | null;
  quantity_auto: number;
  quantity_override: number | null;
  quantity_effective: number;
  included: number;
  notes: string;
  github_blob_url: string | null;
  geometry_same: number | null;
  requirement: string | null;
  option_group_id: string | null;
  manifest_source: string | null;
};

function snapshotDigest(parts: readonly LegacyPart[]): string {
  return digestPlanRevisionParts(
    parts.map((part) => ({
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
    })),
  );
}

export function backfillAcceptedPlanRevisions(
  database: Database.Database,
  migratedAt = new Date().toISOString(),
): { revisionsCreated: number; partsCaptured: number } {
  const migrate = database.transaction(() => {
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
        `Cannot backfill Part ${mismatchedPart.id}: tenant does not match owning Build ${mismatchedPart.profile_id}`,
      );
    }
    const mismatchedInput = database
      .prepare(
        `SELECT accepted.profile_id, accepted.input_set_id
           FROM plan_accepted_input_sets accepted
           JOIN build_profiles profile ON profile.id = accepted.profile_id
           JOIN plan_revision_input_sets input_set ON input_set.id = accepted.input_set_id
          WHERE accepted.tenant_id <> profile.tenant_id
             OR input_set.tenant_id <> profile.tenant_id
             OR input_set.profile_id <> profile.id
          LIMIT 1`,
      )
      .get() as { profile_id: number; input_set_id: number } | undefined;
    if (mismatchedInput) {
      throw new Error(
        `Cannot backfill Build ${mismatchedInput.profile_id}: accepted input set ${mismatchedInput.input_set_id} does not belong to it`,
      );
    }
    const profiles = database
      .prepare(
        `SELECT profile.id, profile.tenant_id, accepted.input_set_id,
                accepted.accepted_at AS input_accepted_at
           FROM build_profiles profile
           LEFT JOIN plan_accepted_input_sets accepted
             ON accepted.tenant_id = profile.tenant_id
            AND accepted.profile_id = profile.id
          WHERE profile.accepted_plan_revision_id IS NULL
          ORDER BY profile.tenant_id, profile.id`,
      )
      .all() as LegacyProfile[];
    const selectParts = database.prepare(
      `SELECT id, tenant_id, match_key, relative_path, filename, source_layer,
              status, role, filament_color_id, filament_custom_hex,
              spoolman_spool_id, quantity_auto, quantity_override, included,
              quantity_effective, notes, github_blob_url, geometry_same, requirement,
              option_group_id, manifest_source
         FROM parts
        WHERE tenant_id = ? AND profile_id = ?
        ORDER BY match_key, id`,
    );
    const selectRevisionNumber = database.prepare(
      `SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision_number
         FROM plan_revisions
        WHERE tenant_id = ? AND profile_id = ?`,
    );
    const insertRevision = database.prepare(
      `INSERT INTO plan_revisions (
        tenant_id, profile_id, revision_number, parent_revision_id, input_set_id,
        provenance_kind, digest_format, snapshot_digest, created_by, accepted_by,
        created_at, accepted_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'migration:v19', 'migration:v19', ?, ?)`,
    );
    const insertPart = database.prepare(
      `INSERT INTO plan_revision_parts (
        tenant_id, revision_id, projection_part_id, part_key, relative_path,
        filename, source_layer, status, role_inferred, role_override,
        filament_color_id, filament_custom_hex, spoolman_spool_id,
        quantity_inferred, quantity_override, included, notes, github_blob_url,
        quantity_effective, geometry_same, requirement, option_group_id,
        manifest_source, artifact_digest
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, NULL,
        ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, NULL
      )`,
    );
    const pointProfile = database.prepare(
      `UPDATE build_profiles
          SET accepted_plan_revision_id = ?, accepted_plan_version = 1
        WHERE tenant_id = ? AND id = ?
          AND accepted_plan_revision_id IS NULL
          AND accepted_plan_version = 0`,
    );
    let revisionsCreated = 0;
    let partsCaptured = 0;

    for (const profile of profiles) {
      const parts = selectParts.all(profile.tenant_id, profile.id) as LegacyPart[];
      const revisionNumber = (
        selectRevisionNumber.get(profile.tenant_id, profile.id) as {
          revision_number: number;
        }
      ).revision_number;
      const revision = insertRevision.run(
        profile.tenant_id,
        profile.id,
        revisionNumber,
        profile.input_set_id,
        profile.input_set_id == null ? "legacy" : "tracked",
        PLAN_REVISION_DIGEST_FORMAT,
        snapshotDigest(parts),
        migratedAt,
        profile.input_accepted_at ?? migratedAt,
      );
      const revisionId = Number(revision.lastInsertRowid);

      for (const part of parts) {
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
      const pointed = pointProfile.run(revisionId, profile.tenant_id, profile.id);
      if (pointed.changes !== 1) {
        throw new Error(`Failed to point Build ${profile.id} at accepted Plan revision`);
      }
      revisionsCreated += 1;
      partsCaptured += parts.length;
    }

    return { revisionsCreated, partsCaptured };
  });

  return migrate.immediate();
}
