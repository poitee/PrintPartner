import type Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { acceptPlanForTest } from "../test/accept-plan.js";
import { getDb, SqliteDatabase } from "./client.js";
import { acceptedPlanBasis } from "./accepted-plan-progress.js";
import {
  resolveFilamentAssignment,
  type FilamentAssignment,
} from "./accepted-part-filament.js";
import { AppRepository } from "./repository.js";
import * as pgSchema from "./schema-pg.js";
import { registerPostgresSyncQuery, unregisterPostgresSyncQuery } from "./sync-db-bridge.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function acceptedPlanFixture() {
  const root = mkdtempSync(join(tmpdir(), "pp-accepted-filament-"));
  roots.push(root);
  const database = new SqliteDatabase(root);
  database.connect();
  const repo = new AppRepository(getDb(database), undefined, database.reposDir);
  const source = repo.createSource({ name: "FilamentRepo", url: "https://github.com/a/b" });
  const repoPath = join(root, "repos", String(source.id));
  mkdirSync(join(repoPath, "parts"), { recursive: true });
  writeFileSync(join(repoPath, "parts", "widget.stl"), "solid widget");
  repo.updateSource(source.id, { local_path: repoPath });
  repo.updateImportRules(source.id, ["parts/"]);
  const plan = repo.createProfile("FilamentPlan", source.id);
  expect(acceptPlanForTest(repo, plan.id).merged).toBe(true);
  return {
    database,
    repo,
    plan,
    raw: (database as unknown as { sqlite: Database.Database }).sqlite,
  };
}

describe("resolveFilamentAssignment", () => {
  const catalog: FilamentAssignment = {
    color: { kind: "catalog", colorId: "pla-white" },
    spoolmanSpoolId: "spool-1",
  };

  it("keeps spool on a spool-only write and clears it when color identity changes", () => {
    expect(resolveFilamentAssignment(catalog, { spoolmanSpoolId: "spool-2" })).toEqual({
      color: { kind: "catalog", colorId: "pla-white" },
      spoolmanSpoolId: "spool-2",
    });
    expect(resolveFilamentAssignment(catalog, { colorId: "pla-black" })).toEqual({
      color: { kind: "catalog", colorId: "pla-black" },
      spoolmanSpoolId: null,
    });
    expect(
      resolveFilamentAssignment(catalog, { colorId: "pla-black", spoolmanSpoolId: "spool-3" }),
    ).toEqual({
      color: { kind: "catalog", colorId: "pla-black" },
      spoolmanSpoolId: "spool-3",
    });
    expect(resolveFilamentAssignment(catalog, { colorId: "pla-white" })).toEqual(catalog);
  });

  it("makes catalog and custom color exclusive", () => {
    expect(resolveFilamentAssignment(catalog, { customHex: "#ff6600" })).toEqual({
      color: { kind: "custom", hex: "#ff6600" },
      spoolmanSpoolId: null,
    });
    expect(
      resolveFilamentAssignment(
        { color: { kind: "custom", hex: "#ff6600" }, spoolmanSpoolId: null },
        { colorId: "pla-black" },
      ),
    ).toEqual({
      color: { kind: "catalog", colorId: "pla-black" },
      spoolmanSpoolId: null,
    });
  });
});

function requiredUnitTokens(
  snapshot: { readonly parts: ReadonlyArray<{ readonly units: ReadonlyArray<{ readonly token: string }> }> },
): string[] {
  return snapshot.parts.flatMap((part) => part.units.map((unit) => unit.token));
}

describe("assignAcceptedFilament", () => {
  it("changes live color without dirtying the accepted Plan", () => {
    const { database, repo, plan, raw } = acceptedPlanFixture();
    const before = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    expect(before.kind).toBe("ready");
    if (before.kind !== "ready") throw new Error("accepted Plan is not ready");
    const part = before.snapshot.parts[0];
    if (!part) throw new Error("accepted Part is missing");
    const tokensBefore = requiredUnitTokens(before.snapshot);

    const result = repo.assignAcceptedFilament({
      expected: acceptedPlanBasis(before.snapshot),
      target: { kind: "part", projectionPartId: part.projectionPartId },
      assignment: {
        color: { kind: "catalog", colorId: "pla-black" },
        spoolmanSpoolId: "spoolman:test-int:spool:3",
      },
    });

    expect(result.kind).toBe("updated");
    if (result.kind !== "updated" || !result.part) {
      throw new Error("filament assignment did not update a Part");
    }
    expect(result.unchanged).toBe(false);
    expect(result.part.filamentColorId).toBe("pla-black");
    expect(result.part.filamentCustomHex).toBeNull();
    expect(result.part.spoolmanSpoolId).toBe("spoolman:test-int:spool:3");

    const after = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    expect(after.kind).toBe("ready");
    if (after.kind !== "ready") throw new Error("accepted snapshot is not ready");
    expect(after.snapshot.revisionId).toBe(before.snapshot.revisionId);
    expect(after.snapshot.planVersion).toBe(before.snapshot.planVersion);
    expect(after.snapshot.revisionDigest).toBe(before.snapshot.revisionDigest);
    expect(requiredUnitTokens(after.snapshot)).toEqual(tokensBefore);
    expect(
      raw
        .prepare(
          "SELECT accepted_plan_revision_id, accepted_plan_version FROM build_profiles WHERE id = ?",
        )
        .get(plan.id),
    ).toEqual({
      accepted_plan_revision_id: before.snapshot.revisionId,
      accepted_plan_version: before.snapshot.planVersion,
    });
    database.close();
  });

  it("inherits live filament onto the next accepted revision at Apply", () => {
    const { database, repo, plan } = acceptedPlanFixture();
    const before = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (before.kind !== "ready") throw new Error("accepted Plan is not ready");
    const part = before.snapshot.parts[0];
    if (!part) throw new Error("accepted Part is missing");
    const assigned = repo.assignAcceptedFilament({
      expected: acceptedPlanBasis(before.snapshot),
      target: { kind: "part", projectionPartId: part.projectionPartId },
      assignment: { color: { kind: "catalog", colorId: "pla-black" }, spoolmanSpoolId: "spool-9" },
    });
    expect(assigned.kind).toBe("updated");
    expect(acceptPlanForTest(repo, plan.id).merged).toBe(true);
    const after = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    expect(after.kind).toBe("ready");
    if (after.kind !== "ready") throw new Error("accepted snapshot is not ready");
    expect(after.snapshot.revisionId).not.toBe(before.snapshot.revisionId);
    expect(after.snapshot.parts[0]?.filamentColorId).toBe("pla-black");
    expect(after.snapshot.parts[0]?.spoolmanSpoolId).toBe("spool-9");
    const revision = repo.getAcceptedPlanRevision(plan.id);
    expect(revision?.parts[0]?.filamentColorId).toBe("pla-black");
    expect(revision?.parts[0]?.spoolmanSpoolId).toBe("spool-9");
    database.close();
  });

  it("returns unchanged when the live assignment is already set", () => {
    const { database, repo, plan } = acceptedPlanFixture();
    const accepted = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (accepted.kind !== "ready") throw new Error("accepted Plan is not ready");
    const part = accepted.snapshot.parts[0]!;
    const assignment = {
      color: { kind: "catalog" as const, colorId: "pla-black" },
      spoolmanSpoolId: null,
    };
    const first = repo.assignAcceptedFilament({
      expected: acceptedPlanBasis(accepted.snapshot),
      target: { kind: "part", projectionPartId: part.projectionPartId },
      assignment,
    });
    expect(first.kind).toBe("updated");
    const second = repo.assignAcceptedFilament({
      expected: acceptedPlanBasis(accepted.snapshot),
      target: { kind: "part", projectionPartId: part.projectionPartId },
      assignment,
    });
    expect(second).toMatchObject({ kind: "updated", unchanged: true });
    database.close();
  });

  it("returns an explicit empty role assignment without borrowing another Part", () => {
    const { database, repo, plan } = acceptedPlanFixture();
    const accepted = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (accepted.kind !== "ready") throw new Error("accepted Plan is not ready");
    const part = accepted.snapshot.parts[0]!;

    const result = repo.assignAcceptedFilament({
      expected: acceptedPlanBasis(accepted.snapshot),
      target: { kind: "role", role: "role-without-parts" },
      assignment: {
        color: { kind: "catalog", colorId: "pla-black" },
        spoolmanSpoolId: "spool-9",
      },
    });

    expect(result).toMatchObject({
      kind: "updated",
      unchanged: true,
      part: null,
      assigned: [],
    });
    const after = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (after.kind !== "ready") throw new Error("accepted Plan is not ready");
    expect(after.snapshot.parts[0]?.projectionPartId).toBe(part.projectionPartId);
    expect(after.snapshot.parts[0]?.filamentColorId).toBe(part.filamentColorId);
    expect(after.snapshot.parts[0]?.spoolmanSpoolId).toBe(part.spoolmanSpoolId);
    database.close();
  });

  it("refuses a dirty Plan and still dirties on a non-filament Part UPDATE", () => {
    const { database, repo, plan, raw } = acceptedPlanFixture();
    const accepted = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    if (accepted.kind !== "ready") throw new Error("accepted Plan is not ready");
    const part = accepted.snapshot.parts[0]!;
    raw.prepare("UPDATE parts SET notes = 'dirty' WHERE id = ?").run(part.projectionPartId);
    expect(repo.readAcceptedPlanOperationalSnapshot(plan.id).kind).toBe("compatibility_dirty");
    expect(
      repo.assignAcceptedFilament({
        expected: acceptedPlanBasis(accepted.snapshot),
        target: { kind: "part", projectionPartId: part.projectionPartId },
        assignment: { color: { kind: "catalog", colorId: "pla-black" }, spoolmanSpoolId: null },
      }),
    ).toEqual({ kind: "accepted_state_unavailable", reason: "compatibility_dirty" });
    database.close();
  });

  it("returns transaction_unavailable for PostgreSQL without querying", () => {
    const postgres = drizzle({} as Pool, { schema: pgSchema });
    let queries = 0;
    registerPostgresSyncQuery(postgres, () => {
      queries += 1;
      throw new Error("PostgreSQL mutation queried");
    });
    const repo = new AppRepository(postgres, "default", "/tmp/unused-accepted-filament");
    try {
      expect(
        repo.assignAcceptedFilament({
          expected: {
            profileId: 1,
            planVersion: 1,
            revisionId: 1,
            revisionDigest: "a".repeat(64),
            requiredUnitMappingDigest: "b".repeat(64),
          },
          target: { kind: "part", projectionPartId: 1 },
          assignment: { color: { kind: "catalog", colorId: "pla-black" }, spoolmanSpoolId: null },
        }),
      ).toEqual({ kind: "transaction_unavailable" });
      expect(queries).toBe(0);
    } finally {
      unregisterPostgresSyncQuery(postgres);
    }
  });
});
