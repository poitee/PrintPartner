import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backfillAcceptedPlanRevisions } from "./accepted-plan-revisions.js";
import { getDb, SqliteDatabase } from "./client.js";
import {
  backfillCurrentRequiredUnitSets,
  MAX_REQUIRED_UNIT_QUANTITY,
} from "./required-units.js";
import { AppRepository } from "./repository.js";
import { digestRequiredUnitMap } from "../services/required-units.js";

const roots: string[] = [];
const protectedTables = [
  "parts",
  "print_progress",
  "profile_layers",
  "projects",
  "plan_revisions",
  "plan_revision_parts",
  "plan_revision_input_sets",
  "plan_revision_inputs",
  "plan_accepted_input_sets",
  "plan_drafts",
  "plan_draft_inputs",
  "plan_draft_parts",
  "build_profiles",
  "app_settings",
  "printer_profiles",
  "printer_profile_assignments",
] as const;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pp-required-unit-"));
  roots.push(root);
  const database = new SqliteDatabase(root);
  database.connect();
  const raw = (database as unknown as { sqlite: Database.Database }).sqlite;
  return {
    root,
    database,
    raw,
    repo: new AppRepository(getDb(database), "default", database.reposDir),
  };
}

function tokenFactory(start = 1) {
  let value = start;
  return () => `ppu_${(value++).toString(16).padStart(32, "0")}`;
}

function snapshot(raw: Database.Database) {
  return new Map(
    protectedTables.map((table) => [
      table,
      raw.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    ]),
  );
}

function addLivePart(input: {
  raw: Database.Database;
  profileId: number;
  key: string;
  filename: string;
  quantity: number;
  included: boolean;
}): number {
  const inserted = input.raw
    .prepare(
      `INSERT INTO parts (
        tenant_id, profile_id, match_key, relative_path, filename, source_layer,
        status, role, quantity_auto, quantity_effective, included, notes
      ) VALUES ('default', ?, ?, ?, ?, 'base', 'base', 'primary', ?, ?, ?, '')`,
    )
    .run(
      input.profileId,
      input.key,
      input.filename,
      input.filename,
      input.quantity,
      input.quantity,
      input.included ? 1 : 0,
    );
  return Number(inserted.lastInsertRowid);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Required-unit accepted-revision foundation", () => {
  it("maps included and excluded copies and reads live Checkoff without mutating accepted state", () => {
    const { database, raw, repo, root } = fixture();
    const profile = repo.createProfile("Required units");
    const includedPartId = addLivePart({
      raw,
      profileId: profile.id,
      key: "front",
      filename: "folder/front<bracket>.STL",
      quantity: 2,
      included: true,
    });
    addLivePart({
      raw,
      profileId: profile.id,
      key: "spare",
      filename: "other/front<bracket>.stl",
      quantity: 1,
      included: false,
    });
    raw.prepare(
      `INSERT INTO print_progress (tenant_id, part_id, unit_index, completed, assembled)
       VALUES ('default', ?, 0, 1, 1)`,
    ).run(includedPartId);
    backfillAcceptedPlanRevisions(raw, "2026-08-20T10:00:00.000Z");
    const before = snapshot(raw);

    expect(
      backfillCurrentRequiredUnitSets(raw, {
        now: () => "2026-08-20T11:00:00.000Z",
        tokenFactory: tokenFactory(),
      }),
    ).toEqual({ setsCreated: 1, setsReused: 0, unitsCreated: 3, buildsSkipped: 0 });
    expect(snapshot(raw)).toEqual(before);
    const ready = repo.readCurrentRequiredUnitSet(profile.id);
    expect(ready).toMatchObject({ kind: "ready", units: expect.any(Array) });
    if (ready.kind !== "ready") throw new Error("Required-unit set not ready");
    expect(ready.units).toHaveLength(3);
    expect(ready.units.map((unit) => unit.required)).toEqual([true, true, false]);
    expect(ready.units.map((unit) => [unit.completed, unit.assembled])).toEqual([
      [true, true],
      [false, false],
      [false, false],
    ]);
    expect(new Set(ready.units.map((unit) => unit.objectName)).size).toBe(3);
    expect(ready.units.every((unit) => unit.objectName.endsWith(unit.token))).toBe(true);

    raw.prepare(
      `UPDATE print_progress SET assembled = 0
        WHERE tenant_id = 'default' AND part_id = ? AND unit_index = 0`,
    ).run(includedPartId);
    const refreshed = repo.readCurrentRequiredUnitSet(profile.id);
    expect(refreshed.kind).toBe("ready");
    if (refreshed.kind !== "ready") throw new Error("Required-unit set not ready");
    expect(refreshed.units[0]).toMatchObject({ completed: true, assembled: false });
    const digest = ready.mappingDigest;
    database.close();
    const reopened = new SqliteDatabase(root);
    reopened.connect();
    expect(
      new AppRepository(getDb(reopened), "default", reopened.reposDir).readCurrentRequiredUnitSet(
        profile.id,
      ),
    ).toMatchObject({ kind: "ready", mappingDigest: digest });
    reopened.close();
  });

  it("finalizes and reuses an empty accepted set without consuming tokens", () => {
    const { raw, repo } = fixture();
    const profile = repo.createProfile("Empty accepted Build");
    backfillAcceptedPlanRevisions(raw, "2026-08-20T10:00:00.000Z");
    const token = tokenFactory();
    expect(backfillCurrentRequiredUnitSets(raw, { tokenFactory: token })).toMatchObject({
      setsCreated: 1,
      unitsCreated: 0,
    });
    let consumed = false;
    expect(
      backfillCurrentRequiredUnitSets(raw, {
        tokenFactory: () => {
          consumed = true;
          return token();
        },
      }),
    ).toMatchObject({ setsReused: 1, unitsCreated: 0 });
    expect(consumed).toBe(false);
    expect(repo.readCurrentRequiredUnitSet(profile.id)).toMatchObject({
      kind: "ready",
      units: [],
    });
  });

  it("skips clean empty and compatibility-dirty Builds", () => {
    const { raw, repo } = fixture();
    const empty = repo.createProfile("Empty");
    const dirty = repo.createProfile("Dirty");
    raw.prepare(
      `UPDATE build_profiles SET accepted_plan_version = 2
        WHERE tenant_id = 'default' AND id = ?`,
    ).run(dirty.id);
    expect(backfillCurrentRequiredUnitSets(raw, { tokenFactory: tokenFactory() })).toEqual({
      setsCreated: 0,
      setsReused: 0,
      unitsCreated: 0,
      buildsSkipped: 2,
    });
    expect(repo.readCurrentRequiredUnitSet(empty.id)).toEqual({
      kind: "unavailable",
      reason: "no_accepted_revision",
    });
    expect(repo.readCurrentRequiredUnitSet(dirty.id)).toEqual({
      kind: "unavailable",
      reason: "compatibility_dirty",
    });
  });

  it("rolls back all new rows after bounded collision exhaustion", () => {
    const { raw, repo } = fixture();
    const first = repo.createProfile("First");
    addLivePart({
      raw,
      profileId: first.id,
      key: "first",
      filename: "same.stl",
      quantity: 1,
      included: true,
    });
    backfillAcceptedPlanRevisions(raw);
    const collidingToken = "ppu_00000000000000000000000000000001";
    backfillCurrentRequiredUnitSets(raw, { tokenFactory: () => collidingToken });
    const second = repo.createProfile("Second");
    addLivePart({
      raw,
      profileId: second.id,
      key: "second",
      filename: "same.stl",
      quantity: 1,
      included: true,
    });
    backfillAcceptedPlanRevisions(raw);
    expect(() =>
      backfillCurrentRequiredUnitSets(raw, {
        tokenFactory: () => collidingToken,
        maxCollisionAttempts: 2,
      }),
    ).toThrow(/collision limit/i);
    expect(
      raw.prepare("SELECT count(*) AS count FROM required_units WHERE profile_id = ?").get(second.id),
    ).toEqual({ count: 0 });
    expect(
      raw
        .prepare("SELECT count(*) AS count FROM plan_revision_required_unit_sets WHERE profile_id = ?")
        .get(second.id),
    ).toEqual({ count: 0 });
    let attempt = 0;
    expect(
      backfillCurrentRequiredUnitSets(raw, {
        tokenFactory: () => {
          attempt += 1;
          return attempt === 1
            ? collidingToken
            : "ppu_00000000000000000000000000000002";
        },
      }),
    ).toMatchObject({ setsCreated: 1, unitsCreated: 1 });
    expect(attempt).toBe(2);
  });

  it("rolls back every Required-unit row after an injected factory failure", () => {
    const { raw, repo } = fixture();
    const profile = repo.createProfile("Injected failure");
    addLivePart({
      raw,
      profileId: profile.id,
      key: "two",
      filename: "two.stl",
      quantity: 2,
      included: true,
    });
    backfillAcceptedPlanRevisions(raw);
    let calls = 0;
    expect(() =>
      backfillCurrentRequiredUnitSets(raw, {
        tokenFactory: () => {
          calls += 1;
          if (calls === 2) throw new Error("injected token failure");
          return "ppu_00000000000000000000000000000001";
        },
      }),
    ).toThrow(/injected token failure/i);
    for (const table of [
      "required_units",
      "plan_revision_required_units",
      "plan_revision_required_unit_sets",
    ]) {
      expect(raw.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it.each([0, 10_001, Number.MAX_SAFE_INTEGER + 1, 1e100])(
    "rejects legacy accepted quantity %s with zero Required-unit writes",
    (quantity) => {
    const { raw, repo } = fixture();
    const profile = repo.createProfile("Invalid quantity");
    raw.exec(
      `INSERT INTO parts (
        tenant_id, profile_id, match_key, relative_path, filename, source_layer,
        status, role, quantity_auto, quantity_effective, included, notes
      ) VALUES (
        'default', ${profile.id}, 'invalid', 'invalid.stl', 'invalid.stl', 'base',
        'base', 'primary', ${quantity}, ${quantity}, 1, ''
      )`,
    );
    backfillAcceptedPlanRevisions(raw);
    expect(() =>
      backfillCurrentRequiredUnitSets(raw, { tokenFactory: tokenFactory() }),
    ).toThrow(/invalid quantity/i);
    expect(raw.prepare("SELECT count(*) AS count FROM required_units").get()).toEqual({ count: 0 });
    expect(
      raw.prepare("SELECT count(*) AS count FROM plan_revision_required_unit_sets").get(),
    ).toEqual({ count: 0 });
    },
  );

  it("accepts the 10,000-unit boundary", () => {
    const { raw, repo } = fixture();
    const profile = repo.createProfile("Boundary quantity");
    addLivePart({
      raw,
      profileId: profile.id,
      key: "boundary",
      filename: "boundary.stl",
      quantity: MAX_REQUIRED_UNIT_QUANTITY,
      included: true,
    });
    backfillAcceptedPlanRevisions(raw);
    expect(backfillCurrentRequiredUnitSets(raw, { tokenFactory: tokenFactory() })).toMatchObject({
      setsCreated: 1,
      unitsCreated: MAX_REQUIRED_UNIT_QUANTITY,
    });
    expect(raw.prepare("SELECT count(*) AS count FROM required_units").get()).toEqual({
      count: MAX_REQUIRED_UNIT_QUANTITY,
    });
  });

  it("enforces immutable ownership and preserves Build cascade cleanup", () => {
    const { raw, repo } = fixture();
    const profile = repo.createProfile("Owned units");
    addLivePart({
      raw,
      profileId: profile.id,
      key: "owned",
      filename: "owned.stl",
      quantity: 1,
      included: true,
    });
    backfillAcceptedPlanRevisions(raw);
    backfillCurrentRequiredUnitSets(raw, { tokenFactory: tokenFactory() });
    const unit = raw.prepare("SELECT token FROM required_units WHERE profile_id = ?").get(
      profile.id,
    ) as { token: string };
    const revision = raw
      .prepare("SELECT accepted_plan_revision_id AS id FROM build_profiles WHERE id = ?")
      .get(profile.id) as { id: number };

    expect(() =>
      raw.prepare("UPDATE required_units SET object_name = object_name || 'x' WHERE token = ?").run(
        unit.token,
      ),
    ).toThrow(/immutable/i);
    expect(() => raw.prepare("DELETE FROM required_units WHERE token = ?").run(unit.token)).toThrow(
      /immutable/i,
    );
    expect(() =>
      raw
        .prepare(
          `UPDATE plan_revision_required_units SET unit_index = 1
            WHERE revision_id = ?`,
        )
        .run(revision.id),
    ).toThrow(/immutable/i);
    expect(() =>
      raw.prepare("DELETE FROM plan_revision_required_units WHERE revision_id = ?").run(revision.id),
    ).toThrow(/immutable/i);
    expect(() =>
      raw
        .prepare(
          `UPDATE plan_revision_required_unit_sets SET mapping_digest = ?
            WHERE revision_id = ?`,
        )
        .run("f".repeat(64), revision.id),
    ).toThrow(/immutable/i);
    expect(() =>
      raw.prepare("DELETE FROM plan_revision_required_unit_sets WHERE revision_id = ?").run(
        revision.id,
      ),
    ).toThrow(/immutable/i);
    expect(() =>
      raw
        .prepare(
          `INSERT INTO plan_revision_required_units (
            tenant_id, revision_id, revision_part_id, unit_index, required_unit_token
          ) SELECT tenant_id, revision_id, revision_part_id, 1, required_unit_token
              FROM plan_revision_required_units WHERE revision_id = ?`,
        )
        .run(revision.id),
    ).toThrow(/ownership/i);
    expect(() =>
      raw
        .prepare(
          `INSERT INTO required_units (
            token, tenant_id, profile_id, created_in_revision_id, object_name, created_at
          ) VALUES (?, 'other', ?, ?, ?, ?)`,
        )
        .run(
          "ppu_ffffffffffffffffffffffffffffffff",
          profile.id,
          revision.id,
          "other__ppu_ffffffffffffffffffffffffffffffff",
          "2026-08-20T15:00:00.000Z",
        ),
    ).toThrow(/ownership/i);

    expect(() => repo.deleteProfile(profile.id)).not.toThrow();
    for (const table of [
      "required_units",
      "plan_revision_required_units",
      "plan_revision_required_unit_sets",
    ]) {
      expect(raw.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it("rejects partial state and corrupt live assembly state", () => {
    const { raw, repo } = fixture();
    const profile = repo.createProfile("Corruption");
    const livePartId = addLivePart({
      raw,
      profileId: profile.id,
      key: "part",
      filename: "part.stl",
      quantity: 1,
      included: true,
    });
    backfillAcceptedPlanRevisions(raw);
    const revision = raw
      .prepare("SELECT accepted_plan_revision_id AS id FROM build_profiles WHERE id = ?")
      .get(profile.id) as { id: number };
    const revisionPart = raw
      .prepare("SELECT id FROM plan_revision_parts WHERE revision_id = ?")
      .get(revision.id) as { id: number };
    const token = tokenFactory()();
    raw.prepare(
      `INSERT INTO required_units (
        token, tenant_id, profile_id, created_in_revision_id, object_name, created_at
      ) VALUES (?, 'default', ?, ?, ?, ?)`,
    ).run(token, profile.id, revision.id, `part__${token}`, "2026-08-20T12:00:00.000Z");
    raw.prepare(
      `INSERT INTO plan_revision_required_units (
        tenant_id, revision_id, revision_part_id, unit_index, required_unit_token
      ) VALUES ('default', ?, ?, 0, ?)`,
    ).run(revision.id, revisionPart.id, token);
    expect(() => backfillCurrentRequiredUnitSets(raw)).toThrow(/partial/i);
    expect(() => repo.readCurrentRequiredUnitSet(profile.id)).toThrow(/partial/i);

    raw.prepare(
      `INSERT INTO plan_revision_required_unit_sets (
        revision_id, tenant_id, profile_id, format, expected_unit_count, mapping_digest, created_at
      ) VALUES (?, 'default', ?, 'required-unit-map-v1', 1, ?, ?)`,
    ).run(revision.id, profile.id, "0".repeat(64), "2026-08-20T12:00:00.000Z");
    expect(() => repo.readCurrentRequiredUnitSet(profile.id)).toThrow(/digest/i);
    raw.exec("DROP TRIGGER trg_plan_revision_required_unit_sets_immutable_delete");
    raw.prepare("DELETE FROM plan_revision_required_unit_sets WHERE revision_id = ?").run(
      revision.id,
    );
    const digest = digestRequiredUnitMap({
      revisionId: revision.id,
      expectedUnitCount: 1,
      rows: [
        {
          revisionPartId: revisionPart.id,
          unitIndex: 0,
          token,
          objectName: `part__${token}`,
        },
      ],
    });
    raw.prepare(
      `INSERT INTO plan_revision_required_unit_sets (
        revision_id, tenant_id, profile_id, format, expected_unit_count, mapping_digest, created_at
      ) VALUES (?, 'default', ?, 'required-unit-map-v1', 1, ?, ?)`,
    ).run(revision.id, profile.id, digest, "2026-08-20T12:00:00.000Z");
    raw.prepare(
      `INSERT INTO print_progress (tenant_id, part_id, unit_index, completed, assembled)
       VALUES ('default', ?, 0, 0, 1)`,
    ).run(livePartId);
    expect(() => repo.readCurrentRequiredUnitSet(profile.id)).toThrow(/progress/i);
  });

  it("rejects an accepted Part without a compatibility projection", () => {
    const { raw, repo } = fixture();
    const profile = repo.createProfile("Missing projection");
    addLivePart({
      raw,
      profileId: profile.id,
      key: "missing",
      filename: "missing.stl",
      quantity: 1,
      included: true,
    });
    backfillAcceptedPlanRevisions(raw);
    backfillCurrentRequiredUnitSets(raw, { tokenFactory: tokenFactory() });
    const revision = raw
      .prepare("SELECT accepted_plan_revision_id AS id FROM build_profiles WHERE id = ?")
      .get(profile.id) as { id: number };
    raw.exec("DROP TRIGGER trg_plan_revision_parts_immutable_update");
    raw.prepare("UPDATE plan_revision_parts SET projection_part_id = NULL WHERE revision_id = ?").run(
      revision.id,
    );
    expect(() => repo.readCurrentRequiredUnitSet(profile.id)).toThrow(/projection/i);
  });
});
