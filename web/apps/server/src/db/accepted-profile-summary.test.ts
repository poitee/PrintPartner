import type Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { backfillAcceptedPlanRevisions } from "./accepted-plan-revisions.js";
import { getDb, SqliteDatabase } from "./client.js";
import { backfillCurrentRequiredUnitSets } from "./required-units.js";
import { AppRepository } from "./repository.js";
import * as schema from "./schema.js";

const databases: SqliteDatabase[] = [];
const roots: string[] = [];
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
  const root = mkdtempSync(join(tmpdir(), "pp-accepted-profile-summary-"));
  roots.push(root);
  const database = new SqliteDatabase(root);
  database.connect();
  databases.push(database);
  return {
    database,
    raw: (database as unknown as { sqlite: Database.Database }).sqlite,
    repo: new AppRepository(getDb(database), tenantId, database.reposDir),
    tenantId,
  };
}

function addPart(
  context: ReturnType<typeof fixture>,
  profileId: number,
  quantity = 1,
): number {
  return Number(
    context.raw
      .prepare(
        `INSERT INTO parts (
          tenant_id, profile_id, match_key, relative_path, filename, source_layer,
          status, role, quantity_auto, quantity_effective, included, notes
        ) VALUES (?, ?, 'part', 'part.stl', 'part.stl', 'base', 'base', 'primary', ?, ?, 1, '')`,
      )
      .run(context.tenantId, profileId, quantity, quantity).lastInsertRowid,
  );
}

function tokenFactory() {
  let value = 1;
  return () => `ppu_${(value++).toString(16).padStart(32, "0")}`;
}

function acceptCurrentParts(context: ReturnType<typeof fixture>): void {
  backfillAcceptedPlanRevisions(context.raw, "2026-08-21T12:00:00.000Z");
  backfillCurrentRequiredUnitSets(context.raw, {
    now: () => "2026-08-21T12:01:00.000Z",
    tokenFactory: tokenFactory(),
  });
}

function snapshot(raw: Database.Database): ReadonlyMap<string, readonly unknown[]> {
  return new Map(
    protectedTables.map((table) => [
      table,
      raw.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    ]),
  );
}

function closeDatabase(context: ReturnType<typeof fixture>): void {
  context.database.close();
  const index = databases.indexOf(context.database);
  if (index >= 0) databases.splice(index, 1);
}

function isAcceptedBatchQuery(query: string): boolean {
  return query.startsWith(
    'select "id", "profile_id" from "parts" where "parts"."profile_id" in',
  );
}

function observeListQueries(size: number): {
  readonly queryCount: number;
  readonly acceptedBatchQueryCount: number;
  readonly names: readonly string[];
} {
  const context = fixture();
  for (let index = size - 1; index >= 0; index -= 1) {
    context.repo.createProfile(`Plan ${index.toString().padStart(3, "0")}`);
  }
  const queries: string[] = [];
  const countingDb = drizzle(context.raw, {
    schema,
    logger: { logQuery: (query) => queries.push(query) },
  });
  const summaries = new AppRepository(
    countingDb,
    context.tenantId,
    context.database.reposDir,
  ).listAcceptedProfileSummaries();
  return {
    queryCount: queries.length,
    acceptedBatchQueryCount: queries.filter(isAcceptedBatchQuery).length,
    names: summaries.map(({ header }) => header.name),
  };
}

function trackedFixture() {
  const context = fixture();
  const source = context.repo.createSource({
    name: "Tracked source",
    url: "https://example.test/tracked",
    source_kind: "github",
  });
  const observed = context.repo.getProjectRow(source.id);
  if (!observed) throw new Error("test Source is missing");
  const locator = `${source.id}/revisions/accepted`;
  const snapshotRoot = join(context.database.reposDir, locator);
  mkdirSync(snapshotRoot, { recursive: true });
  writeFileSync(join(snapshotRoot, "part.stl"), "solid part");
  const sourceRevision = context.repo.recordSourceRevision({
    sourceId: source.id,
    upstreamRevisionKey: "accepted",
    manifestDigest: "a".repeat(64),
    snapshotLocator: locator,
    syncedAt: "2026-08-21T11:00:00.000Z",
    completeness: "complete",
  });
  context.repo.activateSourceRevision({ sourceId: source.id, revisionId: sourceRevision.id, observed });
  const profile = context.repo.createProfile("Accepted", source.id);
  const draft = context.repo.recomputePlanDraft({
    profileId: profile.id,
    actor: "test:user",
    idempotencyKey: "accepted-profile-summary-first-draft",
  });
  if (draft.kind !== "created") throw new Error("initial test draft was not created");
  const reconciled = context.repo.savePlanDraftRequiredUnitReconciliation({
    profileId: profile.id,
    draftId: draft.draft.id,
    expectedSnapshotDigest: draft.draft.snapshotDigest,
    decisions: [],
    actorId: "test:user",
    idempotencyKey: "accepted-profile-summary-reconciliation",
  });
  if (reconciled.kind !== "saved") throw new Error("test reconciliation was not saved");
  const applied = context.repo.applyPlanChanges({
    profileId: profile.id,
    draftId: draft.draft.id,
    expectedSnapshotDigest: reconciled.draft.snapshotDigest,
    expectedLifecycleVersion: 0,
    expectedBase: { kind: "empty", planVersion: 0 },
    actorId: "test:user",
    idempotencyKey: "accepted-profile-summary-apply",
  });
  if (applied.kind !== "applied") throw new Error("test draft was not applied");
  return { ...context, profile };
}

describe("accepted Profile summary composition", () => {
  it("composes headers with accepted Progress in name order and keeps tenants opaque", () => {
    const context = fixture();
    const foreign = new AppRepository(
      getDb(context.database),
      "foreign",
      context.database.reposDir,
    );
    const zeta = context.repo.createProfile("Zeta");
    const alpha = context.repo.createProfile("Alpha");
    addPart(context, zeta.id, 2);
    const foreignProfile = foreign.createProfile("Foreign");

    expect(context.repo.listAcceptedProfileSummaries()).toEqual([
      {
        header: expect.objectContaining({ id: alpha.id, name: "Alpha" }),
        progress: { kind: "empty" },
      },
      {
        header: expect.objectContaining({ id: zeta.id, name: "Zeta" }),
        progress: { kind: "unavailable", reason: "compatibility_dirty" },
      },
    ]);
    expect(context.repo.readAcceptedProfileSummary(zeta.id)).toEqual({
      kind: "found",
      summary: {
        header: expect.objectContaining({ id: zeta.id, name: "Zeta" }),
        progress: { kind: "unavailable", reason: "compatibility_dirty" },
      },
    });
    expect(context.repo.readAcceptedProfileSummary(999_999)).toEqual({ kind: "missing" });
    expect(context.repo.readAcceptedProfileSummary(foreignProfile.id)).toEqual({
      kind: "missing",
    });
  });

  it("retains ready, ready-zero, uninitialized, and integrity states", () => {
    const context = fixture();
    const ready = context.repo.createProfile("Ready");
    addPart(context, ready.id, 3);
    const readyZero = context.repo.createProfile("Ready zero");
    const excludedId = addPart(context, readyZero.id, 2);
    context.raw.prepare("UPDATE parts SET included = 0 WHERE id = ?").run(excludedId);
    acceptCurrentParts(context);
    const uninitialized = context.repo.createProfile("Uninitialized");
    addPart(context, uninitialized.id);
    backfillAcceptedPlanRevisions(context.raw, "2026-08-21T12:02:00.000Z");

    expect(
      context.repo.listAcceptedProfileSummaries().map(({ header, progress }) => ({
        name: header.name,
        progress,
      })),
    ).toEqual([
      { name: "Ready", progress: { kind: "ready", totalUnits: 3, remainingUnits: 3 } },
      {
        name: "Ready zero",
        progress: { kind: "ready", totalUnits: 0, remainingUnits: 0 },
      },
      {
        name: "Uninitialized",
        progress: { kind: "unavailable", reason: "uninitialized" },
      },
    ]);

    context.raw.exec("DROP TRIGGER trg_plan_revisions_immutable_update");
    context.raw
      .prepare(
        "UPDATE plan_revisions SET snapshot_digest = ? WHERE id = (SELECT accepted_plan_revision_id FROM build_profiles WHERE id = ?)",
      )
      .run("invalid", ready.id);
    expect(context.repo.readAcceptedProfileSummary(ready.id)).toEqual({
      kind: "found",
      summary: {
        header: expect.objectContaining({ id: ready.id }),
        progress: { kind: "integrity_failure", code: "revision_digest" },
      },
    });
  });

  it("uses one bounded accepted batch per 64 headers", () => {
    const observations = [64, 65, 129].map(observeListQueries);
    expect(
      observations.map(({ queryCount, acceptedBatchQueryCount }) => ({
        queryCount,
        acceptedBatchQueryCount,
      })),
    ).toEqual([
      { queryCount: 11, acceptedBatchQueryCount: 1 },
      { queryCount: 15, acceptedBatchQueryCount: 2 },
      { queryCount: 22, acceptedBatchQueryCount: 3 },
    ]);
    expect(observations.map(({ names }) => names.length)).toEqual([64, 65, 129]);
    for (const { names } of observations) {
      expect(names).toEqual([...names].sort());
    }
  });

  it("omits a header deleted before its accepted read and reports missing for detail", () => {
    const { repo } = fixture();
    const deleted = repo.createProfile("Deleted");
    const retained = repo.createProfile("Retained");
    const listHeaders = repo.listProfileHeaders.bind(repo);
    repo.listProfileHeaders = () => {
      const headers = listHeaders();
      repo.deleteProfile(deleted.id);
      return headers;
    };
    expect(repo.listAcceptedProfileSummaries().map(({ header }) => header.id)).toEqual([
      retained.id,
    ]);

    const detailHeader = repo.getProfileHeader(retained.id);
    if (!detailHeader) throw new Error("test Profile header is missing");
    repo.getProfileHeader = () => {
      repo.deleteProfile(retained.id);
      return detailHeader;
    };
    expect(repo.readAcceptedProfileSummary(retained.id)).toEqual({ kind: "missing" });
  });

  it("keeps accepted totals blind to working draft quantity changes", () => {
    const context = trackedFixture();

    expect(context.repo.readAcceptedProfileSummary(context.profile.id)).toEqual({
      kind: "found",
      summary: {
        header: expect.objectContaining({ id: context.profile.id }),
        progress: { kind: "ready", totalUnits: 1, remainingUnits: 1 },
      },
    });
    const draft = context.repo.recomputePlanDraft({
      profileId: context.profile.id,
      actor: "test:user",
      idempotencyKey: "accepted-profile-summary-draft",
    });
    if (draft.kind !== "created") throw new Error("test draft was not created");
    const draftPart = draft.draft.parts.find((part) => part.filename === "part.stl");
    if (!draftPart) throw new Error("test draft Part is missing");
    const updated = context.repo.editPlanDraftParts({
      profileId: context.profile.id,
      draftId: draft.draft.id,
      expectedSnapshotDigest: draft.draft.snapshotDigest,
      decision: { kind: "set_quantity_override", partIds: [draftPart.id], value: 99 },
    });
    expect(updated.kind).toBe("updated");
    expect(context.repo.readAcceptedProfileSummary(context.profile.id)).toEqual({
      kind: "found",
      summary: {
        header: expect.objectContaining({ id: context.profile.id }),
        progress: { kind: "ready", totalUnits: 1, remainingUnits: 1 },
      },
    });
  });

  it("performs no writes and propagates an unexpected accepted-read error", () => {
    const context = fixture();
    const profile = context.repo.createProfile("Read only");
    addPart(context, profile.id, 2);
    acceptCurrentParts(context);
    const before = snapshot(context.raw);

    expect(context.repo.listAcceptedProfileSummaries()).toHaveLength(1);
    expect(context.repo.readAcceptedProfileSummary(profile.id).kind).toBe("found");
    expect(snapshot(context.raw)).toEqual(before);

    const headers = context.repo.listProfileHeaders();
    context.repo.listProfileHeaders = () => {
      closeDatabase(context);
      return headers;
    };
    expect(() => context.repo.listAcceptedProfileSummaries()).toThrow();

    const detailContext = fixture();
    const detailProfile = detailContext.repo.createProfile("Detail failure");
    const detailHeader = detailContext.repo.getProfileHeader(detailProfile.id);
    if (!detailHeader) throw new Error("test detail header is missing");
    detailContext.repo.getProfileHeader = () => {
      closeDatabase(detailContext);
      return detailHeader;
    };
    expect(() => detailContext.repo.readAcceptedProfileSummary(detailProfile.id)).toThrow();
  });
});
