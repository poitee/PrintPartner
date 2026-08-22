import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { backfillAcceptedPlanRevisions } from "./accepted-plan-revisions.js";
import { getDb, SqliteDatabase } from "./client.js";
import type { PostgresDrizzleDb } from "./client-postgres.js";
import { backfillCurrentRequiredUnitSets } from "./required-units.js";
import {
  AppRepository,
  type SchemaTables,
} from "./repository.js";
import {
  AcceptedPlanOperationalIntegrityError,
  type AcceptedPlanCorruptionCode,
} from "./accepted-plan-operational.js";
import {
  AcceptedOperationalRowTextLimitError,
  digestPlanRevisionParts,
  MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES,
  PLAN_REVISION_DIGEST_FORMAT,
} from "../services/plan-publication.js";
import { digestPlanDraft } from "../services/plan-drafts.js";
import * as pgSchema from "./schema-pg.js";
import {
  POSTGRES_SYNC_MAX_RESULT_BYTES,
  registerPostgresSyncQuery,
  unregisterPostgresSyncQuery,
} from "./sync-db-bridge.js";
import { parseRequiredUnitToken } from "../services/required-units.js";

const roots: string[] = [];
const protectedTables = [
  "app_settings",
  "build_profiles",
  "parts",
  "plan_apply_requests",
  "plan_accepted_input_sets",
  "plan_drafts",
  "plan_revision_input_sets",
  "plan_revision_inputs",
  "plan_revision_parts",
  "plan_revision_required_unit_sets",
  "plan_revision_required_units",
  "plan_revisions",
  "print_progress",
  "profile_layers",
  "projects",
  "required_units",
  "source_revisions",
] as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(tenantId = "default") {
  const root = mkdtempSync(join(tmpdir(), "pp-accepted-operational-"));
  roots.push(root);
  const database = new SqliteDatabase(root);
  database.connect();
  return {
    root,
    database,
    raw: (database as unknown as { sqlite: Database.Database }).sqlite,
    repo: new AppRepository(getDb(database), tenantId, database.reposDir),
  };
}

function addPart(raw: Database.Database, profileId: number): void {
  raw.prepare(
    `INSERT INTO parts (
      tenant_id, profile_id, match_key, relative_path, filename, source_layer,
      status, role, quantity_auto, quantity_effective, included, notes
    ) VALUES ('default', ?, 'part', 'part.stl', 'part.stl', 'base',
      'base', 'primary', 1, 1, 1, '')`,
  ).run(profileId);
}

function tokenFactory(start = 1) {
  let value = start;
  return () => `ppu_${(value++).toString(16).padStart(32, "0")}`;
}

function historicalFormat1Digest(
  rows: readonly { readonly source_revision_id: number; readonly manifest_digest: string }[],
): string {
  const canonical = [...rows].sort(
    (left, right) => left.source_revision_id - right.source_revision_id,
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function utf8Bytes(values: readonly unknown[]): number {
  return values.reduce<number>(
    (total, value) => total + (typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0),
    0,
  );
}

function snapshot(raw: Database.Database) {
  return new Map(
    protectedTables.map((table) => [
      table,
      raw.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    ]),
  );
}

function registerSqliteBackedPostgres(
  postgres: PostgresDrizzleDb,
  raw: Database.Database,
  statements: string[],
  responsePayloadBytes: number[] = [],
): void {
  raw.function("octet_length", (value: unknown) =>
    typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0,
  );
  const booleanColumns = new Set(["included", "geometry_same", "completed", "assembled"]);
  registerPostgresSyncQuery(postgres, ({ sql: query, params, arrayMode }) => {
    statements.push(query);
    const orderedParams: unknown[] = [];
    const sqliteQuery = query.replace(/\$(\d+)/g, (_placeholder, index: string) => {
      orderedParams.push(params[Number(index) - 1]);
      return "?";
    });
    const statement = raw.prepare(sqliteQuery);
    const columns = statement.columns();
    if (arrayMode) {
      const rows = statement.raw(true).all(...orderedParams) as unknown[][];
      const result = {
        rows: rows.map((row) =>
          row.map((value, index) =>
            booleanColumns.has(columns[index]!.name) && value != null ? value === 1 : value,
          ),
        ),
        rowCount: rows.length,
      };
      responsePayloadBytes.push(Buffer.byteLength(JSON.stringify({ ok: true, ...result }), "utf8"));
      return result;
    }
    const rows = statement.all(...orderedParams) as Array<Record<string, unknown>>;
    const result = {
      rows: rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            booleanColumns.has(key) && value != null ? value === 1 : value,
          ]),
        ),
      ),
      rowCount: rows.length,
    };
    responsePayloadBytes.push(Buffer.byteLength(JSON.stringify({ ok: true, ...result }), "utf8"));
    return result;
  });
}

function refreshRevisionDigest(context: ReturnType<typeof trackedApplyFixture>): void {
  const revision = context.repo.getAcceptedPlanRevision(context.profile.id);
  if (!revision) throw new Error("test accepted revision is missing");
  context.raw
    .prepare("UPDATE plan_revisions SET snapshot_digest = ? WHERE id = ?")
    .run(digestPlanRevisionParts(revision.parts), revision.id);
}

function trackedApplyFixture(tenantId = "default") {
  const context = fixture(tenantId);
  const source = context.repo.createSource({
    name: "Tracked operational source",
    url: "https://example.test/tracked-operational",
    source_kind: "github",
  });
  const observed = context.repo.getProjectRow(source.id);
  if (!observed) throw new Error("test Source is missing");
  const locator = `${source.id}/revisions/accepted`;
  const snapshotRoot = join(context.database.reposDir, locator);
  mkdirSync(snapshotRoot, { recursive: true });
  writeFileSync(join(snapshotRoot, "included.stl"), "solid included");
  writeFileSync(join(snapshotRoot, "excluded.stl"), "solid excluded");
  const sourceRevision = context.repo.recordSourceRevision({
    sourceId: source.id,
    upstreamRevisionKey: "accepted",
    manifestDigest: "a".repeat(64),
    snapshotLocator: locator,
    syncedAt: "2026-08-20T12:00:00.000Z",
    completeness: "complete",
  });
  context.repo.activateSourceRevision({ sourceId: source.id, revisionId: sourceRevision.id, observed });
  const profile = context.repo.createProfile("Tracked operational Build", source.id);
  const created = context.repo.recomputePlanDraft({
    profileId: profile.id,
    actor: "test:user",
    idempotencyKey: "accepted-operational-draft",
  });
  if (created.kind !== "created") throw new Error("test draft was not created");
  const excluded = created.draft.parts.find((part) => part.filename === "excluded.stl");
  if (!excluded) throw new Error("test excluded Part is missing");
  const edited = context.repo.editPlanDraftParts({
    profileId: profile.id,
    draftId: created.draft.id,
    expectedSnapshotDigest: created.draft.snapshotDigest,
    decision: { kind: "set_included", partIds: [excluded.id], value: false },
  });
  if (edited.kind !== "updated") throw new Error("test draft was not edited");
  const reconciled = context.repo.savePlanDraftRequiredUnitReconciliation({
    profileId: profile.id,
    draftId: edited.draft.id,
    expectedSnapshotDigest: edited.draft.snapshotDigest,
    decisions: [],
    actorId: "test:user",
    idempotencyKey: "accepted-operational-reconciliation",
  });
  if (reconciled.kind !== "saved") throw new Error("test reconciliation was not saved");
  const applied = context.repo.applyPlanChanges({
    profileId: profile.id,
    draftId: edited.draft.id,
    expectedSnapshotDigest: reconciled.draft.snapshotDigest,
    expectedLifecycleVersion: 0,
    expectedBase: { kind: "empty", planVersion: 0 },
    actorId: "test:user",
    idempotencyKey: "accepted-operational-apply",
  });
  if (applied.kind !== "applied") throw new Error("test draft was not applied");
  return { ...context, profile, source, sourceRevision, snapshotRoot, applied };
}

function nextApplyCommand(context: ReturnType<typeof trackedApplyFixture>) {
  const created = context.repo.recomputePlanDraft({
    profileId: context.profile.id,
    actor: "test:user",
    idempotencyKey: "accepted-operational-next-draft",
  });
  if (created.kind !== "created") throw new Error("next test draft was not created");
  const reconciled = context.repo.savePlanDraftRequiredUnitReconciliation({
    profileId: context.profile.id,
    draftId: created.draft.id,
    expectedSnapshotDigest: created.draft.snapshotDigest,
    decisions: [],
    actorId: "test:user",
    idempotencyKey: "accepted-operational-next-reconciliation",
  });
  if (reconciled.kind !== "saved") throw new Error("next test reconciliation was not saved");
  return {
    profileId: context.profile.id,
    draftId: created.draft.id,
    expectedSnapshotDigest: reconciled.draft.snapshotDigest,
    expectedLifecycleVersion: 0,
    expectedBase: {
      kind: "revision" as const,
      revisionId: context.applied.receipt.revisionId,
      planVersion: context.applied.receipt.planVersion,
    },
    actorId: "test:user",
    idempotencyKey: "accepted-operational-next-apply",
  };
}

describe("accepted Plan operational snapshot", () => {
  it("returns empty for a truly empty accepted Build without writing compatibility state", () => {
    const { database, raw, repo } = fixture();
    const profile = repo.createProfile("Empty accepted Build");
    const before = snapshot(raw);

    expect(repo.readAcceptedPlanOperationalSnapshot(profile.id)).toEqual({ kind: "empty" });
    expect(repo.listParts(profile.id)).toMatchObject({ total: 0 });
    expect(snapshot(raw)).toEqual(before);

    database.close();
  });

  it("reads a finalized empty accepted revision without writing", () => {
    const { database, raw, repo } = fixture();
    const profile = repo.createProfile("Finalized empty Build");
    backfillAcceptedPlanRevisions(raw, "2026-08-20T12:00:00.000Z");
    backfillCurrentRequiredUnitSets(raw, {
      now: () => "2026-08-20T12:01:00.000Z",
      tokenFactory: tokenFactory(150),
    });
    const before = snapshot(raw);

    const result = repo.readAcceptedPlanOperationalSnapshot(profile.id);

    expect(result).toMatchObject({
      kind: "ready",
      snapshot: { parts: [], provenance: { kind: "legacy" } },
    });
    expect(snapshot(raw)).toEqual(before);
    database.close();
  });

  it("distinguishes dirty compatibility state from an uninitialized accepted revision", () => {
    const { database, raw, repo } = fixture();
    const dirty = repo.createProfile("Dirty Build");
    addPart(raw, dirty.id);
    expect(repo.readAcceptedPlanOperationalSnapshot(dirty.id)).toEqual({
      kind: "compatibility_dirty",
    });

    const uninitialized = repo.createProfile("Uninitialized Build");
    addPart(raw, uninitialized.id);
    backfillAcceptedPlanRevisions(raw, "2026-08-20T12:00:00.000Z");
    expect(repo.readAcceptedPlanOperationalSnapshot(uninitialized.id)).toEqual({
      kind: "uninitialized",
    });

    database.close();
  });

  it("rejects accepted history paired with a null version-zero pointer", () => {
    const context = trackedApplyFixture();
    context.raw
      .prepare(
        `UPDATE build_profiles
            SET accepted_plan_revision_id = NULL,
                accepted_plan_version = 0
          WHERE id = ?`,
      )
      .run(context.profile.id);

    expect(() =>
      context.repo.readAcceptedPlanOperationalSnapshot(context.profile.id),
    ).toThrowError(
      expect.objectContaining<Partial<AcceptedPlanOperationalIntegrityError>>({
        code: "pointer",
      }),
    );
    context.database.close();
  });

  it("reads a complete tracked accepted snapshot without materializing missing progress", () => {
    const { database, raw, repo, profile, sourceRevision, snapshotRoot, applied } =
      trackedApplyFixture();
    const missingPartId = raw
      .prepare(
        `SELECT projection_part_id FROM plan_revision_parts
          WHERE revision_id = ? AND filename = 'excluded.stl'`,
      )
      .pluck()
      .get(applied.receipt.revisionId) as number;
    raw.prepare("DELETE FROM print_progress WHERE part_id = ?").run(missingPartId);
    const before = snapshot(raw);

    const result = repo.readAcceptedPlanOperationalSnapshot(profile.id);

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("accepted snapshot is not ready");
    expect(result.snapshot).toMatchObject({
      format: "accepted-plan-operational-v1",
      planVersion: 1,
      revisionId: applied.receipt.revisionId,
      revisionDigest: applied.receipt.revisionDigest,
      provenance: {
        kind: "tracked",
        inputs: [
          {
            trackingKind: "revision",
            sourceRevisionId: sourceRevision.id,
            snapshotRoot,
          },
        ],
      },
    });
    expect(result.snapshot.parts.map((part) => part.filename).sort()).toEqual([
      "excluded.stl",
      "included.stl",
    ]);
    expect(result.snapshot.parts.filter((part) => part.included)).toHaveLength(1);
    expect(result.snapshot.parts.filter((part) => !part.included)).toHaveLength(1);
    expect(result.snapshot.parts.map((part) => part.artifact.kind)).toEqual([
      "tracked",
      "tracked",
    ]);
    expect(result.snapshot.parts.flatMap((part) => part.units)).toHaveLength(2);
    expect(result.snapshot.parts.find((part) => !part.included)?.units).toMatchObject([
      { required: false, completed: false, assembled: false },
    ]);
    expect(result.snapshot.parts.flatMap((part) => part.units).every((unit) =>
      unit.objectName.endsWith(unit.token),
    )).toBe(true);
    expect(repo.readAcceptedPlanOperationalSnapshot(profile.id)).toEqual(result);
    expect(snapshot(raw)).toEqual(before);
    database.close();
  });

  it("reads a complete legacy accepted snapshot with unavailable artifacts", () => {
    const { database, raw, repo } = fixture();
    const profile = repo.createProfile("Legacy accepted Build");
    addPart(raw, profile.id);
    backfillAcceptedPlanRevisions(raw, "2026-08-20T12:00:00.000Z");
    backfillCurrentRequiredUnitSets(raw, {
      now: () => "2026-08-20T12:01:00.000Z",
      tokenFactory: tokenFactory(100),
    });
    const before = snapshot(raw);

    const result = repo.readAcceptedPlanOperationalSnapshot(profile.id);

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("legacy snapshot is not ready");
    expect(result.snapshot.provenance).toEqual({ kind: "legacy" });
    expect(result.snapshot.parts).toMatchObject([
      { projectionPartId: expect.any(Number), artifact: { kind: "unavailable", reason: "legacy" } },
    ]);
    expect(repo.readAcceptedPlanOperationalSnapshot(profile.id)).toEqual(result);
    expect(snapshot(raw)).toEqual(before);
    database.close();
  });

  it("returns uninitialized for a consistent multi-Source format-1 accepted input set", () => {
    const context = trackedApplyFixture();
    const secondSource = context.repo.createSource({
      name: "Second legacy Source",
      url: "https://example.test/second-legacy",
      source_kind: "github",
    });
    const secondRevision = context.repo.recordSourceRevision({
      sourceId: secondSource.id,
      upstreamRevisionKey: "legacy-second",
      manifestDigest: "b".repeat(64),
      snapshotLocator: `${secondSource.id}/revisions/legacy-second`,
      syncedAt: "2026-08-20T12:00:00.000Z",
      completeness: "complete",
    });
    mkdirSync(join(context.database.reposDir, `${secondSource.id}/revisions/legacy-second`), {
      recursive: true,
    });
    const inputSetId = context.raw
      .prepare("SELECT input_set_id FROM plan_accepted_input_sets WHERE profile_id = ?")
      .pluck()
      .get(context.profile.id) as number;
    context.raw
      .prepare(
        "UPDATE plan_revision_input_sets SET format_version = 1, expected_input_count = 2 WHERE profile_id = ?",
      )
      .run(context.profile.id);
    context.raw
      .prepare(
        `UPDATE plan_revision_inputs
            SET source_layer = 'legacy:' || source_id,
                layer_order = 0,
                tracking_kind = 'revision',
                effective_naming_digest = NULL
          WHERE input_set_id = ?`,
      )
      .run(inputSetId);
    context.raw
      .prepare(
        `INSERT INTO plan_revision_inputs (
          tenant_id, input_set_id, source_revision_id, manifest_digest, source_id,
          source_layer, layer_order, tracking_kind, effective_naming_digest
        ) VALUES ('default', ?, ?, ?, ?, ?, 0, 'revision', NULL)`,
      )
      .run(
        inputSetId,
        secondRevision.id,
        "b".repeat(64),
        secondSource.id,
        `legacy:${secondSource.id}`,
      );
    const format1Digest = historicalFormat1Digest(
      context.raw
        .prepare(
          `SELECT source_revision_id, manifest_digest
             FROM plan_revision_inputs
            WHERE input_set_id = ?`,
        )
        .all(inputSetId) as Array<{
        source_revision_id: number;
        manifest_digest: string;
      }>,
    );
    context.raw
      .prepare("UPDATE plan_revision_input_sets SET input_set_digest = ? WHERE id = ?")
      .run(format1Digest, inputSetId);
    const before = snapshot(context.raw);

    expect(context.repo.readAcceptedPlanOperationalSnapshot(context.profile.id)).toEqual({
      kind: "uninitialized",
    });
    expect(snapshot(context.raw)).toEqual(before);

    context.raw
      .prepare("UPDATE plan_revision_input_sets SET input_set_digest = ? WHERE id = ?")
      .run("0".repeat(64), inputSetId);
    expect(() =>
      context.repo.readAcceptedPlanOperationalSnapshot(context.profile.id),
    ).toThrowError(
      expect.objectContaining<Partial<AcceptedPlanOperationalIntegrityError>>({
        code: "accepted_inputs",
      }),
    );
    context.raw
      .prepare("UPDATE plan_revision_input_sets SET input_set_digest = ? WHERE id = ?")
      .run(format1Digest, inputSetId);

    context.raw.prepare("UPDATE source_revisions SET tenant_id = 'foreign' WHERE id = ?").run(
      secondRevision.id,
    );
    expect(() =>
      context.repo.readAcceptedPlanOperationalSnapshot(context.profile.id),
    ).toThrowError(
      expect.objectContaining<Partial<AcceptedPlanOperationalIntegrityError>>({
        code: "source_revision",
      }),
    );

    context.database.close();
  });

  it("ignores and preserves out-of-range v26 progress without writing on reads", () => {
    const context = trackedApplyFixture();
    const partId = context.raw
      .prepare("SELECT id FROM parts WHERE profile_id = ? ORDER BY id LIMIT 1")
      .pluck()
      .get(context.profile.id) as number;
    context.raw
      .prepare(
        `INSERT INTO print_progress (tenant_id, part_id, unit_index, completed, assembled)
         VALUES ('foreign', ?, 99, 2, 2)`,
      )
      .run(partId);
    const before = snapshot(context.raw);

    const result = context.repo.readAcceptedPlanOperationalSnapshot(context.profile.id);

    expect(result.kind).toBe("ready");
    expect(snapshot(context.raw)).toEqual(before);
    expect(
      context.raw
        .prepare("SELECT completed, assembled FROM print_progress WHERE part_id = ? AND unit_index = 99")
        .get(partId),
    ).toEqual({ completed: 2, assembled: 2 });
    context.database.close();
  });

  it("does not follow mutable working Source state after acceptance", () => {
    const context = trackedApplyFixture();
    const acceptedBefore = context.repo.readAcceptedPlanOperationalSnapshot(context.profile.id);
    const observed = context.repo.getProjectRow(context.source.id);
    if (!observed) throw new Error("test Source is missing");
    const newer = context.repo.recordSourceRevision({
      sourceId: context.source.id,
      upstreamRevisionKey: "newer-working",
      manifestDigest: "b".repeat(64),
      snapshotLocator: `${context.source.id}/revisions/newer-working`,
      syncedAt: "2026-08-20T14:00:00.000Z",
      completeness: "complete",
    });
    context.repo.activateSourceRevision({
      sourceId: context.source.id,
      revisionId: newer.id,
      observed,
    });
    context.raw
      .prepare(
        `UPDATE projects
            SET name = 'Renamed working Source', local_path = '/tmp/moved', metadata_json = '{}'
          WHERE id = ?`,
      )
      .run(context.source.id);
    const working = context.repo.readWorkingPlanSources(context.profile.id);
    if (!working) throw new Error("test working Source selection is missing");
    expect(
      context.repo.replaceWorkingPlanSources({
        profileId: context.profile.id,
        expectedDigest: working.digest,
        sources: [],
      }),
    ).toMatchObject({ kind: "updated" });
    const protectedBeforeRead = snapshot(context.raw);

    expect(context.repo.readAcceptedPlanOperationalSnapshot(context.profile.id)).toEqual(
      acceptedBefore,
    );
    expect(snapshot(context.raw)).toEqual(protectedBeforeRead);
    context.database.close();
  });

  it("keeps WAL instrumentation and the raw loader out of the production API", () => {
    const source = readFileSync(
      new URL("./accepted-plan-operational.ts", import.meta.url),
      "utf8",
    );
    const exportedFunctions = [...source.matchAll(/export function (\w+)/g)].map(
      (match) => match[1],
    );

    expect(source).not.toContain("afterProfileRead");
    expect(exportedFunctions).toEqual([
      "projectionPlanningFieldsMatch",
      "readAcceptedPlanOperationalSnapshotInternal",
    ]);
  });

  const corruptionCases: readonly {
    readonly name: string;
    readonly code: AcceptedPlanCorruptionCode;
    readonly mutate: (context: ReturnType<typeof trackedApplyFixture>) => void;
  }[] = [
    {
      name: "pointer version",
      code: "pointer",
      mutate: ({ raw, profile }) => {
        raw.prepare("UPDATE build_profiles SET accepted_plan_version = 0 WHERE id = ?").run(profile.id);
      },
    },
    {
      name: "revision ownership",
      code: "revision",
      mutate: ({ raw, applied }) => {
        raw.exec("DROP TRIGGER trg_plan_revisions_immutable_update");
        raw.prepare("UPDATE plan_revisions SET tenant_id = 'foreign' WHERE id = ?").run(
          applied.receipt.revisionId,
        );
      },
    },
    {
      name: "revision digest",
      code: "revision_digest",
      mutate: ({ raw, applied }) => {
        raw.exec("DROP TRIGGER trg_plan_revisions_immutable_update");
        raw.prepare("UPDATE plan_revisions SET snapshot_digest = ? WHERE id = ?").run(
          "0".repeat(64),
          applied.receipt.revisionId,
        );
      },
    },
    {
      name: "accepted input digest",
      code: "accepted_inputs",
      mutate: ({ raw, profile }) => {
        raw.prepare("UPDATE plan_revision_input_sets SET input_set_digest = ? WHERE profile_id = ?").run(
          "0".repeat(64),
          profile.id,
        );
      },
    },
    {
      name: "accepted input selection timestamp",
      code: "accepted_inputs",
      mutate: ({ raw, profile }) => {
        raw.prepare("UPDATE plan_accepted_input_sets SET accepted_at = ? WHERE profile_id = ?").run(
          "2026-08-20T12:30:00.000Z",
          profile.id,
        );
      },
    },
    {
      name: "Source revision manifest",
      code: "source_revision",
      mutate: ({ raw, sourceRevision }) => {
        raw.prepare("UPDATE source_revisions SET manifest_digest = ? WHERE id = ?").run(
          "0".repeat(64),
          sourceRevision.id,
        );
      },
    },
    {
      name: "Source revision completeness",
      code: "source_revision",
      mutate: ({ raw, sourceRevision }) => {
        raw.exec("PRAGMA ignore_check_constraints = ON");
        raw.prepare("UPDATE source_revisions SET completeness = 'partial' WHERE id = ?").run(
          sourceRevision.id,
        );
      },
    },
    {
      name: "Source revision ownership",
      code: "source_revision",
      mutate: ({ raw, sourceRevision }) => {
        raw.prepare("UPDATE source_revisions SET tenant_id = 'foreign' WHERE id = ?").run(
          sourceRevision.id,
        );
      },
    },
    {
      name: "Source revision locator",
      code: "source_revision",
      mutate: ({ raw, sourceRevision }) => {
        raw.prepare("UPDATE source_revisions SET snapshot_locator = '../escape' WHERE id = ?").run(
          sourceRevision.id,
        );
      },
    },
    {
      name: "projection parity",
      code: "projection",
      mutate: ({ raw, profile }) => {
        raw.exec("DROP TRIGGER trg_parts_invalidate_accepted_revision_update");
        raw.prepare("UPDATE parts SET notes = 'changed' WHERE profile_id = ?").run(profile.id);
      },
    },
    {
      name: "Required-unit digest",
      code: "required_unit_map",
      mutate: ({ raw, applied }) => {
        raw.exec("DROP TRIGGER trg_plan_revision_required_unit_sets_immutable_update");
        raw.prepare(
          "UPDATE plan_revision_required_unit_sets SET mapping_digest = ? WHERE revision_id = ?",
        ).run("0".repeat(64), applied.receipt.revisionId);
      },
    },
    {
      name: "Required-unit orphan",
      code: "required_unit_map",
      mutate: ({ raw, profile, applied }) => {
        const token = "ppu_ffffffffffffffffffffffffffffffff";
        raw.prepare(
          `INSERT INTO required_units (
            token, tenant_id, profile_id, created_in_revision_id, object_name, created_at
          ) VALUES (?, 'default', ?, ?, ?, '2026-08-20T13:00:00.000Z')`,
        ).run(token, profile.id, applied.receipt.revisionId, `orphan__${token}`);
      },
    },
    {
      name: "Required-unit Object name syntax",
      code: "required_unit_map",
      mutate: ({ raw, applied }) => {
        raw.exec("DROP TRIGGER trg_required_units_immutable_update");
        raw.prepare(
          `UPDATE required_units
              SET object_name = 'bad' || char(9) || '__' || token
            WHERE created_in_revision_id = ?`,
        ).run(applied.receipt.revisionId);
      },
    },
    {
      name: "Required-unit token syntax",
      code: "required_unit_map",
      mutate: ({ raw, applied }) => {
        const invalidToken = `ppu_${"g".repeat(32)}`;
        const token = raw
          .prepare(
            `SELECT required_unit_token
               FROM plan_revision_required_units
              WHERE revision_id = ?
              ORDER BY unit_index
              LIMIT 1`,
          )
          .pluck()
          .get(applied.receipt.revisionId) as string;
        raw.pragma("foreign_keys = OFF");
        raw.pragma("ignore_check_constraints = ON");
        raw.exec("DROP TRIGGER trg_required_units_immutable_update");
        raw.exec("DROP TRIGGER trg_plan_revision_required_units_immutable_update");
        raw.prepare(
          `UPDATE plan_revision_required_units
              SET required_unit_token = ?
            WHERE revision_id = ? AND required_unit_token = ?`,
        ).run(invalidToken, applied.receipt.revisionId, token);
        raw.prepare(
          `UPDATE required_units
              SET token = ?,
                  object_name = substr(object_name, 1, length(object_name) - length(token)) || ?
            WHERE token = ?`,
        ).run(invalidToken, invalidToken, token);
      },
    },
    {
      name: "in-range progress state",
      code: "progress",
      mutate: ({ raw, profile }) => {
        const partId = raw
          .prepare("SELECT id FROM parts WHERE profile_id = ? ORDER BY id LIMIT 1")
          .pluck()
          .get(profile.id) as number;
        raw.prepare(
          "UPDATE print_progress SET completed = 0, assembled = 1 WHERE part_id = ? AND unit_index = 0",
        ).run(partId);
      },
    },
    {
      name: "in-range progress ownership",
      code: "progress",
      mutate: ({ raw, profile }) => {
        const partId = raw
          .prepare("SELECT id FROM parts WHERE profile_id = ? ORDER BY id LIMIT 1")
          .pluck()
          .get(profile.id) as number;
        raw.prepare(
          "UPDATE print_progress SET tenant_id = 'foreign' WHERE part_id = ? AND unit_index = 0",
        ).run(partId);
      },
    },
    {
      name: "tracked artifact digest",
      code: "artifact_linkage",
      mutate: (context) => {
        context.raw.exec("DROP TRIGGER trg_plan_revision_parts_immutable_update");
        context.raw.exec("DROP TRIGGER trg_plan_revisions_immutable_update");
        context.raw
          .prepare("UPDATE plan_revision_parts SET artifact_digest = NULL WHERE revision_id = ?")
          .run(context.applied.receipt.revisionId);
        refreshRevisionDigest(context);
      },
    },
  ];

  for (const scenario of corruptionCases) {
    it(`rejects ${scenario.name} corruption with no read-time writes`, () => {
      const context = trackedApplyFixture();
      scenario.mutate(context);
      const before = snapshot(context.raw);

      let thrown: unknown;
      try {
        context.repo.readAcceptedPlanOperationalSnapshot(context.profile.id);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AcceptedPlanOperationalIntegrityError);
      expect((thrown as AcceptedPlanOperationalIntegrityError).code).toBe(scenario.code);
      expect(snapshot(context.raw)).toEqual(before);
      context.database.close();
    });
  }

  for (const physicalId of [0, -1]) {
    it(`rejects accepted revision Part physical ID ${physicalId}`, () => {
      const context = trackedApplyFixture();
      context.raw.pragma("foreign_keys = OFF");
      context.raw.exec("DROP TRIGGER trg_plan_revision_parts_immutable_update");
      context.raw
        .prepare("UPDATE plan_revision_parts SET id = ? WHERE revision_id = ? AND included = 1")
        .run(physicalId, context.applied.receipt.revisionId);

      expect(() => context.repo.readAcceptedPlanOperationalSnapshot(context.profile.id)).toThrowError(
        expect.objectContaining<Partial<AcceptedPlanOperationalIntegrityError>>({ code: "revision" }),
      );
      context.database.close();
    });
  }

  for (const physicalId of [0, -1]) {
    it(`reads accepted progress with physical ID ${physicalId}`, () => {
      const context = trackedApplyFixture();
      const progress = context.raw
        .prepare("SELECT id FROM print_progress ORDER BY id LIMIT 1")
        .get() as { id: number };
      context.raw
        .prepare("UPDATE print_progress SET id = ?, completed = 1 WHERE id = ?")
        .run(physicalId, progress.id);

      const result = context.repo.readAcceptedPlanOperationalSnapshot(context.profile.id);

      expect(result.kind).toBe("ready");
      if (result.kind !== "ready") throw new Error("accepted snapshot is not ready");
      expect(result.snapshot.parts.flatMap((part) => part.units).some((unit) => unit.completed)).toBe(
        true,
      );
      context.database.close();
    });
  }

  const projectionParityChanges = [
    ["match_key", "changed-key"],
    ["relative_path", "changed/path.stl"],
    ["filename", "changed.stl"],
    ["source_layer", "changed-layer"],
    ["status", "changed-status"],
    ["role", "changed-role"],
    ["quantity_auto", 2],
    ["quantity_override", 2],
    ["quantity_effective", 2],
    ["included", 0],
    ["notes", "changed-notes"],
    ["github_blob_url", "https://example.test/changed"],
    ["geometry_same", 1],
    ["requirement", "changed-requirement"],
    ["option_group_id", "changed-option"],
    ["manifest_source", "changed-manifest"],
  ] as const;

  for (const [column, value] of projectionParityChanges) {
    it(`rejects projection ${column} divergence`, () => {
      const context = trackedApplyFixture();
      context.raw.exec("DROP TRIGGER trg_parts_invalidate_accepted_revision_update");
      context.raw
        .prepare(`UPDATE parts SET ${column} = ? WHERE profile_id = ?`)
        .run(value, context.profile.id);

      expect(() =>
        context.repo.readAcceptedPlanOperationalSnapshot(context.profile.id),
      ).toThrowError(
        expect.objectContaining<Partial<AcceptedPlanOperationalIntegrityError>>({
          code: "projection",
        }),
      );
      context.database.close();
    });
  }

  it("overlays live filament without treating it as projection corruption", () => {
    const context = trackedApplyFixture();
    context.raw.exec("DROP TRIGGER trg_parts_invalidate_accepted_revision_update");
    context.raw
      .prepare(
        `UPDATE parts
            SET filament_color_id = 'pla-black',
                filament_custom_hex = NULL,
                spoolman_spool_id = 'spoolman:1'
          WHERE profile_id = ?`,
      )
      .run(context.profile.id);

    const accepted = context.repo.readAcceptedPlanOperationalSnapshot(context.profile.id);
    expect(accepted.kind).toBe("ready");
    if (accepted.kind !== "ready") throw new Error("accepted snapshot is not ready");
    expect(accepted.snapshot.parts[0]?.filamentColorId).toBe("pla-black");
    expect(accepted.snapshot.parts[0]?.spoolmanSpoolId).toBe("spoolman:1");
    context.database.close();
  });

  const revisionDigestChanges = [
    ["part_key", "changed-key"],
    ["relative_path", "changed/path.stl"],
    ["filename", "changed.stl"],
    ["source_layer", "changed-layer"],
    ["status", "changed-status"],
    ["role_inferred", "changed-role"],
    ["role_override", "changed-override"],
    ["filament_color_id", "changed-color"],
    ["filament_custom_hex", "#123456"],
    ["spoolman_spool_id", "spoolman:1"],
    ["quantity_inferred", 2],
    ["quantity_override", 2],
    ["quantity_effective", 2],
    ["included", 0],
    ["notes", "changed-notes"],
    ["github_blob_url", "https://example.test/changed"],
    ["geometry_same", 1],
    ["requirement", "changed-requirement"],
    ["option_group_id", "changed-option"],
    ["manifest_source", "changed-manifest"],
    ["artifact_digest", "0".repeat(64)],
  ] as const;

  for (const [column, value] of revisionDigestChanges) {
    it(`rejects revision digest divergence in ${column}`, () => {
      const context = trackedApplyFixture();
      context.raw.exec("DROP TRIGGER trg_plan_revision_parts_immutable_update");
      context.raw
        .prepare(`UPDATE plan_revision_parts SET ${column} = ? WHERE revision_id = ?`)
        .run(value, context.applied.receipt.revisionId);

      expect(() =>
        context.repo.readAcceptedPlanOperationalSnapshot(context.profile.id),
      ).toThrowError(
        expect.objectContaining<Partial<AcceptedPlanOperationalIntegrityError>>({
          code: "revision_digest",
        }),
      );
      context.database.close();
    });
  }

  it("returns the complete old WAL snapshot when Apply commits after the header read", () => {
    const context = trackedApplyFixture();
    const command = nextApplyCommand(context);
    const secondDatabase = new SqliteDatabase(context.root);
    secondDatabase.connect();
    const secondRepo = new AppRepository(
      getDb(secondDatabase),
      "default",
      secondDatabase.reposDir,
    );
    let applyKind: string | null = null;
    let barrierUsed = false;
    const nativeTransaction = context.repo.transaction.bind(context.repo);
    context.repo.transaction = <T>(
      fn: () => T,
      behavior: "deferred" | "immediate" = "deferred",
    ): T =>
      nativeTransaction(() => {
        if (!barrierUsed) {
          barrierUsed = true;
          context.raw
            .prepare("SELECT id FROM build_profiles WHERE id = ?")
            .get(context.profile.id);
          const applied = secondRepo.applyPlanChanges(command);
          applyKind = applied.kind;
        }
        return fn();
      }, behavior);

    const old = context.repo.readAcceptedPlanOperationalSnapshot(context.profile.id);

    expect(applyKind).toBe("applied");
    expect(old).toMatchObject({ kind: "ready", snapshot: { planVersion: 1 } });
    expect(context.repo.readAcceptedPlanOperationalSnapshot(context.profile.id)).toMatchObject({
      kind: "ready",
      snapshot: { planVersion: 2 },
    });
    secondDatabase.close();
    context.database.close();
  });

  it("returns the old committed WAL snapshot while Apply publication is uncommitted", () => {
    const context = trackedApplyFixture();
    const command = nextApplyCommand(context);
    const secondDatabase = new SqliteDatabase(context.root);
    secondDatabase.connect();
    const secondRepo = new AppRepository(
      getDb(secondDatabase),
      "default",
      secondDatabase.reposDir,
    );
    const nativeAcceptedRead = secondRepo.getAcceptedPlanRevision.bind(secondRepo);
    let acceptedReads = 0;
    let concurrentRead: ReturnType<AppRepository["readAcceptedPlanOperationalSnapshot"]> | null =
      null;
    secondRepo.getAcceptedPlanRevision = (profileId: number) => {
      acceptedReads += 1;
      if (acceptedReads === 2) {
        concurrentRead = context.repo.readAcceptedPlanOperationalSnapshot(profileId);
      }
      return nativeAcceptedRead(profileId);
    };

    expect(secondRepo.applyPlanChanges(command)).toMatchObject({ kind: "applied" });
    expect(concurrentRead).toMatchObject({ kind: "ready", snapshot: { planVersion: 1 } });
    expect(context.repo.readAcceptedPlanOperationalSnapshot(context.profile.id)).toMatchObject({
      kind: "ready",
      snapshot: { planVersion: 2 },
    });
    secondDatabase.close();
    context.database.close();
  });

  it("verifies a stable PostgreSQL terminal identity without writes", () => {
    const postgres = drizzle({} as Pool, { schema: pgSchema });
    const statements: string[] = [];
    let terminalReads = 0;
    let mutationRejected = false;
    const expected = {
      profileId: 1,
      planVersion: 1,
      revisionId: 1,
      revisionDigest: "a".repeat(64),
      requiredUnitMappingDigest: "b".repeat(64),
    };
    const token = parseRequiredUnitToken("ppu_00000000000000000000000000000001");
    const holder: { repo?: AppRepository } = {};
    registerPostgresSyncQuery(postgres, ({ sql: query }) => {
      statements.push(query);
      const normalized = query.toLowerCase();
      if (normalized.includes('left join "plan_accepted_input_sets"')) {
        terminalReads += 1;
        if (terminalReads === 1) {
          expect(
            holder.repo?.setAcceptedUnitCompletion({ expected, token, completed: true }),
          ).toEqual({ kind: "transaction_unavailable" });
          mutationRejected = true;
        }
        return { rows: [[null, 0, null, null, null]], rowCount: 1 };
      }
      if (normalized.includes('from "build_profiles"')) {
        return {
          rows: [[1, "default", "PostgreSQL empty", null, null, null, null, null, null, null, 0]],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const repo = new AppRepository(
      postgres,
      "default",
      "/tmp/unused-accepted-operational",
      pgSchema as unknown as SchemaTables,
    );
    holder.repo = repo;
    try {
      expect(repo.readAcceptedPlanOperationalSnapshot(1)).toEqual({ kind: "empty" });
      expect(mutationRejected).toBe(true);
      expect(terminalReads).toBe(2);
      expect(statements.length).toBeGreaterThan(2);
      expect(statements.every((statement) => /^select\b/i.test(statement.trim()))).toBe(true);
    } finally {
      unregisterPostgresSyncQuery(postgres);
    }
  });

  it("discards a changed PostgreSQL aggregate and reruns once from the new identity", () => {
    const postgres = drizzle({} as Pool, { schema: pgSchema });
    const statements: string[] = [];
    let terminalReads = 0;
    registerPostgresSyncQuery(postgres, ({ sql: query }) => {
      statements.push(query);
      const normalized = query.toLowerCase();
      if (normalized.includes('left join "plan_accepted_input_sets"')) {
        terminalReads += 1;
        const version = terminalReads === 1 ? 0 : 1;
        return { rows: [[null, version, null, null, null]], rowCount: 1 };
      }
      if (normalized.includes('from "build_profiles"')) {
        const version = terminalReads < 2 ? 0 : 1;
        return {
          rows: [[1, "default", "PostgreSQL changed", null, null, null, null, null, null, null, version]],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const repo = new AppRepository(
      postgres,
      "default",
      "/tmp/unused-accepted-operational",
      pgSchema as unknown as SchemaTables,
    );
    try {
      expect(repo.readAcceptedPlanOperationalSnapshot(1)).toEqual({
        kind: "compatibility_dirty",
      });
      expect(terminalReads).toBe(4);
      expect(statements.every((statement) => /^select\b/i.test(statement.trim()))).toBe(true);
    } finally {
      unregisterPostgresSyncQuery(postgres);
    }
  });

  it("fails closed before any PostgreSQL query for accepted progress mutations", () => {
    const postgres = drizzle({} as Pool, { schema: pgSchema });
    const statements: string[] = [];
    registerPostgresSyncQuery(postgres, ({ sql: query }) => {
      statements.push(query);
      if (query.toLowerCase().includes('from "build_profiles"')) {
        return { rows: [[1]], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const repo = new AppRepository(
      postgres,
      "default",
      "/tmp/unused-accepted-operational",
      pgSchema as unknown as SchemaTables,
    );
    try {
      const expected = {
        profileId: 1,
        planVersion: 1,
        revisionId: 1,
        revisionDigest: "a".repeat(64),
        requiredUnitMappingDigest: "b".repeat(64),
      };
      const token = parseRequiredUnitToken("ppu_00000000000000000000000000000001");
      expect(repo.setAcceptedUnitCompletion({ expected, token, completed: true })).toEqual({
        kind: "transaction_unavailable",
      });
      expect(repo.setAcceptedUnitAssembly({ expected, token, assembled: true })).toEqual({
        kind: "transaction_unavailable",
      });
      expect(repo.archiveAcceptedPlan({ expected })).toEqual({ kind: "transaction_unavailable" });
      expect(
        repo.verifyAcceptedPrint({
          expected,
          linkId: "link-1",
          expectedLink: {
            id: "link-1",
            profile_id: 1,
            integration_id: "integration-1",
            printer_id: "printer-1",
            host_name: "Printer",
            filename: "plate.gcode",
            units: [{ part_id: 1, unit_index: 0 }],
            state: "awaiting_verify",
            saw_active: true,
            created_at: "2026-08-21T00:00:00.000Z",
          },
          decisions: [{ token, result: "confirmed" }],
        }),
      ).toEqual({ kind: "transaction_unavailable" });
      expect(statements).toEqual([]);
    } finally {
      unregisterPostgresSyncQuery(postgres);
    }
  });

  it("rejects oversized accepted Part text through PostgreSQL preflight", () => {
    const context = trackedApplyFixture();
    context.raw.exec("DROP TRIGGER trg_plan_revision_parts_immutable_update");
    context.raw.exec("DROP TRIGGER trg_plan_revisions_immutable_update");
    context.raw.exec("DROP TRIGGER trg_parts_invalidate_accepted_revision_update");
    context.raw
      .prepare("UPDATE plan_revision_parts SET notes = ? WHERE revision_id = ?")
      .run("x".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES + 1), context.applied.receipt.revisionId);
    context.raw
      .prepare("UPDATE parts SET notes = ? WHERE profile_id = ?")
      .run("x".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES + 1), context.profile.id);
    refreshRevisionDigest(context);
    const before = snapshot(context.raw);
    const postgres = drizzle({} as Pool, { schema: pgSchema });
    const statements: string[] = [];
    registerSqliteBackedPostgres(postgres, context.raw, statements);
    const repo = new AppRepository(
      postgres,
      "default",
      context.database.reposDir,
      pgSchema as unknown as SchemaTables,
    );
    try {
      expect(() => repo.readAcceptedPlanOperationalSnapshot(context.profile.id)).toThrowError(
        expect.objectContaining<Partial<AcceptedPlanOperationalIntegrityError>>({
          code: "revision",
        }),
      );
      expect(statements.some((statement) => statement.includes("octet_length"))).toBe(true);
      expect(snapshot(context.raw)).toEqual(before);
    } finally {
      unregisterPostgresSyncQuery(postgres);
      context.database.close();
    }
  });

  it("accepts an accepted revision Part at the exact UTF-8 row limit", () => {
    const context = trackedApplyFixture();
    const row = context.raw
      .prepare("SELECT * FROM plan_revision_parts WHERE revision_id = ? ORDER BY id LIMIT 1")
      .get(context.applied.receipt.revisionId) as Record<string, unknown>;
    const fixedBytes = utf8Bytes(
      Object.entries(row)
        .filter(([key]) => key !== "notes")
        .map(([, value]) => value),
    );
    const notes = "x".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES - fixedBytes);
    context.raw.exec("DROP TRIGGER trg_plan_revision_parts_immutable_update");
    context.raw.exec("DROP TRIGGER trg_plan_revisions_immutable_update");
    context.raw.exec("DROP TRIGGER trg_parts_invalidate_accepted_revision_update");
    context.raw
      .prepare("UPDATE plan_revision_parts SET notes = ? WHERE id = ?")
      .run(notes, row.id);
    context.raw.prepare("UPDATE parts SET notes = ? WHERE id = ?").run(notes, row.projection_part_id);
    refreshRevisionDigest(context);

    expect(context.repo.readAcceptedPlanOperationalSnapshot(context.profile.id)).toMatchObject({
      kind: "ready",
    });
    context.database.close();
  });

  it("reads a variable-text page boundary plus one deterministically", () => {
    const context = fixture();
    const profile = context.repo.createProfile("Text page boundary Build");
    const insertPart = context.raw.prepare(
      `INSERT INTO parts (
        tenant_id, profile_id, match_key, relative_path, filename, source_layer,
        status, role, quantity_auto, quantity_effective, included, notes
      ) VALUES ('default', ?, ?, ?, ?, 'base', 'base', 'primary', 1, 1, 1, '')`,
    );
    for (let index = 0; index < 33; index += 1) {
      const filename = `boundary-${index.toString().padStart(2, "0")}.stl`;
      insertPart.run(profile.id, filename, filename, filename);
    }
    backfillAcceptedPlanRevisions(context.raw, "2026-08-20T12:00:00.000Z");
    backfillCurrentRequiredUnitSets(context.raw, {
      now: () => "2026-08-20T12:01:00.000Z",
      tokenFactory: tokenFactory(10_000),
    });

    const result = context.repo.readAcceptedPlanOperationalSnapshot(profile.id);

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("boundary accepted snapshot is not ready");
    expect(result.snapshot.parts).toHaveLength(33);
    expect(result.snapshot.parts.flatMap((part) => part.units)).toHaveLength(33);
    context.database.close();
  });

  it("rejects a foreign-tenant duplicate Required-unit mapping after a full narrow page", () => {
    const context = fixture();
    const profile = context.repo.createProfile("Foreign mapping boundary Build");
    context.raw
      .prepare(
        `INSERT INTO parts (
          tenant_id, profile_id, match_key, relative_path, filename, source_layer,
          status, role, quantity_auto, quantity_effective, included, notes
        ) VALUES ('default', ?, 'boundary', 'boundary.stl', 'boundary.stl', 'base',
                  'base', 'primary', 256, 256, 1, '')`,
      )
      .run(profile.id);
    backfillAcceptedPlanRevisions(context.raw, "2026-08-20T12:00:00.000Z");
    backfillCurrentRequiredUnitSets(context.raw, {
      now: () => "2026-08-20T12:01:00.000Z",
      tokenFactory: tokenFactory(20_000),
    });
    const mapping = context.raw
      .prepare(
        `SELECT revision_id, revision_part_id, unit_index, required_unit_token
           FROM plan_revision_required_units
          WHERE unit_index = 255`,
      )
      .get() as {
      revision_id: number;
      revision_part_id: number;
      unit_index: number;
      required_unit_token: string;
    };
    context.raw.exec("DROP TRIGGER trg_plan_revision_required_units_ownership_insert");
    context.raw
      .prepare(
        `INSERT INTO plan_revision_required_units (
          tenant_id, revision_id, revision_part_id, unit_index, required_unit_token
        ) VALUES ('foreign', ?, ?, ?, ?)`,
      )
      .run(
        mapping.revision_id,
        mapping.revision_part_id,
        mapping.unit_index,
        mapping.required_unit_token,
      );
    const before = snapshot(context.raw);

    expect(() => context.repo.readAcceptedPlanOperationalSnapshot(profile.id)).toThrowError(
      expect.objectContaining<Partial<AcceptedPlanOperationalIntegrityError>>({
        code: "required_unit_map",
      }),
    );
    expect(snapshot(context.raw)).toEqual(before);
    context.database.close();
  });

  it("rolls back Apply when a draft Part exceeds the accepted operational row limit", () => {
    const context = trackedApplyFixture();
    const created = context.repo.recomputePlanDraft({
      profileId: context.profile.id,
      actor: "test:user",
      idempotencyKey: "oversized-apply-draft",
    });
    if (created.kind !== "created") throw new Error("oversized Apply draft was not created");
    const target = created.draft.parts[0];
    if (!target) throw new Error("oversized Apply draft Part is missing");
    const oversizedNotes = "x".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES + 1);
    const oversizedParts = created.draft.parts.map((part) =>
      part.id === target.id ? { ...part, notes: oversizedNotes } : part,
    );
    const planningDigest = digestPlanDraft({
      baseRevisionId: created.draft.baseRevisionId,
      basePlanVersion: created.draft.basePlanVersion,
      inputs: created.draft.inputs,
      parts: oversizedParts,
    });
    context.raw
      .prepare("UPDATE plan_draft_parts SET notes = ? WHERE tenant_id = 'default' AND id = ?")
      .run(oversizedNotes, target.id);
    context.raw
      .prepare("UPDATE plan_drafts SET snapshot_digest = ? WHERE tenant_id = 'default' AND id = ?")
      .run(planningDigest, created.draft.id);
    const reconciled = context.repo.savePlanDraftRequiredUnitReconciliation({
      profileId: context.profile.id,
      draftId: created.draft.id,
      expectedSnapshotDigest: planningDigest,
      decisions: [],
      actorId: "test:user",
      idempotencyKey: "oversized-apply-reconciliation",
    });
    if (reconciled.kind !== "saved") throw new Error("oversized Apply reconciliation was not saved");
    const before = snapshot(context.raw);

    expect(() =>
      context.repo.applyPlanChanges({
        profileId: context.profile.id,
        draftId: created.draft.id,
        expectedSnapshotDigest: reconciled.draft.snapshotDigest,
        expectedLifecycleVersion: 0,
        expectedBase: {
          kind: "revision",
          revisionId: context.applied.receipt.revisionId,
          planVersion: context.applied.receipt.planVersion,
        },
        actorId: "test:user",
        idempotencyKey: "oversized-apply",
      }),
    ).toThrowError("Accepted operational row text exceeds the UTF-8 byte limit");
    expect(snapshot(context.raw)).toEqual(before);
    context.database.close();
  });

  it("rolls back Apply when tracked revision provenance crosses the row limit", () => {
    const appliedAt = "2026-08-20T15:00:00.000Z";
    const actorId = "x".repeat(200);
    const fixedWithoutTenant = utf8Bytes([
      "tracked",
      PLAN_REVISION_DIGEST_FORMAT,
      "x".repeat(64),
      actorId,
      actorId,
      appliedAt,
      appliedAt,
    ]);
    const tenantId = "t".repeat(
      MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES - fixedWithoutTenant + 1,
    );
    const context = trackedApplyFixture(tenantId);
    const command = nextApplyCommand(context);
    const repo = new AppRepository(
      getDb(context.database),
      tenantId,
      context.database.reposDir,
      undefined,
      { clock: () => new Date(appliedAt) },
    );
    const before = snapshot(context.raw);

    expect(() =>
      repo.applyPlanChanges({
        ...command,
        actorId,
      }),
    ).toThrowError(AcceptedOperationalRowTextLimitError);
    expect(snapshot(context.raw)).toEqual(before);
    context.database.close();
  });

  it("publishes a tracked revision at the exact stored row limit", () => {
    const appliedAt = "2026-08-20T15:00:00.000Z";
    const actorId = "x".repeat(200);
    const fixedWithoutTenant = utf8Bytes([
      "tracked",
      PLAN_REVISION_DIGEST_FORMAT,
      "x".repeat(64),
      actorId,
      actorId,
      appliedAt,
      appliedAt,
    ]);
    const tenantId = "t".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES - fixedWithoutTenant);
    const context = trackedApplyFixture(tenantId);
    const command = nextApplyCommand(context);
    const repo = new AppRepository(
      getDb(context.database),
      tenantId,
      context.database.reposDir,
      undefined,
      { clock: () => new Date(appliedAt) },
    );

    const result = repo.applyPlanChanges({ ...command, actorId });

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") throw new Error("exact-limit Apply did not publish");
    const revision = context.raw
      .prepare("SELECT * FROM plan_revisions WHERE id = ?")
      .get(result.receipt.revisionId) as Record<string, unknown>;
    expect(utf8Bytes(Object.values(revision))).toBe(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES);
    expect(repo.readAcceptedPlanOperationalSnapshot(context.profile.id).kind).toBe("ready");
    context.database.close();
  });

  it("rolls back Apply when a reused input set has an oversized stored timestamp", () => {
    const context = trackedApplyFixture();
    const command = nextApplyCommand(context);
    const inputSetId = context.raw
      .prepare("SELECT input_set_id FROM plan_accepted_input_sets WHERE profile_id = ?")
      .pluck()
      .get(context.profile.id) as number;
    context.raw
      .prepare("UPDATE plan_revision_input_sets SET recorded_at = ? WHERE id = ?")
      .run("\u0001".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES + 1), inputSetId);
    const before = snapshot(context.raw);

    expect(() => context.repo.applyPlanChanges(command)).toThrowError(
      AcceptedOperationalRowTextLimitError,
    );
    expect(snapshot(context.raw)).toEqual(before);
    context.database.close();
  });

  it("rolls back Apply when a reused Required unit has an oversized stored timestamp", () => {
    const context = trackedApplyFixture();
    const created = context.repo.recomputePlanDraft({
      profileId: context.profile.id,
      actor: "test:user",
      idempotencyKey: "oversized-reused-unit-draft",
    });
    if (created.kind !== "created") throw new Error("reused-unit draft was not created");
    const token = context.raw
      .prepare(
        `SELECT required_unit_token FROM plan_revision_required_units
          WHERE revision_id = ? ORDER BY unit_index LIMIT 1`,
      )
      .pluck()
      .get(context.applied.receipt.revisionId) as string;
    context.raw.exec("DROP TRIGGER trg_required_units_immutable_update");
    context.raw
      .prepare("UPDATE required_units SET created_at = ? WHERE token = ?")
      .run("\u0001".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES + 1), token);
    const reconciled = context.repo.savePlanDraftRequiredUnitReconciliation({
      profileId: context.profile.id,
      draftId: created.draft.id,
      expectedSnapshotDigest: created.draft.snapshotDigest,
      decisions: [],
      actorId: "test:user",
      idempotencyKey: "oversized-reused-unit-reconciliation",
    });
    if (reconciled.kind !== "saved") throw new Error("reused-unit reconciliation was not saved");
    const before = snapshot(context.raw);

    expect(() =>
      context.repo.applyPlanChanges({
        profileId: context.profile.id,
        draftId: created.draft.id,
        expectedSnapshotDigest: reconciled.draft.snapshotDigest,
        expectedLifecycleVersion: 0,
        expectedBase: {
          kind: "revision",
          revisionId: context.applied.receipt.revisionId,
          planVersion: context.applied.receipt.planVersion,
        },
        actorId: "test:user",
        idempotencyKey: "oversized-reused-unit-apply",
      }),
    ).toThrowError(AcceptedOperationalRowTextLimitError);
    expect(snapshot(context.raw)).toEqual(before);
    context.database.close();
  });

  it("keeps an exact-limit control-character page below the PostgreSQL bridge cap", () => {
    const context = fixture();
    const profile = context.repo.createProfile("Escaped bridge Build");
    const insertPart = context.raw.prepare(
      `INSERT INTO parts (
        tenant_id, profile_id, match_key, relative_path, filename, source_layer,
        status, role, quantity_auto, quantity_effective, included, notes
      ) VALUES ('default', ?, ?, ?, ?, 'base', 'base', 'primary', 1, 1, 1, '')`,
    );
    for (let index = 0; index < 16; index += 1) {
      const filename = `escaped-${index.toString().padStart(2, "0")}.stl`;
      insertPart.run(profile.id, filename, filename, filename);
    }
    backfillAcceptedPlanRevisions(context.raw, "2026-08-20T12:00:00.000Z");
    backfillCurrentRequiredUnitSets(context.raw, {
      now: () => "2026-08-20T12:01:00.000Z",
      tokenFactory: tokenFactory(30_000),
    });
    const revision = context.repo.getAcceptedPlanRevision(profile.id);
    if (!revision) throw new Error("escaped accepted revision is missing");
    context.raw.exec("DROP TRIGGER trg_plan_revision_parts_immutable_update");
    context.raw.exec("DROP TRIGGER trg_plan_revisions_immutable_update");
    context.raw.exec("DROP TRIGGER trg_parts_invalidate_accepted_revision_update");
    for (const part of revision.parts) {
      const revisionRow = context.raw
        .prepare("SELECT * FROM plan_revision_parts WHERE id = ?")
        .get(part.id) as Record<string, unknown>;
      const projectionRow = context.raw
        .prepare("SELECT * FROM parts WHERE id = ?")
        .get(part.projectionPartId) as Record<string, unknown>;
      const revisionFixedBytes = utf8Bytes(
        Object.entries(revisionRow)
          .filter(([key]) => key !== "notes")
          .map(([, value]) => value),
      );
      const projectionFixedBytes = utf8Bytes(
        Object.entries(projectionRow)
          .filter(([key]) => key !== "notes")
          .map(([, value]) => value),
      );
      expect(projectionFixedBytes).toBe(revisionFixedBytes);
      const notes = "\u0001".repeat(
        MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES - revisionFixedBytes,
      );
      expect(revisionFixedBytes + Buffer.byteLength(notes, "utf8")).toBe(
        MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES,
      );
      context.raw.prepare("UPDATE plan_revision_parts SET notes = ? WHERE id = ?").run(notes, part.id);
      context.raw.prepare("UPDATE parts SET notes = ? WHERE id = ?").run(notes, part.projectionPartId);
    }
    const updatedRevision = context.repo.getAcceptedPlanRevision(profile.id);
    if (!updatedRevision) throw new Error("escaped accepted revision could not be read");
    context.raw
      .prepare("UPDATE plan_revisions SET snapshot_digest = ? WHERE id = ?")
      .run(digestPlanRevisionParts(updatedRevision.parts), revision.id);
    const sqliteResult = context.repo.readAcceptedPlanOperationalSnapshot(profile.id);
    const postgres = drizzle({} as Pool, { schema: pgSchema });
    const statements: string[] = [];
    const responsePayloadBytes: number[] = [];
    registerSqliteBackedPostgres(postgres, context.raw, statements, responsePayloadBytes);
    const postgresRepo = new AppRepository(
      postgres,
      "default",
      context.database.reposDir,
      pgSchema as unknown as SchemaTables,
    );
    try {
      const result = postgresRepo.readAcceptedPlanOperationalSnapshot(profile.id);

      expect(result).toEqual(sqliteResult);
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready") throw new Error("escaped accepted snapshot is not ready");
      expect(result.snapshot.parts).toHaveLength(16);
      expect(Math.max(...responsePayloadBytes)).toBeLessThan(POSTGRES_SYNC_MAX_RESULT_BYTES);
    } finally {
      unregisterPostgresSyncQuery(postgres);
      context.database.close();
    }
  });

  it("reads more than 10,000 accepted Required units through bounded PostgreSQL pages", () => {
    const context = fixture();
    const profile = context.repo.createProfile("Large accepted Build");
    const insertPart = context.raw.prepare(
      `INSERT INTO parts (
        tenant_id, profile_id, match_key, relative_path, filename, source_layer,
        status, role, quantity_auto, quantity_effective, included, notes
      ) VALUES ('default', ?, ?, ?, ?, 'base', 'base', 'primary', ?, ?, 1, '')`,
    );
    insertPart.run(profile.id, "large-a", "large-a.stl", "large-a.stl", 5_000, 5_000);
    insertPart.run(profile.id, "large-b", "large-b.stl", "large-b.stl", 5_001, 5_001);
    backfillAcceptedPlanRevisions(context.raw, "2026-08-20T12:00:00.000Z");
    backfillCurrentRequiredUnitSets(context.raw, {
      now: () => "2026-08-20T12:01:00.000Z",
      tokenFactory: tokenFactory(1_000),
    });
    const sqliteResult = context.repo.readAcceptedPlanOperationalSnapshot(profile.id);
    expect(sqliteResult.kind).toBe("ready");

    const postgres = drizzle({} as Pool, { schema: pgSchema });
    const statements: string[] = [];
    registerSqliteBackedPostgres(postgres, context.raw, statements);
    const postgresRepo = new AppRepository(
      postgres,
      "default",
      context.database.reposDir,
      pgSchema as unknown as SchemaTables,
    );
    try {
      const result = postgresRepo.readAcceptedPlanOperationalSnapshot(profile.id);

      expect(result).toEqual(sqliteResult);
      expect(result).toMatchObject({
        kind: "ready",
        snapshot: { requiredUnitMappingDigest: expect.stringMatching(/^[0-9a-f]{64}$/) },
      });
      if (result.kind !== "ready") throw new Error("large accepted snapshot is not ready");
      expect(result.snapshot.parts.flatMap((part) => part.units)).toHaveLength(10_001);
      expect(
        statements.filter((statement) =>
          statement.toLowerCase().includes('from "plan_revision_required_units"'),
        ).length,
      ).toBeGreaterThan(1);
    } finally {
      unregisterPostgresSyncQuery(postgres);
      context.database.close();
    }
  });
});
