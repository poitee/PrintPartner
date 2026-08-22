import { acceptPlanForTest } from "./test/accept-plan.js";
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acceptedPlanBasis } from "./db/accepted-plan-progress.js";
import { getDb, SqliteDatabase } from "./db/client.js";
import { AppRepository } from "./db/repository.js";
import { normalizePartRole } from "./services/role-filament.js";
import { saveRoleFilamentDefault } from "./services/role-filament-store.js";

function assignRole(
  repo: AppRepository,
  profileId: number,
  role: string,
  assignment: {
    color: { kind: "catalog"; colorId: string } | { kind: "custom"; hex: string } | { kind: "unset" };
    spoolmanSpoolId: string | null;
  },
) {
  const accepted = repo.readAcceptedPlanOperationalSnapshot(profileId);
  if (accepted.kind !== "ready") throw new Error(`accepted Plan is not ready: ${accepted.kind}`);
  return repo.assignAcceptedFilament({
    expected: acceptedPlanBasis(accepted.snapshot),
    target: { kind: "role", role },
    assignment,
  });
}

describe("normalizePartRole", () => {
  it("maps empty and whitespace roles to primary", () => {
    expect(normalizePartRole("")).toBe("primary");
    expect(normalizePartRole("   ")).toBe("primary");
    expect(normalizePartRole(null)).toBe("primary");
    expect(normalizePartRole(undefined)).toBe("primary");
  });

  it("preserves explicit role ids", () => {
    expect(normalizePartRole("accent")).toBe("accent");
    expect(normalizePartRole("  clear  ")).toBe("clear");
    expect(normalizePartRole("Accent")).toBe("accent");
  });
});

describe("assignAcceptedFilament role target", () => {
  it("updates included parts when stored role is empty but grouped as primary", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-role-fil-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);

    const source = repo.createSource({ name: "RoleRepo", url: "https://github.com/a/b" });
    const repoPath = join(dir, "repos", String(source.id));
    mkdirSync(join(repoPath, "parts"), { recursive: true });
    writeFileSync(join(repoPath, "parts", "widget.stl"), "solid widget");
    repo.updateSource(source.id, { local_path: repoPath });
    repo.updateImportRules(source.id, ["parts/"]);

    const plan = repo.createProfile("RolePlan", source.id);
    acceptPlanForTest(repo, plan.id);

    const result = assignRole(repo, plan.id, "primary", {
      color: { kind: "catalog", colorId: "pla-black" },
      spoolmanSpoolId: null,
    });
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated") throw new Error("role assignment did not update");
    expect(result.assigned).toHaveLength(1);

    const roles = repo.getRoleFilaments(plan.id);
    const primary = roles.find((r) => r.role === "primary");
    expect(primary?.filament_color_id).toBe("pla-black");

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores spool assignment on included parts for a role", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-role-spool-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);

    const source = repo.createSource({ name: "SpoolRepo", url: "https://github.com/a/b" });
    const repoPath = join(dir, "repos", String(source.id));
    mkdirSync(join(repoPath, "parts"), { recursive: true });
    writeFileSync(join(repoPath, "parts", "widget.stl"), "solid widget");
    repo.updateSource(source.id, { local_path: repoPath });
    repo.updateImportRules(source.id, ["parts/"]);

    const plan = repo.createProfile("SpoolPlan", source.id);
    acceptPlanForTest(repo, plan.id);
    const filamentId = "spoolman:test-int:filament:7";
    const spoolRef = "spoolman:test-int:spool:3";

    assignRole(repo, plan.id, "primary", {
      color: { kind: "catalog", colorId: filamentId },
      spoolmanSpoolId: null,
    });
    assignRole(repo, plan.id, "primary", {
      color: { kind: "catalog", colorId: filamentId },
      spoolmanSpoolId: spoolRef,
    });

    const part = repo.listParts(plan.id).parts[0]!;
    expect(part.filament_color_id).toBe(filamentId);
    expect(part.spoolman_spool_id).toBe(spoolRef);

    const roles = repo.getRoleFilaments(plan.id);
    expect(roles[0]!.spoolman_spool_id).toBe(spoolRef);

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists canonical roles and saves defaults before matching parts exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-role-defaults-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);

    const plan = repo.createProfile("DefaultsPlan");
    const rolesBefore = repo.getRoleFilaments(plan.id);
    expect(rolesBefore.map((r) => r.role)).toEqual(["primary", "accent", "clear", "opaque"]);
    expect(rolesBefore.every((r) => r.part_count === 0)).toBe(true);

    saveRoleFilamentDefault(repo, plan.id, "accent", {
      filament_color_id: null,
      filament_custom_hex: "#ff6600",
      spoolman_spool_id: null,
    });

    const rolesAfter = repo.getRoleFilaments(plan.id);
    const accent = rolesAfter.find((r) => r.role === "accent");
    expect(accent?.filament_custom_hex).toBe("#ff6600");
    expect(accent?.filament_hex).toBe("#ff6600");

    const source = repo.createSource({ name: "AccentRepo", url: "https://github.com/a/b" });
    const repoPath = join(dir, "repos", String(source.id));
    mkdirSync(join(repoPath, "parts"), { recursive: true });
    writeFileSync(join(repoPath, "parts", "[a]_bracket.stl"), "solid accent");
    repo.updateSource(source.id, { local_path: repoPath });
    repo.updateImportRules(source.id, ["parts/"]);
    repo.setBaseLayer(plan.id, source.id);
    acceptPlanForTest(repo, plan.id);

    const accentPart = repo.listParts(plan.id).parts.find((p) => p.role === "accent");
    expect(accentPart?.filament_custom_hex).toBe("#ff6600");

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("matches bulk updates when stored role casing differs", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-role-case-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);

    const source = repo.createSource({ name: "CaseRepo", url: "https://github.com/a/b" });
    const repoPath = join(dir, "repos", String(source.id));
    mkdirSync(join(repoPath, "parts"), { recursive: true });
    writeFileSync(join(repoPath, "parts", "[a]_bracket.stl"), "solid");
    repo.updateSource(source.id, { local_path: repoPath });
    repo.updateImportRules(source.id, ["parts/"]);
    const plan = repo.createProfile("CasePlan", source.id);
    acceptPlanForTest(repo, plan.id);

    const result = assignRole(repo, plan.id, "Accent", {
      color: { kind: "catalog", colorId: "pla-black" },
      spoolmanSpoolId: null,
    });
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated") throw new Error("role assignment did not update");
    expect(result.assigned).toHaveLength(1);
    expect(repo.listParts(plan.id).parts[0]?.filament_color_id).toBe("pla-black");

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
