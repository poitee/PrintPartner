import { acceptPlanForTest } from "./test/accept-plan.js";
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, SqliteDatabase } from "./db/client.js";
import { AppRepository } from "./db/repository.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { matchKeyMatches } from "./services/manifest-apply.js";
import {
  buildKitBundleData,
  loadKitBundleBytes,
  parseKitBundleBuffer,
  writeKitBundleData,
  KIT_FORMAT,
} from "./services/export-kit.js";
import { loadKitManifest, saveKitManifest } from "./services/kit-manifest-store.js";
import { setRequestTenantId } from "./middleware/tenant-context.js";
import { SaasS3StoragePort } from "./adapters/saas/storage-s3.js";
import { fetchPrintablesMetadata } from "./services/source-adapters.js";

function exportEditableKitBundle(repo: AppRepository, profileId: number, exportsDir: string): string {
  const recipe = repo.readEditableKitRecipe(profileId);
  return writeKitBundleData({
    data: buildKitBundleData({
      mode: { kind: "editable", recipe },
      exportedAt: new Date().toISOString(),
    }),
    profileId: recipe.profile.id,
    profileName: recipe.profile.name,
    exportsDir,
  });
}

describe("Phase 5", () => {
  it("matchKeyMatches supports globs", () => {
    expect(matchKeyMatches("parts/*.stl", "parts/bracket.stl")).toBe(true);
    expect(matchKeyMatches("bracket.stl", "parts/bracket.stl")).toBe(true);
  });

  it("draft recompute sets the proposed manifest requirement", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-mf-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    const source = repo.createSource({ name: "Repo", url: "https://github.com/a/b" });
    const repoPath = join(dir, "repos", String(source.id));
    mkdirSync(join(repoPath, "parts"), { recursive: true });
    writeFileSync(join(repoPath, "parts", "bracket.stl"), "solid");
    writeFileSync(
      join(repoPath, "print-partner.manifest.yaml"),
      "format: print-partner-manifest-v2\nversion: 2\nparts:\n  - match: parts/bracket.stl\n    requirement: required\n",
    );
    repo.updateSource(source.id, { local_path: repoPath });
    repo.updateImportRules(source.id, ["parts/"]);
    const plan = repo.createProfile("Plan", source.id);
    acceptPlanForTest(repo, plan.id);
    const { parts } = repo.listParts(plan.id, 100, 0);
    expect(parts[0]?.requirement).toBe("required");
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("kit bundle import round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-kit-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    const source = repo.createSource({ name: "R", url: "https://github.com/a/b" });
    const repoPath = join(dir, "repos", String(source.id));
    mkdirSync(join(repoPath, "p"), { recursive: true });
    writeFileSync(join(repoPath, "p", "a.stl"), "stl");
    repo.updateSource(source.id, { local_path: repoPath });
    repo.updateImportRules(source.id, ["p/"]);
    const plan = repo.createProfile("KitPlan", source.id);
    saveKitManifest(repo, plan.id, { selections: { toolhead: "stealthburner" }, include: ["p/"] });
    acceptPlanForTest(repo, plan.id);
    const bundlePath = exportEditableKitBundle(repo, plan.id, join(dir, "exports"));
    const data = loadKitBundleBytes(bundlePath);
    expect(data.format).toBe(KIT_FORMAT);
    // Simulate a recipient who has the repo but different local import rules.
    repo.updateImportRules(source.id, []);

    const imported = repo.importKitBundle(data, "Imported");
    expect(imported.parts_imported).toBeGreaterThan(0);
    expect(imported.unmatched_sources ?? []).toHaveLength(0);
    expect(repo.getProjectRow(source.id)?.importedPaths).toContain("p");

    const importedManifest = loadKitManifest(repo, imported.profile_id);
    expect(importedManifest.selections.toolhead).toBe("stealthburner");
    const sources = data.sources as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(1);
    expect(sources[0]?.import_rules).toEqual(["p/"]);
    expect(data.kit_manifest).toBeTruthy();
    const layerProject = (data.layers as Array<Record<string, unknown>>)[0]
      ?.project as Record<string, unknown>;
    expect(layerProject?.import_rules).toEqual(["p/"]);
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("kit bundle export includes manifest and source metadata for re-import", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-kit-meta-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    const source = repo.createSource({ name: "Voron", url: "https://github.com/a/voron" });
    repo.updateSource(source.id, {
      manifest_community_slug: "ldo-2.4-sb-tap",
      role: "frame",
    });
    const repoPath = join(dir, "repos", String(source.id));
    mkdirSync(join(repoPath, "STLs"), { recursive: true });
    writeFileSync(join(repoPath, "STLs", "part.stl"), "stl");
    repo.updateSource(source.id, { local_path: repoPath });
    repo.updateImportRules(source.id, ["STLs/"]);
    const plan = repo.createProfile("SharePlan", source.id);
    saveKitManifest(repo, plan.id, {
      selections: { toolhead: "stealthburner", probe: "tap" },
      choice_tree: [{ id: "toolhead", label: "Toolhead" }],
    });
    acceptPlanForTest(repo, plan.id);

    const data = loadKitBundleBytes(exportEditableKitBundle(repo, plan.id, join(dir, "exports")));
    expect(data.sources).toBeTruthy();
    const exportedSource = (data.sources as Array<Record<string, unknown>>)[0];
    expect(exportedSource?.manifest_community_slug).toBe("ldo-2.4-sb-tap");
    expect(exportedSource?.import_rules).toEqual(["STLs/"]);
    const kitManifest = data.kit_manifest as Record<string, unknown>;
    expect((kitManifest.selections as Record<string, string>).toolhead).toBe("stealthburner");
    expect(kitManifest.choice_tree).toHaveLength(1);

    const imported = repo.importKitBundle(data, "Recipient");
    expect(imported.unmatched_sources).toHaveLength(0);
    expect(repo.getSource(source.id)?.manifest_community_slug).toBe("ldo-2.4-sb-tap");
    expect(loadKitManifest(repo, imported.profile_id).selections.probe).toBe("tap");
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("kit bundle import derives unmatched sources from layer refs when sources omitted", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-kit-layer-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    const data = {
      format: KIT_FORMAT,
      version: 3,
      profile: { name: "Shared", order_number: null },
      layers: [
        {
          layer_order: 0,
          layer_type: "base",
          project: {
            name: "Missing Repo",
            url: "https://github.com/a/missing",
            branch: "main",
            tag: "v1.0.0",
            source_kind: "github",
            import_rules: ["parts/"],
            manifest_community_slug: "example-manifest",
          },
        },
      ],
      parts: [],
      kit_manifest: { selections: { head: "sb" }, include: [], exclude: [] },
    };
    const imported = repo.importKitBundle(data, "Imported");
    expect(imported.unmatched_sources).toHaveLength(1);
    expect(imported.unmatched_sources[0]?.url).toBe("https://github.com/a/missing");
    expect(imported.unmatched_sources[0]?.branch).toBe("main");
    expect(imported.unmatched_sources[0]?.tag).toBe("v1.0.0");
    expect(imported.unmatched_sources[0]?.import_rules).toEqual(["parts/"]);
    expect(imported.unmatched_sources[0]?.manifest_community_slug).toBe("example-manifest");
    expect(loadKitManifest(repo, imported.profile_id).selections.head).toBe("sb");
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("parseKitBundleBuffer reads zip bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-kit-buf-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    const source = repo.createSource({ name: "R", url: "https://github.com/a/b" });
    const plan = repo.createProfile("KitPlan", source.id);
    const bundlePath = exportEditableKitBundle(repo, plan.id, join(dir, "exports"));
    const data = parseKitBundleBuffer(readFileSync(bundlePath), bundlePath);
    expect(data.format).toBe(KIT_FORMAT);
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("printables adapter returns not supported", () => {
    const meta = fetchPrintablesMetadata("https://www.printables.com/model/123");
    expect(meta.supported).toBe(false);
    expect(meta.message).toContain("Printables");
  });

  it("S3 storage resolvePath uses tenant prefix", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-s3-"));
    const storage = new SaasS3StoragePort("test-bucket", "tenant-a", dir);
    expect(storage.resolvePath("exports/foo.zip")).toBe("s3://test-bucket/tenant-a/exports/foo.zip");
    rmSync(dir, { recursive: true, force: true });
  });

  it("createSaasPorts with DATABASE_URL defers repository until connect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-saas-pg-"));
    process.env.DATABASE_URL = "postgresql://printpartner:printpartner@localhost:5432/printpartner";
    const { createSaasPorts } = await import("./adapters/saas/index.js");
    expect(() => createSaasPorts(dir)).not.toThrow();
    const ports = createSaasPorts(dir);
    expect(ports.db.defaultRepository).toBeNull();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
  });

  it("saas health includes db when anonymous allowed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-saas-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    process.env.DEPLOY_MODE = "saas";
    process.env.SAAS_DATA_DIR = dir;
    process.env.SAAS_ALLOW_ANONYMOUS = "1";
    delete process.env.DATABASE_URL;

    const config = loadConfig();
    const { createSaasPorts } = await import("./adapters/saas/index.js");
    const ports = createSaasPorts(dir);
    await ports.db.connect();
    const app = await buildApp(config, ports);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      deploy_mode: string;
      db: { driver: string; support_status: string };
    };
    expect(body.ok).toBe(true);
    expect(body.deploy_mode).toBe("saas");
    expect(body.db).toMatchObject({
      driver: "sqlite",
      support_status: "supported",
    });

    await app.close();
    await ports.db.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DEPLOY_MODE;
    delete process.env.SAAS_DATA_DIR;
    delete process.env.SAAS_ALLOW_ANONYMOUS;
  });

  it("tenant context scopes repository queries", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-ten-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), "default", sqlite.reposDir);
    setRequestTenantId("tenant-b");
    repo.createSource({ name: "T", url: "https://github.com/a/b" });
    setRequestTenantId("default");
    expect(repo.listSources().length).toBe(0);
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
