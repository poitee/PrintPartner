import type Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { backfillAcceptedPlanRevisions } from "./accepted-plan-revisions.js";
import {
  MAX_ACCEPTED_PROGRESS_SUMMARY_BATCH,
  readAcceptedPlanProgressBatch,
  type AcceptedPlanProgressRead,
  type AcceptedPlanProgressSummaryDependencies,
} from "./accepted-plan-progress-summary.js";
import { getDb, SqliteDatabase } from "./client.js";
import type { PostgresDrizzleDb } from "./client-postgres.js";
import { backfillCurrentRequiredUnitSets } from "./required-units.js";
import { AppRepository, type SchemaTables } from "./repository.js";
import * as schema from "./schema.js";
import * as pgSchema from "./schema-pg.js";
import { asSyncDb } from "./sync-db-bridge.js";
import {
  POSTGRES_SYNC_MAX_RESULT_BYTES,
  registerPostgresSyncQuery,
  unregisterPostgresSyncQuery,
} from "./sync-db-bridge.js";
import {
  digestPlanRevisionParts,
  MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES,
} from "../services/plan-publication.js";
import type { AcceptedPlanCorruptionCode } from "./accepted-plan-operational.js";

const roots: string[] = [];
const databases: SqliteDatabase[] = [];
const protectedTables = [
  "build_profiles",
  "parts",
  "plan_accepted_input_sets",
  "plan_revision_input_sets",
  "plan_revision_inputs",
  "plan_revision_parts",
  "plan_revision_required_unit_sets",
  "plan_revision_required_units",
  "plan_revisions",
  "print_progress",
  "required_units",
] as const;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(tenantId = "default") {
  const root = mkdtempSync(join(tmpdir(), "pp-accepted-progress-summary-"));
  roots.push(root);
  const database = new SqliteDatabase(root);
  database.connect();
  databases.push(database);
  return {
    root,
    database,
    raw: (database as unknown as { sqlite: Database.Database }).sqlite,
    repo: new AppRepository(getDb(database), tenantId, database.reposDir),
    tenantId,
  };
}

function addPart(
  context: ReturnType<typeof fixture>,
  profileId: number,
  input: {
    readonly key: string;
    readonly quantity?: number;
    readonly included?: boolean;
  },
): number {
  const quantity = input.quantity ?? 1;
  return Number(
    context.raw
      .prepare(
        `INSERT INTO parts (
          tenant_id, profile_id, match_key, relative_path, filename, source_layer,
          status, role, quantity_auto, quantity_effective, included, notes
        ) VALUES (?, ?, ?, ?, ?, 'base', 'base', 'primary', ?, ?, ?, '')`,
      )
      .run(
        context.tenantId,
        profileId,
        input.key,
        `${input.key}.stl`,
        `${input.key}.stl`,
        quantity,
        quantity,
        input.included === false ? 0 : 1,
      ).lastInsertRowid,
  );
}

function tokenFactory(start = 1) {
  let value = start;
  return () => `ppu_${(value++).toString(16).padStart(32, "0")}`;
}

function acceptCurrentParts(context: ReturnType<typeof fixture>): void {
  backfillAcceptedPlanRevisions(context.raw, "2026-08-21T12:00:00.000Z");
  backfillCurrentRequiredUnitSets(context.raw, {
    now: () => "2026-08-21T12:01:00.000Z",
    tokenFactory: tokenFactory(),
  });
}

function trackedProgressFixture() {
  const context = fixture();
  const source = context.repo.createSource({
    name: "Tracked Progress source",
    url: "https://example.test/tracked-progress",
    source_kind: "github",
  });
  const observed = context.repo.getProjectRow(source.id);
  if (!observed) throw new Error("test Source is missing");
  const locator = `${source.id}/revisions/accepted`;
  const snapshotRoot = join(context.database.reposDir, locator);
  mkdirSync(snapshotRoot, { recursive: true });
  writeFileSync(join(snapshotRoot, "first.stl"), "solid first");
  writeFileSync(join(snapshotRoot, "second.stl"), "solid second");
  const sourceRevision = context.repo.recordSourceRevision({
    sourceId: source.id,
    upstreamRevisionKey: "accepted",
    manifestDigest: "a".repeat(64),
    snapshotLocator: locator,
    syncedAt: "2026-08-21T11:00:00.000Z",
    completeness: "complete",
  });
  context.repo.activateSourceRevision({ sourceId: source.id, revisionId: sourceRevision.id, observed });
  const profile = context.repo.createProfile("Tracked Progress", source.id);
  const created = context.repo.recomputePlanDraft({
    profileId: profile.id,
    actor: "test:user",
    idempotencyKey: "progress-summary-first-draft",
  });
  if (created.kind !== "created") throw new Error("first test draft was not created");
  const reconciled = context.repo.savePlanDraftRequiredUnitReconciliation({
    profileId: profile.id,
    draftId: created.draft.id,
    expectedSnapshotDigest: created.draft.snapshotDigest,
    decisions: [],
    actorId: "test:user",
    idempotencyKey: "progress-summary-first-reconciliation",
  });
  if (reconciled.kind !== "saved") throw new Error("first test reconciliation was not saved");
  const applied = context.repo.applyPlanChanges({
    profileId: profile.id,
    draftId: created.draft.id,
    expectedSnapshotDigest: reconciled.draft.snapshotDigest,
    expectedLifecycleVersion: 0,
    expectedBase: { kind: "empty", planVersion: 0 },
    actorId: "test:user",
    idempotencyKey: "progress-summary-first-apply",
  });
  if (applied.kind !== "applied") throw new Error("first test draft was not applied");
  return { ...context, source, sourceRevision, profile, applied };
}

function dependencies(
  context: ReturnType<typeof fixture>,
): AcceptedPlanProgressSummaryDependencies {
  return {
    db: getDb(context.database),
    schema,
    tenantId: context.tenantId,
    sqlite: true,
  };
}

function read(
  context: ReturnType<typeof fixture>,
  profileIds: readonly number[],
): ReadonlyMap<number, AcceptedPlanProgressRead> {
  return readAcceptedPlanProgressBatch(dependencies(context), profileIds);
}

function snapshot(raw: Database.Database): ReadonlyMap<string, readonly unknown[]> {
  return new Map(
    protectedTables.map((table) => [
      table,
      raw.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    ]),
  );
}

function refreshRevisionDigest(context: ReturnType<typeof fixture>, profileId: number): void {
  const revision = context.repo.getAcceptedPlanRevision(profileId);
  if (!revision) throw new Error("test accepted revision is missing");
  context.raw
    .prepare("UPDATE plan_revisions SET snapshot_digest = ? WHERE id = ?")
    .run(digestPlanRevisionParts(revision.parts), revision.id);
}

function registerSqliteBackedPostgres(
  postgres: PostgresDrizzleDb,
  raw: Database.Database,
  statements: string[],
  responsePayloadBytes: number[] = [],
  hooks: {
    readonly beforeQuery?: (query: string) => void;
    readonly afterQuery?: (query: string, result: { readonly rows: readonly unknown[] }) => void;
  } = {},
): void {
  raw.function("octet_length", (value: unknown) =>
    typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0,
  );
  const booleanColumns = new Set(["included", "geometry_same", "completed", "assembled"]);
  registerPostgresSyncQuery(postgres, ({ sql: query, params, arrayMode }) => {
    statements.push(query);
    hooks.beforeQuery?.(query);
    const orderedParams: unknown[] = [];
    const sqliteQuery = query.replace(/\$(\d+)/g, (_placeholder, index: string) => {
      orderedParams.push(params[Number(index) - 1]);
      return "?";
    });
    const statement = raw.prepare(sqliteQuery);
    const columns = statement.columns();
    const rows = arrayMode
      ? (statement.raw(true).all(...orderedParams) as unknown[][]).map((row) =>
          row.map((value, index) =>
            booleanColumns.has(columns[index]!.name) && value != null ? value === 1 : value,
          ),
        )
      : (statement.all(...orderedParams) as Array<Record<string, unknown>>).map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              booleanColumns.has(key) && value != null ? value === 1 : value,
            ]),
          ),
        );
    const result = { rows, rowCount: rows.length };
    responsePayloadBytes.push(Buffer.byteLength(JSON.stringify({ ok: true, ...result }), "utf8"));
    hooks.afterQuery?.(query, result);
    return result;
  });
}

function postgresDependencies(
  postgres: PostgresDrizzleDb,
): AcceptedPlanProgressSummaryDependencies {
  return {
    db: asSyncDb(postgres),
    schema: pgSchema as unknown as SchemaTables,
    tenantId: "default",
    sqlite: false,
  };
}

function isTerminalIdentityQuery(query: string): boolean {
  const normalized = query.toLowerCase();
  return (
    normalized.includes("accepted_plan_revision_id") &&
    normalized.includes("accepted_plan_version") &&
    normalized.includes("accepted_at") &&
    normalized.includes("mapping_digest")
  );
}

describe("accepted Plan Progress summary batch", () => {
  it("classifies ready, ready-zero, empty, dirty, uninitialized, and missing Plans", () => {
    const context = fixture();
    const ready = context.repo.createProfile("Ready");
    addPart(context, ready.id, { key: "ready", quantity: 3 });
    const readyZero = context.repo.createProfile("Ready zero");
    addPart(context, readyZero.id, { key: "excluded", quantity: 2, included: false });
    acceptCurrentParts(context);
    const uninitialized = context.repo.createProfile("Uninitialized");
    addPart(context, uninitialized.id, { key: "uninitialized" });
    backfillAcceptedPlanRevisions(context.raw, "2026-08-21T12:02:00.000Z");
    const empty = context.repo.createProfile("Empty");
    const dirty = context.repo.createProfile("Dirty");
    addPart(context, dirty.id, { key: "dirty" });

    expect(
      [...read(context, [ready.id, readyZero.id, empty.id, dirty.id, uninitialized.id, 999_999])],
    ).toEqual([
      [ready.id, { kind: "ready", profileId: ready.id, totalUnits: 3, remainingUnits: 3 }],
      [
        readyZero.id,
        { kind: "ready", profileId: readyZero.id, totalUnits: 0, remainingUnits: 0 },
      ],
      [empty.id, { kind: "empty", profileId: empty.id }],
      [
        dirty.id,
        { kind: "unavailable", profileId: dirty.id, reason: "compatibility_dirty" },
      ],
      [
        uninitialized.id,
        { kind: "unavailable", profileId: uninitialized.id, reason: "uninitialized" },
      ],
      [999_999, { kind: "missing", profileId: 999_999 }],
    ]);
  });

  it("does not hide a foreign accepted-input pointer when classifying an owned empty Plan", () => {
    const context = fixture();
    const profile = context.repo.createProfile("Foreign accepted input");
    const inputSetId = Number(
      context.raw
        .prepare(
          `INSERT INTO plan_revision_input_sets (
            tenant_id, profile_id, input_set_digest, expected_input_count,
            format_version, recorded_at, published_at
          ) VALUES ('foreign', ?, ?, 0, 2, '2026-08-21T11:59:00.000Z', '2026-08-21T11:59:00.000Z')`,
        )
        .run(profile.id, "a".repeat(64)).lastInsertRowid,
    );
    context.raw
      .prepare(
        `INSERT INTO plan_accepted_input_sets (tenant_id, profile_id, input_set_id, accepted_at)
         VALUES ('foreign', ?, ?, '2026-08-21T12:00:00.000Z')`,
      )
      .run(profile.id, inputSetId);

    expect(read(context, [profile.id]).get(profile.id)).toEqual({
      kind: "unavailable",
      profileId: profile.id,
      reason: "compatibility_dirty",
    });
  });

  it("attributes Build text integrity per owned Plan and keeps foreign Plans opaque", () => {
    const context = fixture();
    const damaged = context.repo.createProfile("Damaged Build");
    const valid = context.repo.createProfile("Valid Build");
    const foreignRepo = new AppRepository(
      getDb(context.database),
      "foreign",
      context.database.reposDir,
    );
    const foreign = foreignRepo.createProfile("Foreign Build");
    const oversized = "x".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES + 1);
    context.raw.prepare("UPDATE build_profiles SET name = ? WHERE id = ?").run(oversized, damaged.id);
    context.raw.prepare("UPDATE build_profiles SET name = ? WHERE id = ?").run(oversized, foreign.id);

    expect([...read(context, [damaged.id, valid.id, foreign.id])]).toEqual([
      [damaged.id, { kind: "integrity_failure", profileId: damaged.id, code: "pointer" }],
      [valid.id, { kind: "empty", profileId: valid.id }],
      [foreign.id, { kind: "missing", profileId: foreign.id }],
    ]);
  });

  it("keeps accepted totals blind to ordinary draft and Source changes until Apply", () => {
    const context = trackedProgressFixture();
    const acceptedBefore = read(context, [context.profile.id]).get(context.profile.id);
    expect(acceptedBefore).toEqual({
      kind: "ready",
      profileId: context.profile.id,
      totalUnits: 2,
      remainingUnits: 2,
    });
    const created = context.repo.recomputePlanDraft({
      profileId: context.profile.id,
      actor: "test:user",
      idempotencyKey: "progress-summary-next-draft",
    });
    if (created.kind !== "created") throw new Error("next test draft was not created");
    const first = created.draft.parts.find((part) => part.filename === "first.stl");
    const second = created.draft.parts.find((part) => part.filename === "second.stl");
    if (!first || !second) throw new Error("next test draft Parts are missing");
    const quantity = context.repo.editPlanDraftParts({
      profileId: context.profile.id,
      draftId: created.draft.id,
      expectedSnapshotDigest: created.draft.snapshotDigest,
      decision: { kind: "set_quantity_override", partIds: [first.id], value: 3 },
    });
    if (quantity.kind !== "updated") throw new Error("next test quantity was not updated");
    const inclusion = context.repo.editPlanDraftParts({
      profileId: context.profile.id,
      draftId: created.draft.id,
      expectedSnapshotDigest: quantity.draft.snapshotDigest,
      decision: { kind: "set_included", partIds: [second.id], value: false },
    });
    if (inclusion.kind !== "updated") throw new Error("next test inclusion was not updated");
    const workingLocator = `${context.source.id}/revisions/working`;
    const workingRoot = join(context.database.reposDir, workingLocator);
    mkdirSync(workingRoot, { recursive: true });
    writeFileSync(join(workingRoot, "renamed-working.stl"), "solid renamed");
    const workingRevision = context.repo.recordSourceRevision({
      sourceId: context.source.id,
      upstreamRevisionKey: "working",
      manifestDigest: "b".repeat(64),
      snapshotLocator: workingLocator,
      syncedAt: "2026-08-21T12:30:00.000Z",
      completeness: "complete",
    });
    let observed = context.repo.getProjectRow(context.source.id);
    if (!observed) throw new Error("test Source disappeared");
    context.repo.activateSourceRevision({
      sourceId: context.source.id,
      revisionId: workingRevision.id,
      observed,
    });

    expect(read(context, [context.profile.id]).get(context.profile.id)).toEqual(acceptedBefore);

    observed = context.repo.getProjectRow(context.source.id);
    if (!observed) throw new Error("test Source disappeared");
    context.repo.activateSourceRevision({
      sourceId: context.source.id,
      revisionId: context.sourceRevision.id,
      observed,
    });
    const reconciled = context.repo.savePlanDraftRequiredUnitReconciliation({
      profileId: context.profile.id,
      draftId: inclusion.draft.id,
      expectedSnapshotDigest: inclusion.draft.snapshotDigest,
      decisions: [],
      actorId: "test:user",
      idempotencyKey: "progress-summary-next-reconciliation",
    });
    if (reconciled.kind !== "saved") throw new Error("next test reconciliation was not saved");
    const applied = context.repo.applyPlanChanges({
      profileId: context.profile.id,
      draftId: inclusion.draft.id,
      expectedSnapshotDigest: reconciled.draft.snapshotDigest,
      expectedLifecycleVersion: 0,
      expectedBase: {
        kind: "revision",
        revisionId: context.applied.receipt.revisionId,
        planVersion: context.applied.receipt.planVersion,
      },
      actorId: "test:user",
      idempotencyKey: "progress-summary-next-apply",
    });
    expect(applied.kind).toBe("applied");
    expect(read(context, [context.profile.id]).get(context.profile.id)).toEqual({
      kind: "ready",
      profileId: context.profile.id,
      totalUnits: 3,
      remainingUnits: 3,
    });
  });

  it("canonicalizes IDs, rejects invalid IDs and oversized batches, and never writes", () => {
    const context = fixture();
    const profile = context.repo.createProfile("Canonical");
    addPart(context, profile.id, { key: "canonical" });
    acceptCurrentParts(context);
    const before = snapshot(context.raw);

    expect([...read(context, [profile.id, profile.id])]).toEqual([
      [
        profile.id,
        { kind: "ready", profileId: profile.id, totalUnits: 1, remainingUnits: 1 },
      ],
    ]);
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => read(context, [invalid])).toThrowError("positive safe integer");
    }
    expect(() =>
      read(
        context,
        Array.from({ length: MAX_ACCEPTED_PROGRESS_SUMMARY_BATCH + 1 }, (_, index) => index + 1),
      ),
    ).toThrowError(`at most ${MAX_ACCEPTED_PROGRESS_SUMMARY_BATCH}`);
    expect(snapshot(context.raw)).toEqual(before);
  });

  it("treats missing Progress as incomplete and ignores legal surplus without changing it", () => {
    const context = fixture();
    const profile = context.repo.createProfile("Progress");
    const partId = addPart(context, profile.id, { key: "progress", quantity: 2 });
    acceptCurrentParts(context);
    context.raw
      .prepare(
        "INSERT INTO print_progress (tenant_id, part_id, unit_index, completed, assembled) VALUES ('default', ?, 0, 1, 0)",
      )
      .run(partId);
    context.raw
      .prepare(
        "INSERT INTO print_progress (tenant_id, part_id, unit_index, completed, assembled) VALUES ('default', ?, 99, 1, 1)",
      )
      .run(partId);
    const surplusBefore = context.raw
      .prepare("SELECT * FROM print_progress WHERE part_id = ? AND unit_index = 99")
      .get(partId);

    expect(read(context, [profile.id]).get(profile.id)).toEqual({
      kind: "ready",
      profileId: profile.id,
      totalUnits: 2,
      remainingUnits: 1,
    });
    expect(
      context.raw
        .prepare("SELECT * FROM print_progress WHERE part_id = ? AND unit_index = 99")
        .get(partId),
    ).toEqual(surplusBefore);
  });

  it("returns one old SQLite snapshot while a Progress transaction is uncommitted", async () => {
    const context = fixture();
    const profile = context.repo.createProfile("Progress race");
    const partId = addPart(context, profile.id, { key: "race", quantity: 2 });
    acceptCurrentParts(context);
    context.raw
      .prepare(
        `INSERT INTO print_progress (tenant_id, part_id, unit_index, completed, assembled)
         VALUES ('default', ?, 0, 0, 0), ('default', ?, 1, 0, 0)`,
      )
      .run(partId, partId);
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import Database from "better-sqlite3";
const database = new Database(process.argv[1]);
database.pragma("busy_timeout = 5000");
database.exec("BEGIN IMMEDIATE");
database.prepare("UPDATE print_progress SET completed = 1 WHERE part_id = ? AND unit_index = 0").run(Number(process.argv[2]));
process.stdout.write("first-updated\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
database.prepare("UPDATE print_progress SET completed = 1 WHERE part_id = ? AND unit_index = 1").run(Number(process.argv[2]));
database.exec("COMMIT");
database.close();`,
        join(context.root, "print-partner.db"),
        String(partId),
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    if (!child.stdout) throw new Error("Progress race stdout is missing");
    await once(child.stdout, "data");

    expect(read(context, [profile.id]).get(profile.id)).toEqual({
      kind: "ready",
      profileId: profile.id,
      totalUnits: 2,
      remainingUnits: 2,
    });
    const [exitCode] = await once(child, "exit");
    expect(exitCode).toBe(0);
    expect(read(context, [profile.id]).get(profile.id)).toEqual({
      kind: "ready",
      profileId: profile.id,
      totalUnits: 2,
      remainingUnits: 0,
    });
  });

  const stableIntegrityCases: ReadonlyArray<{
    readonly name: string;
    readonly code: AcceptedPlanCorruptionCode;
    readonly mutate: (context: ReturnType<typeof fixture>, profileId: number, partId: number) => void;
  }> = [
    {
      name: "pointer",
      code: "pointer",
      mutate: (context, profileId) => {
        context.raw
          .prepare("UPDATE build_profiles SET accepted_plan_version = 0 WHERE id = ?")
          .run(profileId);
      },
    },
    {
      name: "revision metadata",
      code: "revision",
      mutate: (context, profileId) => {
        context.raw.exec("DROP TRIGGER trg_plan_revisions_immutable_update");
        context.raw
          .prepare(
            "UPDATE plan_revisions SET revision_number = 0 WHERE id = (SELECT accepted_plan_revision_id FROM build_profiles WHERE id = ?)",
          )
          .run(profileId);
      },
    },
    {
      name: "revision digest",
      code: "revision_digest",
      mutate: (context, profileId) => {
        context.raw.exec("DROP TRIGGER trg_plan_revisions_immutable_update");
        context.raw
          .prepare(
            "UPDATE plan_revisions SET snapshot_digest = ? WHERE id = (SELECT accepted_plan_revision_id FROM build_profiles WHERE id = ?)",
          )
          .run("0".repeat(64), profileId);
      },
    },
    {
      name: "projection",
      code: "projection",
      mutate: (context, _profileId, partId) => {
        context.raw.exec("DROP TRIGGER trg_parts_invalidate_accepted_revision_update");
        context.raw.prepare("UPDATE parts SET filename = 'changed.stl' WHERE id = ?").run(partId);
      },
    },
    {
      name: "Required-unit map",
      code: "required_unit_map",
      mutate: (context, profileId) => {
        context.raw.exec("DROP TRIGGER trg_plan_revision_required_units_immutable_delete");
        context.raw
          .prepare(
            "DELETE FROM plan_revision_required_units WHERE revision_id = (SELECT accepted_plan_revision_id FROM build_profiles WHERE id = ?)",
          )
          .run(profileId);
      },
    },
    {
      name: "Progress",
      code: "progress",
      mutate: (context, _profileId, partId) => {
        context.raw
          .prepare(
            "INSERT INTO print_progress (tenant_id, part_id, unit_index, completed, assembled) VALUES ('default', ?, 0, 0, 1)",
          )
          .run(partId);
      },
    },
  ];

  for (const integrityCase of stableIntegrityCases) {
    it(`returns a stable ${integrityCase.name} integrity result`, () => {
      const context = fixture();
      const profile = context.repo.createProfile(`Corrupt ${integrityCase.name}`);
      const partId = addPart(context, profile.id, { key: "corrupt" });
      acceptCurrentParts(context);
      integrityCase.mutate(context, profile.id, partId);

      expect(read(context, [profile.id]).get(profile.id)).toEqual({
        kind: "integrity_failure",
        profileId: profile.id,
        code: integrityCase.code,
      });
    });
  }

  it("keeps a stable valid Plan when another Plan has stable integrity damage", () => {
    const context = fixture();
    const damaged = context.repo.createProfile("Damaged");
    addPart(context, damaged.id, { key: "damaged" });
    const valid = context.repo.createProfile("Valid");
    addPart(context, valid.id, { key: "valid", quantity: 2 });
    acceptCurrentParts(context);
    context.raw.exec("DROP TRIGGER trg_plan_revisions_immutable_update");
    context.raw
      .prepare(
        "UPDATE plan_revisions SET snapshot_digest = ? WHERE id = (SELECT accepted_plan_revision_id FROM build_profiles WHERE id = ?)",
      )
      .run("0".repeat(64), damaged.id);

    expect([...read(context, [damaged.id, valid.id])]).toEqual([
      [
        damaged.id,
        { kind: "integrity_failure", profileId: damaged.id, code: "revision_digest" },
      ],
      [
        valid.id,
        { kind: "ready", profileId: valid.id, totalUnits: 2, remainingUnits: 2 },
      ],
    ]);
  });

  it("isolates an oversized accepted row to its owning Plan", () => {
    const context = fixture();
    const damaged = context.repo.createProfile("Oversized");
    const damagedPartId = addPart(context, damaged.id, { key: "oversized" });
    const valid = context.repo.createProfile("Still valid");
    addPart(context, valid.id, { key: "still-valid" });
    acceptCurrentParts(context);
    const damagedRevisionPartId = Number(
      context.raw
        .prepare(
          `SELECT part.id
             FROM plan_revision_parts part
             JOIN build_profiles profile ON profile.accepted_plan_revision_id = part.revision_id
            WHERE profile.id = ?`,
        )
        .pluck()
        .get(damaged.id),
    );
    const oversized = "x".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES + 1);
    context.raw.exec(
      "DROP TRIGGER trg_plan_revision_parts_immutable_update; DROP TRIGGER trg_parts_invalidate_accepted_revision_update; DROP TRIGGER trg_plan_revisions_immutable_update;",
    );
    context.raw
      .prepare("UPDATE plan_revision_parts SET notes = ? WHERE id = ?")
      .run(oversized, damagedRevisionPartId);
    context.raw.prepare("UPDATE parts SET notes = ? WHERE id = ?").run(oversized, damagedPartId);
    refreshRevisionDigest(context, damaged.id);

    expect([...read(context, [damaged.id, valid.id])]).toEqual([
      [damaged.id, { kind: "integrity_failure", profileId: damaged.id, code: "revision" }],
      [valid.id, { kind: "ready", profileId: valid.id, totalUnits: 1, remainingUnits: 1 }],
    ]);
  });

  it("rejects an accepted input pointer that differs from its accepted revision", () => {
    const context = fixture();
    const profile = context.repo.createProfile("Tracked pointer");
    const insertInputSet = context.raw.prepare(
      `INSERT INTO plan_revision_input_sets (
        tenant_id, profile_id, input_set_digest, expected_input_count,
        format_version, recorded_at, published_at
      ) VALUES ('default', ?, ?, 0, 2, '2026-08-21T11:59:00.000Z', '2026-08-21T11:59:00.000Z')`,
    );
    const acceptedInputSetId = Number(insertInputSet.run(profile.id, "a".repeat(64)).lastInsertRowid);
    context.raw
      .prepare(
        "INSERT INTO plan_accepted_input_sets (tenant_id, profile_id, input_set_id, accepted_at) VALUES ('default', ?, ?, '2026-08-21T12:00:00.000Z')",
      )
      .run(profile.id, acceptedInputSetId);
    acceptCurrentParts(context);
    const differentInputSetId = Number(
      insertInputSet.run(profile.id, "b".repeat(64)).lastInsertRowid,
    );
    context.raw
      .prepare("UPDATE plan_accepted_input_sets SET input_set_id = ? WHERE profile_id = ?")
      .run(differentInputSetId, profile.id);

    expect(read(context, [profile.id]).get(profile.id)).toEqual({
      kind: "integrity_failure",
      profileId: profile.id,
      code: "accepted_inputs",
    });
  });

  it("fails closed for missing, duplicate, foreign, out-of-range, digest, and ownership mapping faults", () => {
    const mutations: ReadonlyArray<(context: ReturnType<typeof fixture>, profileId: number) => void> = [
      (context, profileId) => {
        context.raw.exec("DROP TRIGGER trg_plan_revision_required_units_immutable_delete");
        context.raw
          .prepare(
            "DELETE FROM plan_revision_required_units WHERE revision_id = (SELECT accepted_plan_revision_id FROM build_profiles WHERE id = ?)",
          )
          .run(profileId);
      },
      (context, profileId) => {
        context.raw.exec("DROP TRIGGER trg_plan_revision_required_units_ownership_insert");
        context.raw
          .prepare(
            `INSERT INTO plan_revision_required_units (
              tenant_id, revision_id, revision_part_id, unit_index, required_unit_token
            ) SELECT 'foreign', revision_id, revision_part_id, unit_index, required_unit_token
                FROM plan_revision_required_units
               WHERE revision_id = (SELECT accepted_plan_revision_id FROM build_profiles WHERE id = ?)
               LIMIT 1`,
          )
          .run(profileId);
      },
      (context, profileId) => {
        context.raw.exec("DROP TRIGGER trg_plan_revision_required_units_immutable_update");
        context.raw
          .prepare(
            "UPDATE plan_revision_required_units SET unit_index = 9999 WHERE revision_id = (SELECT accepted_plan_revision_id FROM build_profiles WHERE id = ?)",
          )
          .run(profileId);
      },
      (context, profileId) => {
        context.raw.exec("DROP TRIGGER trg_plan_revision_required_unit_sets_immutable_update");
        context.raw
          .prepare(
            "UPDATE plan_revision_required_unit_sets SET mapping_digest = ? WHERE revision_id = (SELECT accepted_plan_revision_id FROM build_profiles WHERE id = ?)",
          )
          .run("f".repeat(64), profileId);
      },
      (context, profileId) => {
        context.raw.exec("DROP TRIGGER trg_required_units_immutable_update");
        context.raw
          .prepare(
            `UPDATE required_units SET tenant_id = 'foreign'
              WHERE token = (
                SELECT required_unit_token FROM plan_revision_required_units
                 WHERE revision_id = (SELECT accepted_plan_revision_id FROM build_profiles WHERE id = ?)
                 LIMIT 1
              )`,
          )
          .run(profileId);
      },
    ];

    for (const mutate of mutations) {
      const context = fixture();
      const profile = context.repo.createProfile("Mapping fault");
      addPart(context, profile.id, { key: "mapping" });
      acceptCurrentParts(context);
      mutate(context, profile.id);
      expect(read(context, [profile.id]).get(profile.id)).toEqual({
        kind: "integrity_failure",
        profileId: profile.id,
        code: "required_unit_map",
      });
    }
  });

  it("accepts the exact UTF-8 row bound and rejects one extra byte", () => {
    const context = fixture();
    const profile = context.repo.createProfile("Text bound");
    const partId = addPart(context, profile.id, { key: "text" });
    acceptCurrentParts(context);
    const revisionId = Number(
      context.raw
        .prepare("SELECT accepted_plan_revision_id FROM build_profiles WHERE id = ?")
        .pluck()
        .get(profile.id),
    );
    const revisionPartId = Number(
      context.raw
        .prepare("SELECT id FROM plan_revision_parts WHERE revision_id = ?")
        .pluck()
        .get(revisionId),
    );
    const revisionFixed = context.raw
      .prepare(
        `SELECT length(cast(
          tenant_id || part_key || relative_path || filename || source_layer || status ||
          role_inferred || coalesce(role_override, '') || coalesce(filament_color_id, '') ||
          coalesce(filament_custom_hex, '') || coalesce(spoolman_spool_id, '') ||
          coalesce(github_blob_url, '') || coalesce(requirement, '') ||
          coalesce(option_group_id, '') || coalesce(manifest_source, '') ||
          coalesce(artifact_digest, '') AS blob))
         FROM plan_revision_parts WHERE id = ?`,
      )
      .pluck()
      .get(revisionPartId) as number;
    const projectionFixed = context.raw
      .prepare(
        `SELECT length(cast(
          tenant_id || match_key || relative_path || filename || source_layer || status || role ||
          coalesce(filament_color_id, '') || coalesce(filament_custom_hex, '') ||
          coalesce(spoolman_spool_id, '') || coalesce(github_blob_url, '') ||
          coalesce(requirement, '') || coalesce(option_group_id, '') ||
          coalesce(manifest_source, '') AS blob))
         FROM parts WHERE id = ?`,
      )
      .pluck()
      .get(partId) as number;
    expect(projectionFixed).toBe(revisionFixed);
    const notes = "\u0001".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES - revisionFixed);
    context.raw.exec(
      "DROP TRIGGER trg_plan_revision_parts_immutable_update; DROP TRIGGER trg_parts_invalidate_accepted_revision_update; DROP TRIGGER trg_plan_revisions_immutable_update;",
    );
    context.raw.prepare("UPDATE plan_revision_parts SET notes = ? WHERE id = ?").run(notes, revisionPartId);
    context.raw.prepare("UPDATE parts SET notes = ? WHERE id = ?").run(notes, partId);
    refreshRevisionDigest(context, profile.id);

    expect(read(context, [profile.id]).get(profile.id)).toMatchObject({ kind: "ready" });
    context.raw
      .prepare("UPDATE plan_revision_parts SET notes = ? WHERE id = ?")
      .run(`${notes}x`, revisionPartId);
    refreshRevisionDigest(context, profile.id);
    expect(read(context, [profile.id]).get(profile.id)).toEqual({
      kind: "integrity_failure",
      profileId: profile.id,
      code: "revision",
    });
  });

  it("reads 10,001 units through bounded PostgreSQL pages without approaching the bridge cap", () => {
    const context = fixture();
    const profile = context.repo.createProfile("Large summary");
    addPart(context, profile.id, { key: "large-a", quantity: 5_000 });
    addPart(context, profile.id, { key: "large-b", quantity: 5_001 });
    acceptCurrentParts(context);
    const expected = [...read(context, [profile.id])];
    const postgres = drizzle({} as Pool, { schema: pgSchema });
    const statements: string[] = [];
    const payloadBytes: number[] = [];
    registerSqliteBackedPostgres(postgres, context.raw, statements, payloadBytes);
    try {
      expect([...readAcceptedPlanProgressBatch(postgresDependencies(postgres), [profile.id])]).toEqual(
        expected,
      );
      expect(expected[0]?.[1]).toEqual({
        kind: "ready",
        profileId: profile.id,
        totalUnits: 10_001,
        remainingUnits: 10_001,
      });
      expect(
        statements.filter((statement) =>
          statement.toLowerCase().includes('from "plan_revision_required_units"'),
        ).length,
      ).toBeGreaterThan(2);
      expect(Math.max(...payloadBytes)).toBeLessThan(POSTGRES_SYNC_MAX_RESULT_BYTES);
      expect(statements.every((statement) => /^select\b/i.test(statement.trim()))).toBe(true);
    } finally {
      unregisterPostgresSyncQuery(postgres);
    }
  });

  it("bulk-classifies the maximum PostgreSQL batch without per-Plan queries", () => {
    const context = fixture();
    const profileIds = Array.from(
      { length: MAX_ACCEPTED_PROGRESS_SUMMARY_BATCH },
      (_, index) => context.repo.createProfile(`Empty ${index}`).id,
    );
    const postgres = drizzle({} as Pool, { schema: pgSchema });
    const statements: string[] = [];
    registerSqliteBackedPostgres(postgres, context.raw, statements);
    try {
      const results = readAcceptedPlanProgressBatch(postgresDependencies(postgres), profileIds);
      expect([...results.values()]).toEqual(
        profileIds.map((profileId) => ({ kind: "empty", profileId })),
      );
      expect(statements.length).toBeLessThanOrEqual(16);
      expect(statements.every((statement) => /^select\b/i.test(statement.trim()))).toBe(true);
    } finally {
      unregisterPostgresSyncQuery(postgres);
    }
  });

  it("keeps a corrupt maximum PostgreSQL batch on the bounded bulk query path", () => {
    const context = fixture();
    const profileIds = Array.from(
      { length: MAX_ACCEPTED_PROGRESS_SUMMARY_BATCH },
      (_, index) => {
        const profile = context.repo.createProfile(`Ready ${index}`);
        addPart(context, profile.id, { key: `ready-${index}` });
        return profile.id;
      },
    );
    acceptCurrentParts(context);
    const runPostgres = (): { readonly results: readonly AcceptedPlanProgressRead[]; readonly queryCount: number } => {
      const postgres = drizzle({} as Pool, { schema: pgSchema });
      const statements: string[] = [];
      registerSqliteBackedPostgres(postgres, context.raw, statements);
      try {
        return {
          results: [...readAcceptedPlanProgressBatch(postgresDependencies(postgres), profileIds).values()],
          queryCount: statements.length,
        };
      } finally {
        unregisterPostgresSyncQuery(postgres);
      }
    };
    const baseline = runPostgres();
    expect(baseline.results.every((result) => result.kind === "ready")).toBe(true);
    const damagedProfileId = profileIds[0]!;
    const damagedPartId = Number(
      context.raw.prepare("SELECT id FROM parts WHERE profile_id = ?").pluck().get(damagedProfileId),
    );
    const damagedRevisionPartId = Number(
      context.raw
        .prepare(
          `SELECT part.id
             FROM plan_revision_parts part
             JOIN build_profiles profile ON profile.accepted_plan_revision_id = part.revision_id
            WHERE profile.id = ?`,
        )
        .pluck()
        .get(damagedProfileId),
    );
    const oversized = "x".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES + 1);
    context.raw.exec(
      "DROP TRIGGER trg_plan_revision_parts_immutable_update; DROP TRIGGER trg_parts_invalidate_accepted_revision_update; DROP TRIGGER trg_plan_revisions_immutable_update;",
    );
    context.raw
      .prepare("UPDATE plan_revision_parts SET notes = ? WHERE id = ?")
      .run(oversized, damagedRevisionPartId);
    context.raw.prepare("UPDATE parts SET notes = ? WHERE id = ?").run(oversized, damagedPartId);
    refreshRevisionDigest(context, damagedProfileId);

    const damaged = runPostgres();
    expect(damaged.results[0]).toEqual({
      kind: "integrity_failure",
      profileId: damagedProfileId,
      code: "revision",
    });
    expect(damaged.results.slice(1).every((result) => result.kind === "ready")).toBe(true);
    expect(damaged.queryCount).toBeLessThanOrEqual(baseline.queryCount + 4);
  });

  it("retries only a changed PostgreSQL subset and preserves stable Plans", () => {
    const context = fixture();
    const changed = context.repo.createProfile("Changed");
    const stable = context.repo.createProfile("Stable");
    const postgres = drizzle({} as Pool, { schema: pgSchema });
    const statements: string[] = [];
    let terminalReads = 0;
    registerSqliteBackedPostgres(postgres, context.raw, statements, [], {
      beforeQuery: (query) => {
        if (!isTerminalIdentityQuery(query)) return;
        terminalReads += 1;
        if (terminalReads === 2) {
          context.raw
            .prepare("UPDATE build_profiles SET accepted_plan_version = 1 WHERE id = ?")
            .run(changed.id);
        }
      },
    });
    try {
      expect([
        ...readAcceptedPlanProgressBatch(postgresDependencies(postgres), [changed.id, stable.id]),
      ]).toEqual([
        [
          changed.id,
          { kind: "unavailable", profileId: changed.id, reason: "compatibility_dirty" },
        ],
        [stable.id, { kind: "empty", profileId: stable.id }],
      ]);
      expect(terminalReads).toBe(4);
    } finally {
      unregisterPostgresSyncQuery(postgres);
    }
  });

  it("returns concurrent_update after a second PostgreSQL identity change", () => {
    const context = fixture();
    const profile = context.repo.createProfile("Repeated change");
    const postgres = drizzle({} as Pool, { schema: pgSchema });
    const statements: string[] = [];
    let terminalReads = 0;
    registerSqliteBackedPostgres(postgres, context.raw, statements, [], {
      beforeQuery: (query) => {
        if (!isTerminalIdentityQuery(query)) return;
        terminalReads += 1;
        if (terminalReads === 2 || terminalReads === 4) {
          context.raw
            .prepare(
              "UPDATE build_profiles SET accepted_plan_version = accepted_plan_version + 1 WHERE id = ?",
            )
            .run(profile.id);
        }
      },
    });
    try {
      expect(
        readAcceptedPlanProgressBatch(postgresDependencies(postgres), [profile.id]).get(profile.id),
      ).toEqual({ kind: "concurrent_update", profileId: profile.id });
      expect(terminalReads).toBe(4);
    } finally {
      unregisterPostgresSyncQuery(postgres);
    }
  });

  it("keeps a changing foreign PostgreSQL Plan opaque across both identity reads", () => {
    const context = fixture();
    const foreignRepo = new AppRepository(
      getDb(context.database),
      "foreign",
      context.database.reposDir,
    );
    const foreign = foreignRepo.createProfile("Changing foreign Build");
    const postgres = drizzle({} as Pool, { schema: pgSchema });
    const statements: string[] = [];
    let terminalReads = 0;
    registerSqliteBackedPostgres(postgres, context.raw, statements, [], {
      beforeQuery: (query) => {
        if (!isTerminalIdentityQuery(query)) return;
        terminalReads += 1;
        if (terminalReads === 2 || terminalReads === 4) {
          context.raw
            .prepare(
              "UPDATE build_profiles SET accepted_plan_version = accepted_plan_version + 1 WHERE id = ?",
            )
            .run(foreign.id);
        }
      },
    });
    try {
      expect(
        readAcceptedPlanProgressBatch(postgresDependencies(postgres), [foreign.id]).get(foreign.id),
      ).toEqual({ kind: "missing", profileId: foreign.id });
    } finally {
      unregisterPostgresSyncQuery(postgres);
    }
  });

  it("discards transient PostgreSQL integrity when the terminal identity changed", () => {
    const context = fixture();
    const profile = context.repo.createProfile("Transient integrity");
    addPart(context, profile.id, { key: "transient" });
    acceptCurrentParts(context);
    const revisionId = Number(
      context.raw
        .prepare("SELECT accepted_plan_revision_id FROM build_profiles WHERE id = ?")
        .pluck()
        .get(profile.id),
    );
    const digest = String(
      context.raw
        .prepare("SELECT snapshot_digest FROM plan_revisions WHERE id = ?")
        .pluck()
        .get(revisionId),
    );
    context.raw.exec("DROP TRIGGER trg_plan_revisions_immutable_update");
    const postgres = drizzle({} as Pool, { schema: pgSchema });
    const statements: string[] = [];
    let terminalReads = 0;
    registerSqliteBackedPostgres(postgres, context.raw, statements, [], {
      afterQuery: (query) => {
        if (!isTerminalIdentityQuery(query)) return;
        terminalReads += 1;
        if (terminalReads === 1) {
          context.raw
            .prepare("UPDATE plan_revisions SET snapshot_digest = ? WHERE id = ?")
            .run("0".repeat(64), revisionId);
          context.raw
            .prepare(
              "UPDATE build_profiles SET accepted_plan_version = accepted_plan_version + 1 WHERE id = ?",
            )
            .run(profile.id);
        }
        if (terminalReads === 2) {
          context.raw
            .prepare("UPDATE plan_revisions SET snapshot_digest = ? WHERE id = ?")
            .run(digest, revisionId);
        }
      },
    });
    try {
      expect(
        readAcceptedPlanProgressBatch(postgresDependencies(postgres), [profile.id]).get(profile.id),
      ).toEqual({
        kind: "ready",
        profileId: profile.id,
        totalUnits: 1,
        remainingUnits: 1,
      });
      expect(terminalReads).toBe(4);
    } finally {
      unregisterPostgresSyncQuery(postgres);
    }
  });

  it("propagates unexpected PostgreSQL failures instead of reporting Plan integrity", () => {
    const context = fixture();
    const profile = context.repo.createProfile("Unexpected failure");
    const postgres = drizzle({} as Pool, { schema: pgSchema });
    const statements: string[] = [];
    registerSqliteBackedPostgres(postgres, context.raw, statements, [], {
      afterQuery: (query) => {
        if (!isTerminalIdentityQuery(query)) throw new Error("summary database sentinel");
      },
    });
    try {
      expect(() =>
        readAcceptedPlanProgressBatch(postgresDependencies(postgres), [profile.id]),
      ).toThrowError("summary database sentinel");
    } finally {
      unregisterPostgresSyncQuery(postgres);
    }
  });
});
