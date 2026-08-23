import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACCEPTED_PLATE_EDIT_SCHEMA_VERSION } from "./accepted-plate-edit-schema.js";
import { backfillAcceptedPlanRevisions } from "./accepted-plan-revisions.js";
import { getDb, SqliteDatabase } from "./client.js";
import { repairCompatibilityDirtyBuilds } from "./compatibility-dirty-repair.js";
import { AppRepository } from "./repository.js";
import { backfillCurrentRequiredUnitSets } from "./required-units.js";
import {
  AcceptedOperationalRowTextLimitError,
  digestPlanRevisionParts,
  MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES,
} from "../services/plan-publication.js";

const tempDirs: string[] = [];

function createDatabase(): { dir: string; database: SqliteDatabase } {
  const dir = mkdtempSync(join(tmpdir(), "pp-plan-revision-"));
  tempDirs.push(dir);
  const database = new SqliteDatabase(dir);
  database.connect();
  return { dir, database };
}

function rawDatabase(database: SqliteDatabase): Database.Database {
  return (database as unknown as { sqlite: Database.Database }).sqlite;
}

function repository(database: SqliteDatabase, tenantId = "default"): AppRepository {
  return new AppRepository(getDb(database), tenantId, database.reposDir);
}

function utf8Bytes(values: readonly unknown[]): number {
  return values.reduce<number>(
    (total, value) => total + (typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0),
    0,
  );
}

function markAsV18(raw: Database.Database): void {
  raw.prepare(
    `UPDATE app_settings SET value = '18'
      WHERE tenant_id = 'default' AND key = 'schema_version'`,
  ).run();
}

function downgradeToV18(raw: Database.Database): void {
  raw.exec(`
    DROP TRIGGER IF EXISTS trg_accepted_plate_units_immutable_update;
    DROP TRIGGER IF EXISTS trg_accepted_plate_units_ownership_insert;
    DROP TRIGGER IF EXISTS trg_accepted_plates_immutable_update;
    DROP TRIGGER IF EXISTS trg_accepted_plates_ownership_insert;
    DROP TRIGGER IF EXISTS trg_accepted_plate_heads_ownership_update;
    DROP TRIGGER IF EXISTS trg_accepted_plate_heads_ownership_insert;
    DROP TRIGGER IF EXISTS trg_accepted_plate_revisions_immutable_update;
    DROP TRIGGER IF EXISTS trg_accepted_plate_revisions_ownership_insert;
    DROP TABLE accepted_plate_units;
    DROP TABLE accepted_plates;
    DROP TABLE accepted_plate_heads;
    DROP TABLE accepted_plate_revisions;
    DROP TRIGGER IF EXISTS trg_plan_apply_requests_immutable_delete;
    DROP TRIGGER IF EXISTS trg_plan_apply_requests_immutable_update;
    DROP TRIGGER IF EXISTS trg_plan_apply_requests_ownership_insert;
    DROP TRIGGER IF EXISTS trg_plan_drafts_consumption_update;
    DROP TRIGGER IF EXISTS trg_plan_drafts_consumption_insert;
    DROP TABLE plan_apply_requests;
    ALTER TABLE plan_drafts DROP COLUMN consumed_at;
    ALTER TABLE plan_drafts DROP COLUMN consumed_revision_id;
    DROP TRIGGER IF EXISTS trg_plan_drafts_required_unit_selection_update;
    DROP TRIGGER IF EXISTS trg_plan_draft_required_unit_assignments_immutable_delete;
    DROP TRIGGER IF EXISTS trg_plan_draft_required_unit_assignments_immutable_update;
    DROP TRIGGER IF EXISTS trg_plan_draft_required_unit_assignments_ownership_insert;
    DROP TRIGGER IF EXISTS trg_plan_draft_required_unit_decisions_immutable_delete;
    DROP TRIGGER IF EXISTS trg_plan_draft_required_unit_decisions_immutable_update;
    DROP TRIGGER IF EXISTS trg_plan_draft_required_unit_decisions_ownership_insert;
    DROP TRIGGER IF EXISTS trg_plan_draft_required_unit_reconciliations_immutable_delete;
    DROP TRIGGER IF EXISTS trg_plan_draft_required_unit_reconciliations_finalize;
    DROP TRIGGER IF EXISTS trg_plan_draft_required_unit_reconciliations_ownership_insert;
    DROP TABLE plan_draft_required_unit_assignments;
    DROP TABLE plan_draft_required_unit_decisions;
    DROP TABLE plan_draft_required_unit_reconciliations;
    ALTER TABLE plan_drafts DROP COLUMN current_required_unit_reconciliation_id;
    DROP TRIGGER IF EXISTS trg_plan_revision_required_unit_sets_immutable_delete;
    DROP TRIGGER IF EXISTS trg_plan_revision_required_unit_sets_immutable_update;
    DROP TRIGGER IF EXISTS trg_plan_revision_required_unit_sets_ownership_insert;
    DROP TRIGGER IF EXISTS trg_plan_revision_required_units_immutable_delete;
    DROP TRIGGER IF EXISTS trg_plan_revision_required_units_immutable_update;
    DROP TRIGGER IF EXISTS trg_plan_revision_required_units_ownership_insert;
    DROP TRIGGER IF EXISTS trg_required_units_immutable_delete;
    DROP TRIGGER IF EXISTS trg_required_units_immutable_update;
    DROP TRIGGER IF EXISTS trg_required_units_ownership_insert;
    DROP TABLE plan_revision_required_unit_sets;
    DROP TABLE plan_revision_required_units;
    DROP TABLE required_units;
    DROP TRIGGER IF EXISTS trg_plan_revisions_ownership_insert;
    DROP TRIGGER IF EXISTS trg_plan_revision_parts_ownership_insert;
    DROP TRIGGER IF EXISTS trg_build_profiles_revision_ownership_insert;
    DROP TRIGGER IF EXISTS trg_build_profiles_revision_ownership_update;
    DROP TRIGGER IF EXISTS trg_plan_revisions_immutable_update;
    DROP TRIGGER IF EXISTS trg_plan_revisions_immutable_delete;
    DROP TRIGGER IF EXISTS trg_plan_revision_parts_immutable_update;
    DROP TRIGGER IF EXISTS trg_plan_revision_parts_immutable_delete;
    DROP TRIGGER IF EXISTS trg_parts_invalidate_accepted_revision_insert;
    DROP TRIGGER IF EXISTS trg_parts_invalidate_accepted_revision_update;
    DROP TRIGGER IF EXISTS trg_parts_invalidate_accepted_revision_delete;
    DROP TRIGGER IF EXISTS trg_profile_layers_invalidate_accepted_revision_insert;
    DROP TRIGGER IF EXISTS trg_profile_layers_invalidate_accepted_revision_update;
    DROP TRIGGER IF EXISTS trg_profile_layers_invalidate_accepted_revision_delete;
    ALTER TABLE build_profiles DROP COLUMN accepted_plan_revision_id;
    ALTER TABLE build_profiles DROP COLUMN accepted_plan_version;
    DROP TABLE plan_revision_parts;
    DROP TABLE plan_revisions;
  `);
  markAsV18(raw);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("accepted Plan revision backfill", () => {
  it("does not manufacture a revision for a Build created on schema v19", () => {
    const { dir, database } = createDatabase();
    const profile = repository(database).createProfile("New empty Build");
    database.close();

    const reopened = new SqliteDatabase(dir);
    reopened.connect();
    expect(repository(reopened).getAcceptedPlanRevision(profile.id)).toBeNull();
    expect(
      rawDatabase(reopened)
        .prepare(
          `SELECT accepted_plan_revision_id, accepted_plan_version
             FROM build_profiles WHERE id = ?`,
        )
        .get(profile.id),
    ).toEqual({ accepted_plan_revision_id: null, accepted_plan_version: 0 });
    reopened.close();
  });

  it("fails closed on a corrupt recorded schema version", () => {
    const { dir, database } = createDatabase();
    rawDatabase(database)
      .prepare(
        `UPDATE app_settings SET value = 'not-a-version'
          WHERE tenant_id = 'default' AND key = 'schema_version'`,
      )
      .run();
    database.close();

    const reopened = new SqliteDatabase(dir);
    expect(() => reopened.connect()).toThrow(/invalid database schema version/i);
    reopened.close();
  });

  it("repairs a recorded v30 accepted Plate unit table that is missing edit columns", () => {
    const { dir, database } = createDatabase();
    const raw = rawDatabase(database);
    raw.exec(`
      DROP TABLE accepted_plate_units;
      CREATE TABLE accepted_plate_units (
        tenant_id TEXT NOT NULL,
        revision_id INTEGER NOT NULL REFERENCES accepted_plate_revisions(id) ON DELETE CASCADE,
        plate_id TEXT NOT NULL,
        required_unit_token TEXT NOT NULL REFERENCES required_units(token) ON DELETE CASCADE,
        x_um INTEGER NOT NULL CHECK (x_um BETWEEN 0 AND 2147483647),
        y_um INTEGER NOT NULL CHECK (y_um BETWEEN 0 AND 2147483647),
        width_um INTEGER NOT NULL CHECK (width_um BETWEEN 1 AND 2147483647),
        depth_um INTEGER NOT NULL CHECK (depth_um BETWEEN 1 AND 2147483647),
        height_um INTEGER NOT NULL CHECK (height_um BETWEEN 1 AND 2147483647),
        placement TEXT NOT NULL DEFAULT 'auto' CHECK (placement IN ('auto', 'manual', 'unplaced')),
        CONSTRAINT pk_accepted_plate_units
          PRIMARY KEY (tenant_id, revision_id, required_unit_token)
      );
      UPDATE app_settings SET value = '30'
       WHERE tenant_id = 'default' AND key = 'schema_version';
    `);
    database.close();

    const migrated = new SqliteDatabase(dir);
    migrated.connect();
    const migratedRaw = rawDatabase(migrated);
    const columns = migratedRaw.pragma("table_info(accepted_plate_units)") as { name: string }[];

    expect(columns.map((column) => column.name)).toContain("pinned");
    expect(
      migratedRaw
        .prepare("SELECT value FROM app_settings WHERE tenant_id = 'default' AND key = 'schema_version'")
        .get(),
    ).toEqual({ value: String(ACCEPTED_PLATE_EDIT_SCHEMA_VERSION) });
    migrated.close();
  });

  it("upgrades a populated v18-shaped Build", () => {
    const { dir, database } = createDatabase();
    const raw = rawDatabase(database);
    const profile = repository(database).createProfile("Existing v18 Build");
    raw.prepare(
      `INSERT INTO parts (
        tenant_id, profile_id, match_key, relative_path, filename, source_layer,
        status, role, quantity_auto, quantity_effective, included, notes
      ) VALUES ('default', ?, 'legacy', '', 'legacy.stl', '', 'base', 'primary', 1, 1, 1, '')`,
    ).run(profile.id);
    downgradeToV18(raw);
    database.close();

    const migrated = new SqliteDatabase(dir, {
      now: () => "2026-08-20T12:00:00.000Z",
      tokenFactory: () => "ppu_00000000000000000000000000000001",
    });
    expect(() => migrated.connect()).not.toThrow();
    expect(repository(migrated).getAcceptedPlanRevision(profile.id)).toMatchObject({
      planVersion: 1,
      revisionNumber: 1,
      parts: [expect.objectContaining({ partKey: "legacy" })],
    });
    expect(repository(migrated).readCurrentRequiredUnitSet(profile.id)).toMatchObject({
      kind: "ready",
      units: [
        expect.objectContaining({
          unitIndex: 0,
          required: true,
          token: "ppu_00000000000000000000000000000001",
        }),
      ],
    });
    migrated.close();
  });

  it("captures a tracked populated Build without changing live state", () => {
    const { dir, database } = createDatabase();
    const raw = rawDatabase(database);
    const profile = repository(database).createProfile("Tracked Trident");
    const part = raw
      .prepare(
        `INSERT INTO parts (
          tenant_id, profile_id, match_key, relative_path, filename, source_layer,
          status, role, filament_color_id, filament_custom_hex, spoolman_spool_id,
          quantity_auto, quantity_override, quantity_effective, included, notes,
          github_blob_url, geometry_same, requirement, option_group_id, manifest_source
        ) VALUES (
          'default', ?, 'gantry/clip', 'STLs/Gantry', 'clip.stl', 'voron',
          'modified', 'accent', 'orange', '#ff5500', '42',
          2, 3, 4, 1, 'print three',
          'https://example.test/clip.stl', 1, 'required', 'gantry', 'manifest.json'
        )`,
      )
      .run(profile.id);
    raw.prepare(
      `INSERT INTO print_progress (tenant_id, part_id, unit_index, completed, assembled)
       VALUES ('default', ?, 0, 1, 1)`,
    ).run(Number(part.lastInsertRowid));
    raw.prepare(
      `INSERT INTO app_settings (tenant_id, key, value)
       VALUES ('default', 'test_setting', 'preserve-me')`,
    ).run();
    const inputSet = raw
      .prepare(
        `INSERT INTO plan_revision_input_sets (
          tenant_id, profile_id, input_set_digest, expected_input_count,
          format_version, recorded_at, published_at
        ) VALUES ('default', ?, ?, 0, 2, ?, ?)`,
      )
      .run(
        profile.id,
        "a".repeat(64),
        "2026-08-20T10:00:00.000Z",
        "2026-08-20T10:00:00.000Z",
      );
    raw.prepare(
      `INSERT INTO plan_accepted_input_sets (tenant_id, profile_id, input_set_id, accepted_at)
       VALUES ('default', ?, ?, ?)`,
    ).run(profile.id, Number(inputSet.lastInsertRowid), "2026-08-20T10:00:00.000Z");

    const partsBefore = raw.prepare("SELECT * FROM parts ORDER BY id").all();
    const partRowsBefore = repository(database).listParts(profile.id).parts;
    const progressBefore = raw.prepare("SELECT * FROM print_progress ORDER BY id").all();
    const settingBefore = raw
      .prepare("SELECT * FROM app_settings WHERE key = 'test_setting'")
      .all();
    downgradeToV18(raw);
    database.close();

    const migrated = new SqliteDatabase(dir);
    migrated.connect();
    const accepted = repository(migrated).getAcceptedPlanRevision(profile.id);
    const migratedRaw = rawDatabase(migrated);

    expect(accepted).toMatchObject({
      profileId: profile.id,
      planVersion: 1,
      revisionNumber: 1,
      parentRevisionId: null,
      inputSetId: Number(inputSet.lastInsertRowid),
      provenanceKind: "tracked",
      digestFormat: "plan-revision-parts-v1",
      acceptedAt: "2026-08-20T10:00:00.000Z",
    });
    expect(accepted?.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(repository(migrated).getAcceptedPlanPartRows(profile.id)).toEqual(partRowsBefore);
    expect(accepted?.parts).toEqual([
      expect.objectContaining({
        projectionPartId: Number(part.lastInsertRowid),
        partKey: "gantry/clip",
        relativePath: "STLs/Gantry",
        filename: "clip.stl",
        sourceLayer: "voron",
        status: "modified",
        roleInferred: "accent",
        roleOverride: null,
        effectiveRole: "accent",
        filamentColorId: "orange",
        filamentCustomHex: "#ff5500",
        spoolmanSpoolId: "42",
        quantityInferred: 2,
        quantityOverride: 3,
        effectiveQuantity: 4,
        included: true,
        notes: "print three",
        githubBlobUrl: "https://example.test/clip.stl",
        geometrySame: true,
        requirement: "required",
        optionGroupId: "gantry",
        manifestSource: "manifest.json",
        artifactDigest: null,
      }),
    ]);
    expect(migratedRaw.prepare("SELECT * FROM parts ORDER BY id").all()).toEqual(partsBefore);
    expect(migratedRaw.prepare("SELECT * FROM print_progress ORDER BY id").all()).toEqual(
      progressBefore,
    );
    expect(
      migratedRaw.prepare("SELECT * FROM app_settings WHERE key = 'test_setting'").all(),
    ).toEqual(settingBefore);
    expect(() =>
      migratedRaw.prepare("DELETE FROM plan_revisions WHERE id = ?").run(accepted?.id),
    ).toThrow(/immutable/i);
    migrated.close();
  });

  it("returns accepted PartRows in the existing filename order", () => {
    const { dir, database } = createDatabase();
    const raw = rawDatabase(database);
    const profile = repository(database).createProfile("PartRow order");
    const insert = raw.prepare(
      `INSERT INTO parts (
        tenant_id, profile_id, match_key, relative_path, filename, source_layer,
        status, role, quantity_auto, quantity_effective, included, notes
      ) VALUES ('default', ?, ?, '', ?, '', 'base', 'primary', 1, 1, 1, '')`,
    );
    insert.run(profile.id, "z-path", "a-file.stl");
    insert.run(profile.id, "a-path", "z-file.stl");
    const livePartRows = repository(database).listParts(profile.id).parts;
    downgradeToV18(raw);
    database.close();

    const migrated = new SqliteDatabase(dir);
    migrated.connect();
    expect(repository(migrated).getAcceptedPlanPartRows(profile.id)).toEqual(livePartRows);
    migrated.close();
  });

  it("backfills empty legacy Builds once and keeps reads tenant-scoped", () => {
    const { dir, database } = createDatabase();
    const defaultProfile = repository(database).createProfile("Default empty");
    const tenantProfile = repository(database, "farm-b").createProfile("Farm B empty");
    downgradeToV18(rawDatabase(database));
    database.close();

    const first = new SqliteDatabase(dir);
    first.connect();
    const defaultAccepted = repository(first).getAcceptedPlanRevision(defaultProfile.id);
    const tenantAccepted = repository(first, "farm-b").getAcceptedPlanRevision(tenantProfile.id);
    const raw = rawDatabase(first);
    const firstRows = raw
      .prepare("SELECT * FROM plan_revisions ORDER BY tenant_id, profile_id, revision_number")
      .all();

    expect(defaultAccepted).toMatchObject({
      profileId: defaultProfile.id,
      planVersion: 1,
      provenanceKind: "legacy",
      inputSetId: null,
      parts: [],
    });
    expect(tenantAccepted).toMatchObject({
      profileId: tenantProfile.id,
      planVersion: 1,
      provenanceKind: "legacy",
      inputSetId: null,
      parts: [],
    });
    expect(repository(first).getAcceptedPlanRevision(tenantProfile.id)).toBeNull();
    first.close();

    const second = new SqliteDatabase(dir);
    second.connect();
    expect(
      rawDatabase(second)
        .prepare("SELECT * FROM plan_revisions ORDER BY tenant_id, profile_id, revision_number")
        .all(),
    ).toEqual(firstRows);
    second.close();
  });

  it("keeps Build deletion available after the accepted pointer is populated", () => {
    const { dir, database } = createDatabase();
    const profile = repository(database).createProfile("Disposable");
    downgradeToV18(rawDatabase(database));
    database.close();

    const migrated = new SqliteDatabase(dir);
    migrated.connect();
    const repo = repository(migrated);
    expect(repo.getAcceptedPlanRevision(profile.id)).not.toBeNull();
    expect(() => repo.deleteProfile(profile.id)).not.toThrow();
    expect(repo.getProfileHeader(profile.id)).toBeNull();
    expect(
      rawDatabase(migrated)
        .prepare("SELECT count(*) AS count FROM plan_revisions WHERE profile_id = ?")
        .get(profile.id),
    ).toEqual({ count: 0 });
    migrated.close();
  });

  it("digests duplicate legacy keys independently of row identity and insertion order", () => {
    const { dir, database } = createDatabase();
    const raw = rawDatabase(database);
    const firstProfile = repository(database).createProfile("First order");
    const secondProfile = repository(database).createProfile("Second order");
    const insert = raw.prepare(
      `INSERT INTO parts (
        tenant_id, profile_id, match_key, relative_path, filename, source_layer,
        status, role, quantity_auto, quantity_effective, included, notes
      ) VALUES ('default', ?, 'duplicate', '', ?, '', 'base', 'primary', 1, 1, 1, '')`,
    );
    insert.run(firstProfile.id, "a.stl");
    insert.run(firstProfile.id, "b.stl");
    insert.run(secondProfile.id, "b.stl");
    insert.run(secondProfile.id, "a.stl");
    downgradeToV18(raw);
    database.close();

    const migrated = new SqliteDatabase(dir);
    migrated.connect();
    const repo = repository(migrated);
    expect(repo.getAcceptedPlanRevision(firstProfile.id)?.snapshotDigest).toBe(
      repo.getAcceptedPlanRevision(secondProfile.id)?.snapshotDigest,
    );
    expect(repo.getAcceptedPlanRevision(firstProfile.id)?.parts).toHaveLength(2);
    expect(repo.getAcceptedPlanRevision(secondProfile.id)?.parts).toHaveLength(2);
    migrated.close();
  });

  it("rolls back the complete Build when a snapshot row cannot be written", () => {
    const { database } = createDatabase();
    const raw = rawDatabase(database);
    const profile = repository(database).createProfile("Rollback");
    raw.prepare(
      `INSERT INTO parts (
        tenant_id, profile_id, match_key, relative_path, filename, source_layer,
        status, role, quantity_auto, quantity_effective, included, notes
      ) VALUES ('default', ?, 'bad', '', 'bad.stl', '', 'base', 'primary', 1, 1, 1, '')`,
    ).run(profile.id);
    raw.exec(
      `CREATE TRIGGER reject_revision_part
       BEFORE INSERT ON plan_revision_parts
       BEGIN
         SELECT RAISE(ABORT, 'injected revision part failure');
       END`,
    );

    expect(() =>
      backfillAcceptedPlanRevisions(raw, "2026-08-20T12:00:00.000Z"),
    ).toThrow(/injected revision part failure/i);
    expect(
      raw.prepare("SELECT count(*) AS count FROM plan_revisions WHERE profile_id = ?").get(
        profile.id,
      ),
    ).toEqual({ count: 0 });
    expect(
      raw
        .prepare(
          `SELECT accepted_plan_revision_id, accepted_plan_version
             FROM build_profiles WHERE id = ?`,
        )
        .get(profile.id),
    ).toEqual({ accepted_plan_revision_id: null, accepted_plan_version: 0 });
    database.close();
  });

  it("fails instead of omitting a legacy Part with a mismatched tenant", () => {
    const { dir, database } = createDatabase();
    const raw = rawDatabase(database);
    const profile = repository(database).createProfile("Mismatched Part");
    raw.prepare(
      `INSERT INTO parts (
        tenant_id, profile_id, match_key, relative_path, filename, source_layer,
        status, role, quantity_auto, quantity_effective, included, notes
      ) VALUES ('farm-b', ?, 'visible-before', '', 'visible.stl', '', 'base', 'primary', 1, 1, 1, '')`,
    ).run(profile.id);
    expect(repository(database).listParts(profile.id).parts).toEqual([
      expect.objectContaining({ match_key: "visible-before" }),
    ]);
    downgradeToV18(raw);
    database.close();

    const migrated = new SqliteDatabase(dir);
    expect(() => migrated.connect()).toThrow(/tenant does not match owning Build/i);
    migrated.close();
  });

  it("rejects accepted input provenance owned by another Build", () => {
    const { dir, database } = createDatabase();
    const raw = rawDatabase(database);
    const firstProfile = repository(database).createProfile("Wrong provenance");
    const secondProfile = repository(database).createProfile("Input owner");
    const inputSet = raw
      .prepare(
        `INSERT INTO plan_revision_input_sets (
          tenant_id, profile_id, input_set_digest, expected_input_count,
          format_version, recorded_at, published_at
        ) VALUES ('default', ?, ?, 0, 2, ?, ?)`,
      )
      .run(
        secondProfile.id,
        "c".repeat(64),
        "2026-08-20T14:00:00.000Z",
        "2026-08-20T14:00:00.000Z",
      );
    raw.prepare(
      `INSERT INTO plan_accepted_input_sets (tenant_id, profile_id, input_set_id, accepted_at)
       VALUES ('default', ?, ?, ?)`,
    ).run(
      firstProfile.id,
      Number(inputSet.lastInsertRowid),
      "2026-08-20T14:00:00.000Z",
    );
    downgradeToV18(raw);
    database.close();

    const migrated = new SqliteDatabase(dir);
    expect(() => migrated.connect()).toThrow(/accepted input set .* does not belong/i);
    migrated.close();
  });

  it("rejects cross-owner accepted revision relationships", () => {
    const { dir, database } = createDatabase();
    const initialRaw = rawDatabase(database);
    const firstProfile = repository(database).createProfile("First owner");
    const secondProfile = repository(database).createProfile("Second owner");
    initialRaw.prepare(
      `INSERT INTO parts (
        tenant_id, profile_id, match_key, relative_path, filename, source_layer,
        status, role, quantity_auto, quantity_effective, included, notes
      ) VALUES ('default', ?, 'second-part', '', 'second.stl', '', 'base', 'primary', 1, 1, 1, '')`,
    ).run(secondProfile.id);
    downgradeToV18(initialRaw);
    database.close();

    const migrated = new SqliteDatabase(dir);
    migrated.connect();
    const raw = rawDatabase(migrated);
    const first = repository(migrated).getAcceptedPlanRevision(firstProfile.id)!;
    const second = repository(migrated).getAcceptedPlanRevision(secondProfile.id)!;
    const secondInput = raw
      .prepare(
        `INSERT INTO plan_revision_input_sets (
          tenant_id, profile_id, input_set_digest, expected_input_count,
          format_version, recorded_at, published_at
        ) VALUES ('default', ?, ?, 0, 2, ?, ?)`,
      )
      .run(
        secondProfile.id,
        "b".repeat(64),
        "2026-08-20T13:00:00.000Z",
        "2026-08-20T13:00:00.000Z",
      );

    expect(() =>
      raw
        .prepare("UPDATE build_profiles SET accepted_plan_revision_id = ? WHERE id = ?")
        .run(second.id, firstProfile.id),
    ).toThrow(/ownership/i);
    expect(() =>
      raw
        .prepare(
          `INSERT INTO plan_revisions (
            tenant_id, profile_id, revision_number, parent_revision_id, input_set_id,
            provenance_kind, digest_format, snapshot_digest, created_by, accepted_by,
            created_at, accepted_at
          ) VALUES ('default', ?, 2, ?, NULL, 'legacy', ?, ?, 'test', 'test', ?, ?)`,
        )
        .run(
          firstProfile.id,
          second.id,
          first.digestFormat,
          first.snapshotDigest,
          first.createdAt,
          first.acceptedAt,
        ),
    ).toThrow(/ownership/i);
    expect(() =>
      raw
        .prepare(
          `INSERT INTO plan_revisions (
            tenant_id, profile_id, revision_number, parent_revision_id, input_set_id,
            provenance_kind, digest_format, snapshot_digest, created_by, accepted_by,
            created_at, accepted_at
          ) VALUES ('default', ?, 2, NULL, ?, 'tracked', ?, ?, 'test', 'test', ?, ?)`,
        )
        .run(
          firstProfile.id,
          Number(secondInput.lastInsertRowid),
          first.digestFormat,
          first.snapshotDigest,
          first.createdAt,
          first.acceptedAt,
        ),
    ).toThrow(/ownership/i);
    expect(() =>
      raw
        .prepare(
          `INSERT INTO plan_revision_parts (
            tenant_id, revision_id, part_key, quantity_inferred,
            quantity_effective, included
          ) VALUES ('farm-b', ?, 'cross-tenant', 1, 1, 1)`,
        )
        .run(first.id),
    ).toThrow(/ownership/i);
    expect(() =>
      raw
        .prepare(
          `INSERT INTO plan_revision_parts (
            tenant_id, revision_id, projection_part_id, part_key,
            quantity_inferred, quantity_effective, included
          ) VALUES ('default', ?, ?, 'cross-build', 1, 1, 1)`,
        )
        .run(first.id, second.parts[0]!.projectionPartId),
    ).toThrow(/ownership/i);
    migrated.close();
  });

  it("rejects contradictory tracked and legacy provenance", () => {
    const { database } = createDatabase();
    const raw = rawDatabase(database);
    const profile = repository(database).createProfile("Provenance checks");
    const inputSet = raw
      .prepare(
        `INSERT INTO plan_revision_input_sets (
          tenant_id, profile_id, input_set_digest, expected_input_count,
          format_version, recorded_at, published_at
        ) VALUES ('default', ?, ?, 0, 2, ?, ?)`,
      )
      .run(
        profile.id,
        "d".repeat(64),
        "2026-08-20T15:00:00.000Z",
        "2026-08-20T15:00:00.000Z",
      );
    const insertRevision = raw.prepare(
      `INSERT INTO plan_revisions (
        tenant_id, profile_id, revision_number, parent_revision_id, input_set_id,
        provenance_kind, digest_format, snapshot_digest, created_by, accepted_by,
        created_at, accepted_at
      ) VALUES ('default', ?, 1, NULL, ?, ?, 'plan-revision-parts-v1', ?, 'test', 'test', ?, ?)`,
    );

    expect(() =>
      insertRevision.run(
        profile.id,
        null,
        "tracked",
        "e".repeat(64),
        "2026-08-20T15:00:00.000Z",
        "2026-08-20T15:00:00.000Z",
      ),
    ).toThrow(/check constraint/i);
    expect(() =>
      insertRevision.run(
        profile.id,
        Number(inputSet.lastInsertRowid),
        "legacy",
        "e".repeat(64),
        "2026-08-20T15:00:00.000Z",
        "2026-08-20T15:00:00.000Z",
      ),
    ).toThrow(/check constraint/i);
    database.close();
  });

  it("rejects accepted snapshot mutation while its Build exists", () => {
    const { dir, database } = createDatabase();
    const raw = rawDatabase(database);
    const profile = repository(database).createProfile("Immutable");
    raw.prepare(
      `INSERT INTO parts (
        tenant_id, profile_id, match_key, relative_path, filename, source_layer,
        status, role, quantity_auto, quantity_effective, included, notes
      ) VALUES ('default', ?, 'fixed', '', 'fixed.stl', '', 'base', 'primary', 1, 1, 1, '')`,
    ).run(profile.id);
    downgradeToV18(raw);
    database.close();

    const migrated = new SqliteDatabase(dir);
    migrated.connect();
    const migratedRaw = rawDatabase(migrated);
    const accepted = repository(migrated).getAcceptedPlanRevision(profile.id)!;
    expect(() =>
      migratedRaw
        .prepare("UPDATE plan_revisions SET snapshot_digest = ? WHERE id = ?")
        .run("f".repeat(64), accepted.id),
    ).toThrow(/immutable/i);
    expect(() =>
      migratedRaw
        .prepare("UPDATE plan_revision_parts SET filename = 'changed.stl' WHERE revision_id = ?")
        .run(accepted.id),
    ).toThrow(/immutable/i);
    expect(() =>
      migratedRaw.prepare("DELETE FROM plan_revision_parts WHERE revision_id = ?").run(accepted.id),
    ).toThrow(/immutable/i);
    migrated.close();
  });

  it("keeps accepted Source selection separate from compatibility Part dirtiness", () => {
    const { dir, database } = createDatabase();
    const raw = rawDatabase(database);
    const partProfile = repository(database).createProfile("Mutable Part projection");
    const layerProfile = repository(database).createProfile("Mutable layer projection");
    raw.prepare(
      `INSERT INTO parts (
        tenant_id, profile_id, match_key, relative_path, filename, source_layer,
        status, role, quantity_auto, quantity_effective, included, notes
      ) VALUES ('default', ?, 'mutable', '', 'mutable.stl', '', 'base', 'primary', 1, 1, 1, '')`,
    ).run(partProfile.id);
    downgradeToV18(raw);
    database.close();

    const migrated = new SqliteDatabase(dir);
    migrated.connect();
    const repo = repository(migrated);
    const partRevision = repo.getAcceptedPlanRevision(partProfile.id)!;
    const layerRevision = repo.getAcceptedPlanRevision(layerProfile.id)!;
    rawDatabase(migrated)
      .prepare("UPDATE parts SET notes = 'compatibility-dirty' WHERE id = ?")
      .run(partRevision.parts[0]!.projectionPartId!);
    rawDatabase(migrated)
      .prepare(
        `INSERT INTO profile_layers (tenant_id, profile_id, layer_order, layer_type, project_id)
         VALUES ('default', ?, 0, 'base', NULL)`,
      )
      .run(layerProfile.id);

    expect(repo.getAcceptedPlanRevision(partProfile.id)).toBeNull();
    expect(repo.getAcceptedPlanRevision(layerProfile.id)?.id).toBe(layerRevision.id);
    expect(
      rawDatabase(migrated)
        .prepare(
          `SELECT id, accepted_plan_version
             FROM build_profiles
            WHERE id IN (?, ?)
            ORDER BY id`,
        )
        .all(partProfile.id, layerProfile.id),
    ).toEqual([
      { id: partProfile.id, accepted_plan_version: 1 },
      { id: layerProfile.id, accepted_plan_version: 1 },
    ]);
    expect(
      rawDatabase(migrated)
        .prepare("SELECT count(*) AS count FROM plan_revisions WHERE id IN (?, ?)")
        .get(partRevision.id, layerRevision.id),
    ).toEqual({ count: 2 });
    migrated.close();
  });

  it("repairs a v25 dirty compatibility baseline with fresh required-unit identity", () => {
    const { dir, database } = createDatabase();
    const raw = rawDatabase(database);
    const profile = repository(database).createProfile("Dirty v25 repair");
    const partId = Number(
      raw
        .prepare(
          `INSERT INTO parts (
            tenant_id, profile_id, match_key, relative_path, filename, source_layer,
            status, role, quantity_auto, quantity_effective, included, notes
          ) VALUES ('default', ?, 'repair', '', 'repair.stl', '', 'base', 'primary', 2, 2, 1, '')`,
        )
        .run(profile.id).lastInsertRowid,
    );
    raw.prepare(
      `INSERT INTO print_progress (tenant_id, part_id, unit_index, completed, assembled)
       VALUES ('default', ?, 0, 1, 1)`,
    ).run(partId);
    downgradeToV18(raw);
    database.close();

    const initialTokens = [
      "ppu_00000000000000000000000000000001",
      "ppu_00000000000000000000000000000002",
    ];
    const migrated = new SqliteDatabase(dir, {
      now: () => "2026-08-20T10:00:00.000Z",
      tokenFactory: () => {
        const token = initialTokens.shift();
        if (!token) throw new Error("initial token exhausted");
        return token;
      },
    });
    migrated.connect();
    const migratedRepo = repository(migrated);
    const firstRevision = migratedRepo.getAcceptedPlanRevision(profile.id)!;
    const firstMapping = migratedRepo.readCurrentRequiredUnitSet(profile.id);
    if (firstMapping.kind !== "ready") throw new Error("initial mapping not ready");
    const migratedRaw = rawDatabase(migrated);
    migratedRaw.prepare("UPDATE parts SET included = 0 WHERE id = ?").run(partId);
    migratedRaw
      .prepare(
        `UPDATE app_settings SET value = '25'
          WHERE tenant_id = 'default' AND key = 'schema_version'`,
      )
      .run();
    expect(
      migratedRaw
        .prepare(
          `SELECT accepted_plan_revision_id, accepted_plan_version
             FROM build_profiles WHERE id = ?`,
        )
        .get(profile.id),
    ).toEqual({ accepted_plan_revision_id: null, accepted_plan_version: 1 });
    const partsBefore = migratedRaw.prepare("SELECT * FROM parts WHERE profile_id = ?").all(
      profile.id,
    );
    const progressBefore = migratedRaw
      .prepare("SELECT * FROM print_progress WHERE part_id = ? ORDER BY unit_index")
      .all(partId);
    migrated.close();

    const repairTokens = [
      "ppu_00000000000000000000000000000003",
      "ppu_00000000000000000000000000000004",
    ];
    const repaired = new SqliteDatabase(dir, {
      now: () => "2026-08-20T11:00:00.000Z",
      tokenFactory: () => {
        const token = repairTokens.shift();
        if (!token) throw new Error("repair token exhausted");
        return token;
      },
    });
    repaired.connect();
    const repairedRepo = repository(repaired);
    const repairedRaw = rawDatabase(repaired);
    const accepted = repairedRepo.getAcceptedPlanRevision(profile.id);
    const mapping = repairedRepo.readCurrentRequiredUnitSet(profile.id);

    expect(accepted).toMatchObject({
      parentRevisionId: firstRevision.id,
      planVersion: 2,
      provenanceKind: "legacy",
      parts: [expect.objectContaining({ projectionPartId: partId, included: false })],
    });
    expect(repairedRaw.prepare("SELECT * FROM parts WHERE profile_id = ?").all(profile.id)).toEqual(
      partsBefore,
    );
    expect(
      repairedRaw
        .prepare("SELECT * FROM print_progress WHERE part_id = ? ORDER BY unit_index")
        .all(partId),
    ).toEqual(progressBefore);
    expect(mapping).toMatchObject({ kind: "ready", units: expect.any(Array) });
    if (mapping.kind !== "ready") throw new Error("repaired mapping not ready");
    expect(mapping.revisionId).toBe(accepted?.id);
    expect(mapping.units.map((unit) => unit.token)).toEqual([
      "ppu_00000000000000000000000000000003",
      "ppu_00000000000000000000000000000004",
    ]);
    expect(mapping.units.map((unit) => unit.required)).toEqual([false, false]);
    expect(mapping.units.map((unit) => [unit.completed, unit.assembled])).toEqual([
      [true, true],
      [false, false],
    ]);
    expect(mapping.units.map((unit) => unit.token)).not.toEqual(
      firstMapping.units.map((unit) => unit.token),
    );
    const repairedRevisionCount = repairedRaw
      .prepare("SELECT count(*) AS count FROM plan_revisions WHERE profile_id = ?")
      .get(profile.id);
    const repairedUnitCount = repairedRaw
      .prepare("SELECT count(*) AS count FROM required_units WHERE profile_id = ?")
      .get(profile.id);
    repaired.close();

    const reopened = new SqliteDatabase(dir, {
      tokenFactory: () => {
        throw new Error("idempotent reopen allocated a token");
      },
    });
    reopened.connect();
    expect(repository(reopened).getAcceptedPlanRevision(profile.id)?.id).toBe(accepted?.id);
    expect(
      rawDatabase(reopened)
        .prepare("SELECT count(*) AS count FROM plan_revisions WHERE profile_id = ?")
        .get(profile.id),
    ).toEqual(repairedRevisionCount);
    expect(
      rawDatabase(reopened)
        .prepare("SELECT count(*) AS count FROM required_units WHERE profile_id = ?")
        .get(profile.id),
    ).toEqual(repairedUnitCount);
    reopened.close();
  });

  it("rolls back v26 compatibility repair when a legacy Part exceeds the text limit", () => {
    const { dir, database } = createDatabase();
    const raw = rawDatabase(database);
    const profile = repository(database).createProfile("Oversized v25 repair");
    raw.prepare(
      `INSERT INTO parts (
        tenant_id, profile_id, match_key, relative_path, filename, source_layer,
        status, role, quantity_auto, quantity_effective, included, notes
      ) VALUES ('default', ?, 'oversized', 'oversized.stl', 'oversized.stl', 'base',
                'base', 'primary', 1, 1, 1, ?)`,
    ).run(profile.id, "x".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES + 1));
    raw.prepare(
      `UPDATE app_settings SET value = '25'
        WHERE tenant_id = 'default' AND key = 'schema_version'`,
    ).run();
    const partsBefore = raw.prepare("SELECT * FROM parts WHERE profile_id = ?").all(profile.id);
    const profileBefore = raw.prepare("SELECT * FROM build_profiles WHERE id = ?").get(profile.id);
    database.close();

    const migrated = new SqliteDatabase(dir);
    expect(() => migrated.connect()).toThrowError(AcceptedOperationalRowTextLimitError);
    migrated.close();

    const inspect = new Database(join(dir, "print-partner.db"));
    expect(inspect.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get()).toEqual(
      { value: "25" },
    );
    expect(inspect.prepare("SELECT * FROM build_profiles WHERE id = ?").get(profile.id)).toEqual(
      profileBefore,
    );
    expect(inspect.prepare("SELECT * FROM parts WHERE profile_id = ?").all(profile.id)).toEqual(
      partsBefore,
    );
    expect(
      inspect.prepare("SELECT count(*) AS count FROM plan_revisions WHERE profile_id = ?").get(
        profile.id,
      ),
    ).toEqual({ count: 0 });
    inspect.close();
  });

  it("rolls back v26 repair when legacy revision provenance crosses the row limit", () => {
    const { dir, database } = createDatabase();
    const raw = rawDatabase(database);
    const profile = repository(database).createProfile("Legacy provenance overflow");
    const migratedAt = "2026-08-20T11:00:00.000Z";
    const fixedWithoutTenant = utf8Bytes([
      "legacy",
      "plan-revision-parts-v1",
      "x".repeat(64),
      "migration:v26",
      "migration:v26",
      migratedAt,
      migratedAt,
    ]);
    const tenantId = "t".repeat(
      MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES - fixedWithoutTenant + 1,
    );
    raw.prepare(
      `UPDATE build_profiles
          SET tenant_id = ?, accepted_plan_version = 1
        WHERE id = ?`,
    ).run(tenantId, profile.id);
    raw.prepare(
      `UPDATE app_settings SET value = '25'
        WHERE tenant_id = 'default' AND key = 'schema_version'`,
    ).run();
    database.close();

    const migrated = new SqliteDatabase(dir, { now: () => migratedAt });
    expect(() => migrated.connect()).toThrowError(AcceptedOperationalRowTextLimitError);
    migrated.close();

    const inspect = new Database(join(dir, "print-partner.db"));
    expect(inspect.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get()).toEqual(
      { value: "25" },
    );
    expect(
      inspect.prepare("SELECT count(*) AS count FROM plan_revisions WHERE profile_id = ?").get(
        profile.id,
      ),
    ).toEqual({ count: 0 });
    inspect.close();
  });

  it("publishes a legacy revision at the exact stored row limit", () => {
    const { dir, database } = createDatabase();
    const raw = rawDatabase(database);
    const profile = repository(database).createProfile("Legacy exact revision");
    const migratedAt = "2026-08-20T11:00:00.000Z";
    const fixedWithoutTenant = utf8Bytes([
      "legacy",
      "plan-revision-parts-v1",
      "x".repeat(64),
      "migration:v26",
      "migration:v26",
      migratedAt,
      migratedAt,
    ]);
    const tenantId = "t".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES - fixedWithoutTenant);
    raw.prepare(
      `UPDATE build_profiles
          SET tenant_id = ?, accepted_plan_version = 1
        WHERE id = ?`,
    ).run(tenantId, profile.id);
    raw.prepare(
      `UPDATE app_settings SET value = '25'
        WHERE tenant_id = 'default' AND key = 'schema_version'`,
    ).run();
    database.close();

    const migrated = new SqliteDatabase(dir, { now: () => migratedAt });
    migrated.connect();
    const migratedRaw = rawDatabase(migrated);
    const revision = migratedRaw
      .prepare("SELECT * FROM plan_revisions WHERE profile_id = ?")
      .get(profile.id) as Record<string, unknown>;

    expect(utf8Bytes(Object.values(revision))).toBe(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES);
    expect(
      migratedRaw.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get(),
    ).toEqual({ value: String(ACCEPTED_PLATE_EDIT_SCHEMA_VERSION) });
    migrated.close();
  });

  it("repairs an empty positive-version Build and leaves a truly empty Build untouched", () => {
    const { dir, database } = createDatabase();
    const repo = repository(database);
    const dirty = repo.createProfile("Empty dirty Build");
    const untouched = repo.createProfile("Empty new Build");
    const raw = rawDatabase(database);
    raw.prepare(
      "UPDATE build_profiles SET accepted_plan_version = 3 WHERE id = ?",
    ).run(dirty.id);
    raw.prepare(
      `UPDATE app_settings SET value = '25'
        WHERE tenant_id = 'default' AND key = 'schema_version'`,
    ).run();
    database.close();

    const repaired = new SqliteDatabase(dir);
    repaired.connect();
    const repairedRepo = repository(repaired);
    expect(repairedRepo.getAcceptedPlanRevision(dirty.id)).toMatchObject({
      planVersion: 4,
      provenanceKind: "legacy",
      parts: [],
    });
    expect(repairedRepo.readCurrentRequiredUnitSet(dirty.id)).toMatchObject({
      kind: "ready",
      units: [],
    });
    expect(repairedRepo.getAcceptedPlanRevision(untouched.id)).toBeNull();
    expect(repairedRepo.readCurrentRequiredUnitSet(untouched.id)).toEqual({
      kind: "unavailable",
      reason: "no_accepted_revision",
    });
    repaired.close();
  });

  it("upgrades a clean v25 Build without replacing accepted identity", () => {
    const { dir, database } = createDatabase();
    const raw = rawDatabase(database);
    const profile = repository(database).createProfile("Clean v25 Build");
    raw.prepare(
      `INSERT INTO parts (
        tenant_id, profile_id, match_key, relative_path, filename, source_layer,
        status, role, quantity_auto, quantity_effective, included, notes
      ) VALUES ('default', ?, 'clean', '', 'clean.stl', '', 'base', 'primary', 1, 1, 1, '')`,
    ).run(profile.id);
    backfillAcceptedPlanRevisions(raw, "2026-08-20T10:00:00.000Z");
    backfillCurrentRequiredUnitSets(raw, {
      now: () => "2026-08-20T10:00:00.000Z",
      tokenFactory: () => "ppu_00000000000000000000000000000001",
    });
    const acceptedId = repository(database).getAcceptedPlanRevision(profile.id)!.id;
    const revisionsBefore = raw
      .prepare("SELECT * FROM plan_revisions WHERE profile_id = ? ORDER BY id")
      .all(profile.id);
    const unitsBefore = raw
      .prepare("SELECT * FROM required_units WHERE profile_id = ? ORDER BY token")
      .all(profile.id);
    raw.exec(`
      CREATE TRIGGER trg_profile_layers_invalidate_accepted_revision_insert
      AFTER INSERT ON profile_layers
      BEGIN
        UPDATE build_profiles SET accepted_plan_revision_id = NULL
         WHERE id = NEW.profile_id AND tenant_id = NEW.tenant_id;
      END;
      CREATE TRIGGER trg_profile_layers_invalidate_accepted_revision_update
      AFTER UPDATE ON profile_layers
      BEGIN
        UPDATE build_profiles SET accepted_plan_revision_id = NULL
         WHERE id = NEW.profile_id AND tenant_id = NEW.tenant_id;
      END;
      CREATE TRIGGER trg_profile_layers_invalidate_accepted_revision_delete
      AFTER DELETE ON profile_layers
      BEGIN
        UPDATE build_profiles SET accepted_plan_revision_id = NULL
         WHERE id = OLD.profile_id AND tenant_id = OLD.tenant_id;
      END;
      UPDATE app_settings SET value = '25'
       WHERE tenant_id = 'default' AND key = 'schema_version';
    `);
    database.close();

    const upgraded = new SqliteDatabase(dir, {
      tokenFactory: () => {
        throw new Error("clean migration allocated a token");
      },
    });
    upgraded.connect();
    const upgradedRaw = rawDatabase(upgraded);
    expect(repository(upgraded).getAcceptedPlanRevision(profile.id)?.id).toBe(acceptedId);
    expect(
      upgradedRaw.prepare("SELECT * FROM plan_revisions WHERE profile_id = ? ORDER BY id").all(
        profile.id,
      ),
    ).toEqual(revisionsBefore);
    expect(
      upgradedRaw.prepare("SELECT * FROM required_units WHERE profile_id = ? ORDER BY token").all(
        profile.id,
      ),
    ).toEqual(unitsBefore);
    expect(
      upgradedRaw
        .prepare(
          `SELECT count(*) AS count FROM sqlite_master
            WHERE type = 'trigger'
              AND name LIKE 'trg_profile_layers_invalidate_accepted_revision_%'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    upgraded.close();
  });

  it("rolls back a failed repair before dropping legacy layer invalidation", () => {
    const { dir, database } = createDatabase();
    const profile = repository(database).createProfile("Repair rollback");
    const raw = rawDatabase(database);
    raw.prepare(
      `INSERT INTO parts (
        tenant_id, profile_id, match_key, relative_path, filename, source_layer,
        status, role, quantity_auto, quantity_effective, included, notes
      ) VALUES ('default', ?, 'rollback', '', 'rollback.stl', '', 'base', 'primary', 2, 2, 1, '')`,
    ).run(profile.id);
    raw.exec(`
      CREATE TRIGGER trg_profile_layers_invalidate_accepted_revision_insert
      AFTER INSERT ON profile_layers
      BEGIN
        UPDATE build_profiles
           SET accepted_plan_revision_id = NULL
         WHERE id = NEW.profile_id AND tenant_id = NEW.tenant_id;
      END;
    `);
    raw.prepare(
      `UPDATE app_settings SET value = '25'
        WHERE tenant_id = 'default' AND key = 'schema_version'`,
    ).run();
    database.close();

    const failing = new SqliteDatabase(dir, {
      tokenFactory: () => {
        throw new Error("repair token failure");
      },
    });
    expect(() => failing.connect()).toThrow("repair token failure");
    failing.close();

    const afterFailure = new Database(join(dir, "print-partner.db"));
    expect(
      afterFailure
        .prepare(
          `SELECT accepted_plan_revision_id, accepted_plan_version
             FROM build_profiles WHERE id = ?`,
        )
        .get(profile.id),
    ).toEqual({ accepted_plan_revision_id: null, accepted_plan_version: 0 });
    expect(
      afterFailure
        .prepare("SELECT count(*) AS count FROM plan_revisions WHERE profile_id = ?")
        .get(profile.id),
    ).toEqual({ count: 0 });
    expect(
      afterFailure
        .prepare(
          `SELECT count(*) AS count FROM sqlite_master
            WHERE type = 'trigger'
              AND name = 'trg_profile_layers_invalidate_accepted_revision_insert'`,
        )
        .get(),
    ).toEqual({ count: 1 });
    afterFailure.close();
  });

  it("fails closed on a v25 dirty Part owned by another tenant", () => {
    const { dir, database } = createDatabase();
    const raw = rawDatabase(database);
    const profile = repository(database).createProfile("Repair tenant guard");
    raw.prepare(
      `INSERT INTO parts (
        tenant_id, profile_id, match_key, relative_path, filename, source_layer,
        status, role, quantity_auto, quantity_effective, included, notes
      ) VALUES ('farm-b', ?, 'foreign', '', 'foreign.stl', '', 'base', 'primary', 1, 1, 1, '')`,
    ).run(profile.id);
    raw.prepare(
      `UPDATE app_settings SET value = '25'
        WHERE tenant_id = 'default' AND key = 'schema_version'`,
    ).run();
    database.close();

    const upgraded = new SqliteDatabase(dir);
    expect(() => upgraded.connect()).toThrow(/tenant does not match owning Build/i);
    upgraded.close();
  });

  it("repairs a layer race before removing invalidation and stamping v28", () => {
    const { dir, database } = createDatabase();
    const raw = rawDatabase(database);
    const profile = repository(database).createProfile("Layer cutover race");
    const layerId = Number(
      raw
        .prepare(
          `INSERT INTO profile_layers (tenant_id, profile_id, layer_order, layer_type, project_id)
           VALUES ('default', ?, 0, 'base', NULL)`,
        )
        .run(profile.id).lastInsertRowid,
    );
    backfillAcceptedPlanRevisions(raw, "2026-08-20T10:00:00.000Z");
    backfillCurrentRequiredUnitSets(raw, { now: () => "2026-08-20T10:00:00.000Z" });
    const firstRevisionId = repository(database).getAcceptedPlanRevision(profile.id)!.id;
    raw.exec(`
      CREATE TRIGGER trg_profile_layers_invalidate_accepted_revision_update
      AFTER UPDATE ON profile_layers
      BEGIN
        UPDATE build_profiles SET accepted_plan_revision_id = NULL
         WHERE id = NEW.profile_id AND tenant_id = NEW.tenant_id;
      END;
      UPDATE app_settings SET value = '25'
       WHERE tenant_id = 'default' AND key = 'schema_version';
    `);
    database.close();
    const racer = new Database(join(dir, "print-partner.db"));
    racer.pragma("journal_mode = WAL");
    racer.pragma("foreign_keys = ON");
    let raced = false;
    const upgraded = new SqliteDatabase(dir, {
      beforeCompatibilityCutover: () => {
        racer.prepare("UPDATE profile_layers SET layer_order = 1 WHERE id = ?").run(layerId);
        raced = true;
      },
    });
    upgraded.connect();
    const accepted = repository(upgraded).getAcceptedPlanRevision(profile.id);
    expect(raced).toBe(true);
    expect(accepted).toMatchObject({ parentRevisionId: firstRevisionId, planVersion: 2 });
    expect(
      rawDatabase(upgraded)
        .prepare("SELECT value FROM app_settings WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: String(ACCEPTED_PLATE_EDIT_SCHEMA_VERSION) });
    expect(
      rawDatabase(upgraded)
        .prepare(
          `SELECT count(*) AS count FROM sqlite_master
            WHERE type = 'trigger'
              AND name = 'trg_profile_layers_invalidate_accepted_revision_update'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    racer.close();
    upgraded.close();
  });

  it("rejects a tenant-poisoned accepted input before repair publication", () => {
    const { dir, database } = createDatabase();
    const raw = rawDatabase(database);
    const profile = repository(database).createProfile("Poisoned accepted input");
    const inputSetId = Number(
      raw
        .prepare(
          `INSERT INTO plan_revision_input_sets (
            tenant_id, profile_id, input_set_digest, expected_input_count,
            format_version, recorded_at, published_at
          ) VALUES ('default', ?, ?, 0, 2, ?, ?)`,
        )
        .run(
          profile.id,
          "b".repeat(64),
          "2026-08-20T10:00:00.000Z",
          "2026-08-20T10:00:00.000Z",
        ).lastInsertRowid,
    );
    raw.prepare(
      `INSERT INTO plan_accepted_input_sets (tenant_id, profile_id, input_set_id, accepted_at)
       VALUES ('farm-b', ?, ?, ?)`,
    ).run(profile.id, inputSetId, "2026-08-20T10:00:00.000Z");
    raw.prepare(
      `INSERT INTO parts (
        tenant_id, profile_id, match_key, relative_path, filename, source_layer,
        status, role, quantity_auto, quantity_effective, included, notes
      ) VALUES ('default', ?, 'poisoned', '', 'poisoned.stl', '', 'base', 'primary', 1, 1, 1, '')`,
    ).run(profile.id);
    raw.prepare(
      `UPDATE app_settings SET value = '25'
        WHERE tenant_id = 'default' AND key = 'schema_version'`,
    ).run();
    database.close();

    const upgraded = new SqliteDatabase(dir);
    expect(() => upgraded.connect()).toThrow(/accepted input set .* does not belong/i);
    upgraded.close();
    const inspect = new Database(join(dir, "print-partner.db"));
    expect(
      inspect
        .prepare(
          `SELECT accepted_plan_revision_id, accepted_plan_version
             FROM build_profiles WHERE id = ?`,
        )
        .get(profile.id),
    ).toEqual({ accepted_plan_revision_id: null, accepted_plan_version: 0 });
    expect(inspect.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get()).toEqual(
      { value: "25" },
    );
    expect(
      inspect
        .prepare(
          `SELECT tenant_id, input_set_id
             FROM plan_accepted_input_sets WHERE profile_id = ?`,
        )
        .get(profile.id),
    ).toEqual({ tenant_id: "farm-b", input_set_id: inputSetId });
    inspect.close();
  });

  it("rejects an empty negative accepted Plan version before v26", () => {
    const { dir, database } = createDatabase();
    const profile = repository(database).createProfile("Negative Plan version");
    const raw = rawDatabase(database);
    raw.prepare("UPDATE build_profiles SET accepted_plan_version = -1 WHERE id = ?").run(
      profile.id,
    );
    raw.prepare(
      `UPDATE app_settings SET value = '25'
        WHERE tenant_id = 'default' AND key = 'schema_version'`,
    ).run();
    database.close();

    const upgraded = new SqliteDatabase(dir);
    expect(() => upgraded.connect()).toThrow(/invalid accepted Plan version/i);
    upgraded.close();
    const inspect = new Database(join(dir, "print-partner.db"));
    expect(inspect.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get()).toEqual(
      { value: "25" },
    );
    inspect.close();
  });

  it("counts only compatibility repairs that publish", () => {
    const { database } = createDatabase();
    const raw = rawDatabase(database);
    const profile = repository(database).createProfile("Concurrent repair summary");
    raw.prepare("UPDATE build_profiles SET accepted_plan_version = 1 WHERE id = ?").run(
      profile.id,
    );
    const winnerRevisionId = Number(
      raw
        .prepare(
          `INSERT INTO plan_revisions (
            tenant_id, profile_id, revision_number, parent_revision_id, input_set_id,
            provenance_kind, digest_format, snapshot_digest, created_by, accepted_by,
            created_at, accepted_at
          ) VALUES ('default', ?, 1, NULL, NULL, 'legacy', 'plan-revision-parts-v1', ?,
                    'test', 'test', ?, ?)`,
        )
        .run(
          profile.id,
          digestPlanRevisionParts([]),
          "2026-08-20T10:00:00.000Z",
          "2026-08-20T10:00:00.000Z",
        ).lastInsertRowid,
    );
    const result = repairCompatibilityDirtyBuilds(raw, {
      beforeBuildRepair: (profileId) => {
        raw.prepare(
          `UPDATE build_profiles
              SET accepted_plan_revision_id = ?, accepted_plan_version = 1
            WHERE id = ?`,
        ).run(winnerRevisionId, profileId);
      },
    });
    expect(result).toEqual({
      buildsRepaired: 0,
      revisionsCreated: 0,
      partsCaptured: 0,
      unitsCreated: 0,
    });
    database.close();
  });

  it("invalidates Part owners but preserves accepted baselines across layer moves", () => {
    const { dir, database } = createDatabase();
    const raw = rawDatabase(database);
    const partFrom = repository(database).createProfile("Part from");
    const partTo = repository(database).createProfile("Part to");
    const layerFrom = repository(database).createProfile("Layer from");
    const layerTo = repository(database).createProfile("Layer to");
    const part = raw
      .prepare(
        `INSERT INTO parts (
          tenant_id, profile_id, match_key, relative_path, filename, source_layer,
          status, role, quantity_auto, quantity_effective, included, notes
        ) VALUES ('default', ?, 'moving', '', 'moving.stl', '', 'base', 'primary', 1, 1, 1, '')`,
      )
      .run(partFrom.id);
    const layer = raw
      .prepare(
        `INSERT INTO profile_layers (tenant_id, profile_id, layer_order, layer_type, project_id)
         VALUES ('default', ?, 0, 'base', NULL)`,
      )
      .run(layerFrom.id);
    downgradeToV18(raw);
    database.close();

    const migrated = new SqliteDatabase(dir);
    migrated.connect();
    const migratedRaw = rawDatabase(migrated);
    const layerFromRevisionId = repository(migrated).getAcceptedPlanRevision(layerFrom.id)!.id;
    const layerToRevisionId = repository(migrated).getAcceptedPlanRevision(layerTo.id)!.id;
    migratedRaw.prepare("UPDATE parts SET profile_id = ? WHERE id = ?").run(
      partTo.id,
      Number(part.lastInsertRowid),
    );
    migratedRaw.prepare("UPDATE profile_layers SET profile_id = ? WHERE id = ?").run(
      layerTo.id,
      Number(layer.lastInsertRowid),
    );

    expect(
      migratedRaw
        .prepare(
          `SELECT id, accepted_plan_revision_id, accepted_plan_version
             FROM build_profiles
            WHERE id IN (?, ?, ?, ?)
            ORDER BY id`,
        )
        .all(partFrom.id, partTo.id, layerFrom.id, layerTo.id),
    ).toEqual([
      { id: partFrom.id, accepted_plan_revision_id: null, accepted_plan_version: 1 },
      { id: partTo.id, accepted_plan_revision_id: null, accepted_plan_version: 1 },
      {
        id: layerFrom.id,
        accepted_plan_revision_id: layerFromRevisionId,
        accepted_plan_version: 1,
      },
      {
        id: layerTo.id,
        accepted_plan_revision_id: layerToRevisionId,
        accepted_plan_version: 1,
      },
    ]);
    migrated.close();
  });
});
