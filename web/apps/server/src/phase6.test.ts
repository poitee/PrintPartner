import { acceptPlanForTest } from "./test/accept-plan.js";
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { getDb, SqliteDatabase } from "./db/client.js";
import { AppRepository } from "./db/repository.js";
import { tenantStorage } from "./middleware/tenant-context.js";
import { acceptedPlanBasis, type AcceptedPlanBasis } from "./db/accepted-plan-progress.js";
import { parseRequiredUnitToken, type RequiredUnitToken } from "./services/required-units.js";

describe("Phase 6 tenant isolation", () => {
  it("scopes sources and profiles per tenant", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-tenant-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const db = getDb(sqlite);

    let sourceA!: ReturnType<AppRepository["createSource"]>;
    let planA!: ReturnType<AppRepository["createProfile"]>;
    let sourceB!: ReturnType<AppRepository["createSource"]>;

    tenantStorage.run("tenant-a", () => {
      const repoA = new AppRepository(db, "tenant-a", sqlite.reposDir);
      sourceA = repoA.createSource({ name: "RepoA", url: "https://github.com/a/a" });
      planA = repoA.createProfile("PlanA", sourceA.id);
      expect(repoA.listSources()).toHaveLength(1);
    });

    tenantStorage.run("tenant-b", () => {
      const repoB = new AppRepository(db, "tenant-b", sqlite.reposDir);
      sourceB = repoB.createSource({ name: "RepoB", url: "https://github.com/b/b" });
      expect(repoB.listSources()).toHaveLength(1);
      expect(repoB.getSource(sourceA.id)).toBeNull();
      expect(repoB.getProfileHeader(planA.id)).toBeNull();
    });

    tenantStorage.run("tenant-a", () => {
      const repoA = new AppRepository(db, "tenant-a", sqlite.reposDir);
      expect(repoA.getSource(sourceB.id)).toBeNull();
    });

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects cross-tenant profile recompute and export reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-profile-guard-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const db = getDb(sqlite);
    const repoPath = join(dir, "tenant-a-source");
    mkdirSync(join(repoPath, "parts"), { recursive: true });
    writeFileSync(join(repoPath, "parts", "part.stl"), "solid part\nendsolid part\n");

    let profileId = 0;
    let partId = 0;
    let expected!: AcceptedPlanBasis;
    let token!: RequiredUnitToken;
    tenantStorage.run("tenant-a", () => {
      const repo = new AppRepository(db, "default", sqlite.reposDir);
      const source = repo.createSource({
        name: "Tenant A source",
        source_kind: "local",
        local_path: repoPath,
      });
      repo.updateSource(source.id, { local_path: repoPath });
      repo.updateImportRules(source.id, ["parts/"]);
      profileId = repo.createProfile("Tenant A plan", source.id).id;
      expect(acceptPlanForTest(repo, profileId).merged).toBe(true);
      partId = repo.listParts(profileId).parts[0]!.id;
      const accepted = repo.readAcceptedPlanOperationalSnapshot(profileId);
      if (accepted.kind !== "ready") throw new Error("accepted Plan is not ready");
      expected = acceptedPlanBasis(accepted.snapshot);
      token = parseRequiredUnitToken(accepted.snapshot.parts[0]!.units[0]!.token);
      repo.setAcceptedUnitCompletion({ expected, token, completed: true });
      repo.setAcceptedUnitAssembly({ expected, token, assembled: true });
    });

    tenantStorage.run("tenant-b", () => {
      const repo = new AppRepository(db, "default", sqlite.reposDir);
      expect(repo.getProfileHeader(profileId)).toBeNull();
      expect(repo.getPartRow(partId)).toBeNull();
      expect(
        repo.assignAcceptedFilament({
          expected,
          target: { kind: "part", projectionPartId: partId },
          assignment: { color: { kind: "catalog", colorId: "pla-black" }, spoolmanSpoolId: null },
        }),
      ).toEqual({ kind: "part_not_found" });
      expect(repo.setAcceptedUnitCompletion({ expected, token, completed: false })).toEqual({
        kind: "unit_not_found",
      });
      expect(repo.setAcceptedUnitAssembly({ expected, token, assembled: false })).toEqual({
        kind: "unit_not_found",
      });
      expect(() => repo.listParts(profileId)).toThrow("Profile not found");
      expect(() => acceptPlanForTest(repo, profileId)).toThrow("Profile not found");
      expect(() => repo.readEditableKitRecipe(profileId)).toThrow("Profile not found");
      expect(() =>
        repo.createPlanDecision({
          planId: profileId,
          actor: "user",
          kind: "applied_action",
          label: "Cross-tenant decision",
          summary: "must be rejected",
        }),
      ).toThrow("Profile not found");
    });

    tenantStorage.run("tenant-a", () => {
      const repo = new AppRepository(db, "default", sqlite.reposDir);
      expect(repo.getPartRow(partId)?.included).toBe(true);
      const accepted = repo.readAcceptedPlanOperationalSnapshot(profileId);
      expect(accepted).toMatchObject({
        kind: "ready",
        snapshot: { parts: [{ units: [{ completed: true, assembled: true }] }] },
      });
      const raw = new Database(join(dir, "print-partner.db"), { readonly: true });
      try {
        expect(
          raw
            .prepare("SELECT assembled FROM print_progress WHERE part_id = ? AND unit_index = 0")
            .pluck()
            .get(partId),
        ).toBe(1);
      } finally {
        raw.close();
      }
    });

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rolls back every SQLite recompute mutation when a later write fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-recompute-rollback-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), "default", sqlite.reposDir);
    const repoPath = join(dir, "source");
    mkdirSync(join(repoPath, "parts"), { recursive: true });
    const originalPath = join(repoPath, "parts", "original.stl");
    writeFileSync(originalPath, "solid original\nendsolid original\n");
    const source = repo.createSource({
      name: "Atomic source",
      source_kind: "local",
      local_path: repoPath,
    });
    repo.updateSource(source.id, { local_path: repoPath });
    repo.updateImportRules(source.id, ["parts/"]);
    const profile = repo.createProfile("Atomic plan", source.id);
    expect(acceptPlanForTest(repo, profile.id).merged).toBe(true);
    const before = repo.listParts(profile.id).parts;

    unlinkSync(originalPath);
    writeFileSync(
      join(repoPath, "parts", "replacement.stl"),
      "solid replacement\nendsolid replacement\n",
    );
    const native = (sqlite as unknown as { sqlite: Database.Database }).sqlite;
    native.exec(`
      CREATE TRIGGER fail_recompute_insert
      BEFORE INSERT ON parts
      WHEN NEW.filename = 'replacement.stl'
      BEGIN
        SELECT RAISE(ABORT, 'injected recompute failure');
      END
    `);

    expect(() => acceptPlanForTest(repo, profile.id)).toThrow("injected recompute failure");
    expect(repo.listParts(profile.id).parts).toEqual(before);

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed on stale cross-tenant accepted Progress rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-progress-owner-repair-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), "default", sqlite.reposDir);
    const repoPath = join(dir, "source");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, "part.stl"), "solid part\nendsolid part\n");
    const source = repo.createSource({
      name: "Progress source",
      source_kind: "local",
      local_path: repoPath,
    });
    repo.updateSource(source.id, { local_path: repoPath });
    const profile = repo.createProfile("Progress plan", source.id);
    expect(acceptPlanForTest(repo, profile.id).merged).toBe(true);
    const partId = repo.listParts(profile.id).parts[0]!.id;
    const native = (sqlite as unknown as { sqlite: Database.Database }).sqlite;
    const accepted = repo.readAcceptedPlanOperationalSnapshot(profile.id);
    if (accepted.kind !== "ready") throw new Error("accepted Plan is not ready");
    native.prepare("UPDATE print_progress SET tenant_id = ? WHERE part_id = ?").run(
      "stale-tenant",
      partId,
    );

    expect(() =>
      repo.setAcceptedUnitCompletion({
        expected: acceptedPlanBasis(accepted.snapshot),
        token: parseRequiredUnitToken(accepted.snapshot.parts[0]!.units[0]!.token),
        completed: false,
      }),
    ).toThrowError(/progress is corrupt/i);
    expect(
      native
        .prepare("SELECT tenant_id FROM print_progress WHERE part_id = ?")
        .all(partId),
    ).toEqual([{ tenant_id: "stale-tenant" }]);

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty history lists for missing positive plans", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-missing-plan-lists-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), "default", sqlite.reposDir);

    expect(repo.listPlanDecisions(999_999)).toEqual([]);
    expect(repo.listPlanSnapshots(999_999)).toEqual([]);
    expect(repo.listPrintJobParts(999_999)).toEqual([]);

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
