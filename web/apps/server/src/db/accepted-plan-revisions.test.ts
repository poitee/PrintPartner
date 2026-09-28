import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backfillAcceptedPlanRevisions } from "./accepted-plan-revisions.js";
import { getDb, SqliteDatabase } from "./client.js";
import { AppRepository } from "./repository.js";

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

  it("returns accepted PartRows in the existing filename order", () => {
    const { database } = createDatabase();
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
    backfillAcceptedPlanRevisions(raw, "2026-08-20T12:00:00.000Z");
    expect(repository(database).getAcceptedPlanPartRows(profile.id)).toEqual(livePartRows);
    database.close();
  });

  it("keeps Build deletion available after the accepted pointer is populated", () => {
    const { database } = createDatabase();
    const profile = repository(database).createProfile("Disposable");
    backfillAcceptedPlanRevisions(rawDatabase(database), "2026-08-20T12:00:00.000Z");
    const repo = repository(database);
    expect(repo.getAcceptedPlanRevision(profile.id)).not.toBeNull();
    expect(() => repo.deleteProfile(profile.id)).not.toThrow();
    expect(repo.getProfileHeader(profile.id)).toBeNull();
    expect(
      rawDatabase(database)
        .prepare("SELECT count(*) AS count FROM plan_revisions WHERE profile_id = ?")
        .get(profile.id),
    ).toEqual({ count: 0 });
    database.close();
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

  it("rejects cross-owner accepted revision relationships", () => {
    const { database } = createDatabase();
    const raw = rawDatabase(database);
    const firstProfile = repository(database).createProfile("First owner");
    const secondProfile = repository(database).createProfile("Second owner");
    raw.prepare(
      `INSERT INTO parts (
        tenant_id, profile_id, match_key, relative_path, filename, source_layer,
        status, role, quantity_auto, quantity_effective, included, notes
      ) VALUES ('default', ?, 'second-part', '', 'second.stl', '', 'base', 'primary', 1, 1, 1, '')`,
    ).run(secondProfile.id);
    backfillAcceptedPlanRevisions(raw, "2026-08-20T12:00:00.000Z");
    const first = repository(database).getAcceptedPlanRevision(firstProfile.id)!;
    const second = repository(database).getAcceptedPlanRevision(secondProfile.id)!;
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
    database.close();
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
    const { database } = createDatabase();
    const raw = rawDatabase(database);
    const profile = repository(database).createProfile("Immutable");
    raw.prepare(
      `INSERT INTO parts (
        tenant_id, profile_id, match_key, relative_path, filename, source_layer,
        status, role, quantity_auto, quantity_effective, included, notes
      ) VALUES ('default', ?, 'fixed', '', 'fixed.stl', '', 'base', 'primary', 1, 1, 1, '')`,
    ).run(profile.id);
    backfillAcceptedPlanRevisions(raw, "2026-08-20T12:00:00.000Z");
    const accepted = repository(database).getAcceptedPlanRevision(profile.id)!;
    expect(() =>
      raw
        .prepare("UPDATE plan_revisions SET snapshot_digest = ? WHERE id = ?")
        .run("f".repeat(64), accepted.id),
    ).toThrow(/immutable/i);
    expect(() =>
      raw
        .prepare("UPDATE plan_revision_parts SET filename = 'changed.stl' WHERE revision_id = ?")
        .run(accepted.id),
    ).toThrow(/immutable/i);
    expect(() =>
      raw.prepare("DELETE FROM plan_revision_parts WHERE revision_id = ?").run(accepted.id),
    ).toThrow(/immutable/i);
    database.close();
  });

  it("keeps accepted Source selection separate from compatibility Part dirtiness", () => {
    const { database } = createDatabase();
    const raw = rawDatabase(database);
    const partProfile = repository(database).createProfile("Mutable Part projection");
    const layerProfile = repository(database).createProfile("Mutable layer projection");
    raw.prepare(
      `INSERT INTO parts (
        tenant_id, profile_id, match_key, relative_path, filename, source_layer,
        status, role, quantity_auto, quantity_effective, included, notes
      ) VALUES ('default', ?, 'mutable', '', 'mutable.stl', '', 'base', 'primary', 1, 1, 1, '')`,
    ).run(partProfile.id);
    backfillAcceptedPlanRevisions(raw, "2026-08-20T12:00:00.000Z");
    const repo = repository(database);
    const partRevision = repo.getAcceptedPlanRevision(partProfile.id)!;
    const layerRevision = repo.getAcceptedPlanRevision(layerProfile.id)!;
    raw
      .prepare("UPDATE parts SET notes = 'compatibility-dirty' WHERE id = ?")
      .run(partRevision.parts[0]!.projectionPartId!);
    raw
      .prepare(
        `INSERT INTO profile_layers (tenant_id, profile_id, layer_order, layer_type, project_id)
         VALUES ('default', ?, 0, 'base', NULL)`,
      )
      .run(layerProfile.id);

    expect(repo.getAcceptedPlanRevision(partProfile.id)).toBeNull();
    expect(repo.getAcceptedPlanRevision(layerProfile.id)?.id).toBe(layerRevision.id);
    expect(
      raw
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
      raw
        .prepare("SELECT count(*) AS count FROM plan_revisions WHERE id IN (?, ?)")
        .get(partRevision.id, layerRevision.id),
    ).toEqual({ count: 2 });
    database.close();
  });

  it("invalidates Part owners but preserves accepted baselines across layer moves", () => {
    const { database } = createDatabase();
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
    backfillAcceptedPlanRevisions(raw, "2026-08-20T12:00:00.000Z");
    const layerFromRevisionId = repository(database).getAcceptedPlanRevision(layerFrom.id)!.id;
    const layerToRevisionId = repository(database).getAcceptedPlanRevision(layerTo.id)!.id;
    raw.prepare("UPDATE parts SET profile_id = ? WHERE id = ?").run(
      partTo.id,
      Number(part.lastInsertRowid),
    );
    raw.prepare("UPDATE profile_layers SET profile_id = ? WHERE id = ?").run(
      layerTo.id,
      Number(layer.lastInsertRowid),
    );

    expect(
      raw
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
    database.close();
  });
});
