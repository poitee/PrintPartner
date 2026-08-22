import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backfillAcceptedPlanRevisions } from "./accepted-plan-revisions.js";
import { getDb, SqliteDatabase } from "./client.js";
import { AppRepository } from "./repository.js";
import { backfillCurrentRequiredUnitSets } from "./required-units.js";
import {
  registerPostgresSyncQuery,
  unregisterPostgresSyncQuery,
  type AppDrizzleDb,
} from "./sync-db-bridge.js";
import {
  MAX_WORKING_PLAN_SOURCES,
  workingSourceSelection,
} from "../services/working-plan-sources.js";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pp-working-sources-"));
  roots.push(root);
  const database = new SqliteDatabase(root);
  database.connect();
  const raw = (database as unknown as { sqlite: Database.Database }).sqlite;
  return {
    database,
    raw,
    repo: new AppRepository(getDb(database), "default", database.reposDir),
  };
}

function protectedSnapshot(raw: Database.Database, profileId: number) {
  return {
    profile: raw
      .prepare(
        `SELECT accepted_plan_revision_id, accepted_plan_version, last_recomputed_at
           FROM build_profiles WHERE id = ?`,
      )
      .get(profileId),
    parts: raw.prepare("SELECT * FROM parts WHERE profile_id = ? ORDER BY id").all(profileId),
    progress: raw.prepare("SELECT * FROM print_progress ORDER BY id").all(),
    revisions: raw
      .prepare("SELECT * FROM plan_revisions WHERE profile_id = ? ORDER BY id")
      .all(profileId),
    revisionParts: raw.prepare("SELECT * FROM plan_revision_parts ORDER BY id").all(),
    inputSets: raw
      .prepare("SELECT * FROM plan_revision_input_sets WHERE profile_id = ? ORDER BY id")
      .all(profileId),
    acceptedInputs: raw
      .prepare("SELECT * FROM plan_accepted_input_sets WHERE profile_id = ? ORDER BY input_set_id")
      .all(profileId),
    requiredUnits: raw.prepare("SELECT * FROM required_units ORDER BY token").all(),
    requiredSets: raw
      .prepare("SELECT * FROM plan_revision_required_unit_sets ORDER BY revision_id")
      .all(),
    requiredMappings: raw
      .prepare("SELECT * FROM plan_revision_required_units ORDER BY revision_part_id, unit_index")
      .all(),
    drafts: raw.prepare("SELECT * FROM plan_drafts WHERE profile_id = ? ORDER BY id").all(profileId),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("working Plan Sources", () => {
  it("replaces the complete ordered set and converges exact retries without touching accepted state", () => {
    const { database, raw, repo } = fixture();
    const profile = repo.createProfile("Working Sources");
    const base = repo.createSource({ name: "Base" });
    const addon = repo.createSource({ name: "Addon" });
    const partId = Number(
      raw
        .prepare(
          `INSERT INTO parts (
            tenant_id, profile_id, match_key, relative_path, filename, source_layer,
            status, role, quantity_auto, quantity_effective, included, notes
          ) VALUES ('default', ?, 'part', '', 'part.stl', '', 'base', 'primary', 1, 1, 1, '')`,
        )
        .run(profile.id).lastInsertRowid,
    );
    raw.prepare(
      `INSERT INTO print_progress (tenant_id, part_id, unit_index, completed, assembled)
       VALUES ('default', ?, 0, 1, 1)`,
    ).run(partId);
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
          "a".repeat(64),
          "2026-08-20T09:00:00.000Z",
          "2026-08-20T09:00:00.000Z",
        ).lastInsertRowid,
    );
    raw.prepare(
      `INSERT INTO plan_accepted_input_sets (tenant_id, profile_id, input_set_id, accepted_at)
       VALUES ('default', ?, ?, ?)`,
    ).run(profile.id, inputSetId, "2026-08-20T09:00:00.000Z");
    backfillAcceptedPlanRevisions(raw, "2026-08-20T10:00:00.000Z");
    backfillCurrentRequiredUnitSets(raw, {
      now: () => "2026-08-20T10:00:00.000Z",
      tokenFactory: () => "ppu_00000000000000000000000000000001",
    });
    const before = protectedSnapshot(raw, profile.id);
    const empty = repo.readWorkingPlanSources(profile.id)!;
    const target = [
      { kind: "base" as const, sourceId: base.id },
      { kind: "addon" as const, sourceId: addon.id },
    ];

    const updated = repo.replaceWorkingPlanSources({
      profileId: profile.id,
      expectedDigest: empty.digest,
      sources: target,
    });
    expect(updated).toEqual({
      kind: "updated",
      selection: workingSourceSelection(target),
    });
    const modifiedAt = raw
      .prepare("SELECT config_modified_at FROM build_profiles WHERE id = ?")
      .get(profile.id);
    expect(modifiedAt).toMatchObject({ config_modified_at: expect.any(String) });
    expect(
      repo.replaceWorkingPlanSources({
        profileId: profile.id,
        expectedDigest: empty.digest,
        sources: target,
      }),
    ).toEqual({ kind: "unchanged", selection: workingSourceSelection(target) });
    expect(
      raw.prepare("SELECT config_modified_at FROM build_profiles WHERE id = ?").get(profile.id),
    ).toEqual(modifiedAt);
    expect(protectedSnapshot(raw, profile.id)).toEqual(before);
    database.close();
  });

  it("returns conflict for a different stale target and rejects unavailable ownership", () => {
    const { database, raw, repo } = fixture();
    const profile = repo.createProfile("Conflicts");
    const base = repo.createSource({ name: "Base" });
    const addon = repo.createSource({ name: "Addon" });
    const empty = repo.readWorkingPlanSources(profile.id)!;
    const first = workingSourceSelection([{ kind: "base", sourceId: base.id }]);
    expect(
      repo.replaceWorkingPlanSources({
        profileId: profile.id,
        expectedDigest: empty.digest,
        sources: first.sources,
      }).kind,
    ).toBe("updated");
    expect(
      repo.replaceWorkingPlanSources({
        profileId: profile.id,
        expectedDigest: empty.digest,
        sources: [
          { kind: "base", sourceId: base.id },
          { kind: "addon", sourceId: addon.id },
        ],
      }),
    ).toEqual({ kind: "conflict", selection: first });
    const foreignSourceId = Number(
      raw
        .prepare(
          `INSERT INTO projects (tenant_id, name, url, source_type, branch, source_kind, role)
           VALUES ('farm-b', 'Foreign', '', 'git', 'main', 'github', 'unassigned')`,
        )
        .run().lastInsertRowid,
    );
    expect(
      repo.replaceWorkingPlanSources({
        profileId: profile.id,
        expectedDigest: first.digest,
        sources: [{ kind: "base", sourceId: foreignSourceId }],
      }),
    ).toEqual({ kind: "not_found" });
    raw.prepare("UPDATE build_profiles SET archived_at = ? WHERE id = ?").run(
      "2026-08-20T12:00:00.000Z",
      profile.id,
    );
    expect(
      repo.replaceWorkingPlanSources({
        profileId: profile.id,
        expectedDigest: first.digest,
        sources: [],
      }),
    ).toEqual({ kind: "build_archived" });
    expect(
      repo.replaceWorkingPlanSources({
        profileId: 999_999,
        expectedDigest: empty.digest,
        sources: [],
      }),
    ).toEqual({ kind: "not_found" });
    database.close();
  });

  it("rolls back a failed whole-set replacement and enforces the selection bound", () => {
    const { database, raw, repo } = fixture();
    const profile = repo.createProfile("Rollback");
    const base = repo.createSource({ name: "Base" });
    const addon = repo.createSource({ name: "Addon" });
    const empty = repo.readWorkingPlanSources(profile.id)!;
    raw.exec(
      `CREATE TRIGGER reject_second_working_source
       BEFORE INSERT ON profile_layers
       WHEN NEW.layer_order = 1
       BEGIN
         SELECT RAISE(ABORT, 'injected working Source failure');
       END`,
    );
    expect(() =>
      repo.replaceWorkingPlanSources({
        profileId: profile.id,
        expectedDigest: empty.digest,
        sources: [
          { kind: "base", sourceId: base.id },
          { kind: "addon", sourceId: addon.id },
        ],
      }),
    ).toThrow(/injected working Source failure/i);
    expect(repo.readWorkingPlanSources(profile.id)).toEqual(empty);
    expect(() =>
      workingSourceSelection(
        Array.from({ length: MAX_WORKING_PLAN_SOURCES + 1 }, (_, index) => ({
          kind: index === 0 ? ("base" as const) : ("addon" as const),
          sourceId: index + 1,
        })),
      ),
    ).toThrow(/cannot exceed 64/i);
    database.close();
  });

  it("fails closed on PostgreSQL before any read", () => {
    const postgres = {} as AppDrizzleDb;
    let reads = 0;
    registerPostgresSyncQuery(postgres, () => {
      reads += 1;
      throw new Error("unexpected PostgreSQL read");
    });
    try {
      const repo = new AppRepository(postgres, "default", "/tmp/unused-working-sources");
      expect(
        repo.replaceWorkingPlanSources({
          profileId: 1,
          expectedDigest: "not-read-or-validated",
          sources: [{ kind: "addon", sourceId: -1 }],
        }),
      ).toEqual({ kind: "transaction_unavailable" });
      expect(reads).toBe(0);
    } finally {
      unregisterPostgresSyncQuery(postgres);
    }
  });
});
