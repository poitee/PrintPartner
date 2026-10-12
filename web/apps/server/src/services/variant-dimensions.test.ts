import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/node-postgres";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import * as postgresSchema from "../db/schema-pg.js";
import { registerPostgresSyncQuery, unregisterPostgresSyncQuery } from "../db/sync-db-bridge.js";
import { applyPlanVariantSelection, getPlanVariantSelection, getSourceVariantDimensions } from "./variant-dimensions.js";

const cleanups: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pp-variant-selection-"));
  const database = new SqliteDatabase(root);
  database.connect();
  const raw = new Database(database.dbPath);
  cleanups.push(() => { raw.close(); database.close(); rmSync(root, { recursive: true, force: true }); });
  const repo = new AppRepository(getDb(database), "default", database.reposDir);
  const source = repo.createSource({ name: "Base", source_kind: "local" });
  const addon = repo.createSource({ name: "Addon", source_kind: "local" });
  const sourceRoot = join(database.reposDir, String(source.id));
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, "print-partner.manifest.yaml"), "variant_dimensions:\n  size: [250, 300]\n  color: [red, blue]\n");
  const plan = repo.createProfile("Variant Build", source.id);
  repo.addAddonLayer(plan.id, addon.id);
  const shared = repo.createProfile("Shared Source Build", source.id);
  repo.setSetting(`plan_variant_selection_${plan.id}`, JSON.stringify({ size: "250" }));
  repo.updateImportRules(source.id, ["250/"]);
  repo.updateImportRules(addon.id, ["addon/"]);
  raw.exec("UPDATE build_profiles SET config_modified_at = '2000-01-01T00:00:00.000Z'");
  const state = () => ({
    settings: raw.prepare("SELECT * FROM app_settings ORDER BY tenant_id, key").all(),
    sources: raw.prepare("SELECT * FROM projects ORDER BY id").all(),
    builds: raw.prepare("SELECT * FROM build_profiles ORDER BY id").all(),
  });
  return { repo, raw, source, addon, plan, shared, state, database };
}

describe("Plan variant selection", () => {
  it("saves manifest options directly and updates the shared Source and all affected Builds", () => {
    const { repo, source, addon, plan, shared, raw } = fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T23:00:00.000Z"));
    expect(getSourceVariantDimensions(repo, source.id)).toEqual({ size: [250, 300], color: ["red", "blue"] });
    expect(applyPlanVariantSelection(repo, plan.id, { size: "300", color: "blue" }, source.id)).toEqual({
      selection: { size: "300", color: "blue" }, rules: ["300/", "blue/"],
    });
    expect(getPlanVariantSelection(repo, plan.id)).toEqual({ size: "300", color: "blue" });
    expect(repo.getProjectRow(source.id)?.importedPaths).toBe('["300/","blue/"]');
    expect(repo.getProjectRow(addon.id)?.importedPaths).toBe('["addon/"]');
    for (const id of [plan.id, shared.id]) {
      expect(raw.prepare("SELECT config_modified_at FROM build_profiles WHERE id = ?").get(id)).toEqual({ config_modified_at: "2026-10-11T23:00:00.000Z" });
    }
    expect(getPlanVariantSelection(repo, shared.id)).toEqual({});
    expect(raw.prepare("SELECT COUNT(*) AS count FROM plan_revisions").get()).toEqual({ count: 0 });
  });

  it("clears the selection and import rules", () => {
    const { repo, source, plan } = fixture();
    expect(applyPlanVariantSelection(repo, plan.id, {}, source.id)).toEqual({ selection: {}, rules: [] });
    expect(getPlanVariantSelection(repo, plan.id)).toEqual({});
    expect(repo.getProjectRow(source.id)?.importedPaths).toBe("[]");
  });

  it("rejects an add-on Source without changing any settings, rules, or Build freshness", () => {
    const { repo, addon, plan, state } = fixture();
    const before = state();
    expect(() => applyPlanVariantSelection(repo, plan.id, { size: "300" }, addon.id)).toThrow("base source");
    expect(state()).toEqual(before);
  });

  it.each<Record<string, string>>([
    { unknown: "300" }, { size: "bad-value" }, { size: "" }, { toString: "300" },
  ])("rejects unsupported dimensions or options %j without side effects", (selection) => {
    const { repo, source, plan, state } = fixture();
    const before = state();
    expect(() => applyPlanVariantSelection(repo, plan.id, selection, source.id)).toThrow();
    expect(state()).toEqual(before);
  });

  it.each(["projects", "build_profiles", "app_settings"])("rolls back every write when %s rejects a change", (table) => {
    const { repo, source, plan, raw, state } = fixture();
    const before = state();
    raw.exec(`CREATE TRIGGER reject_variant_write BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`);
    expect(() => applyPlanVariantSelection(repo, plan.id, { size: "300" }, source.id)).toThrow("injected write failure");
    expect(state()).toEqual(before);
  });

  it("refuses PostgreSQL writes without native atomic transaction support", () => {
    const db = drizzle.mock({ schema: postgresSchema });
    registerPostgresSyncQuery(db, () => { throw new Error("Unexpected PostgreSQL query"); });
    try {
      const repo = new AppRepository(db, "default", tmpdir());
      expect(() => repo.savePlanVariantSelection(1, 2, { size: "300" })).toThrow(
        "Atomic variant selection is unavailable for this database",
      );
    } finally {
      unregisterPostgresSyncQuery(db);
    }
  });

  it("rejects another tenant's Plan even when its Source ID is supplied", () => {
    const { repo, source, plan, state, database } = fixture();
    const otherTenant = new AppRepository(getDb(database), "other", database.reposDir);
    const before = state();
    expect(() => applyPlanVariantSelection(otherTenant, plan.id, { size: "300" }, source.id)).toThrow();
    expect(state()).toEqual(before);
    expect(getPlanVariantSelection(repo, plan.id)).toEqual({ size: "250" });
  });
});
