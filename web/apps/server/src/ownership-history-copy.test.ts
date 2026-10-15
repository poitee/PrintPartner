import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema.js";
import { schemaMigrations } from "./db/migrations-sqlite.js";
import { digestPlanRevisionParts } from "./services/plan-publication.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { SqliteDatabase, getDb } from "./db/client.js";
import { AppRepository } from "./db/repository.js";
import { backfillAcceptedPlanRevisions } from "./db/accepted-plan-revisions.js";
import { backfillCurrentRequiredUnitSets } from "./db/required-units.js";
import { digestFormat1Inputs } from "./db/accepted-plan-operational-model.js";
import { digestRequiredUnitMap } from "./services/required-units.js";
import { captureAcceptedOperationalExport } from "./services/accepted-operational-export.js";
import { materializeAcceptedChecklistHtml } from "./services/export-html.js";
import { EMPTY_KIT_MANIFEST } from "./services/kit-manifest-store.js";
import { buildKitBundleData, writeKitBundleData, loadKitBundleBytes } from "./services/export-kit.js";
import { digestPlanInputs } from "./services/plan-freshness.js";
import { executeOwnershipCopy, inspectOwnershipCopy } from "./ownership-migration.js";
import { ownershipHistoryTables } from "./ownership-history.js";
import { tenantExportDirectory } from "./lib/secure-path.js";
import { registerExportRoutes } from "./routes/exports.js";

const roots: string[] = [];
const now = "2026-10-15T00:00:00.000Z";
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
beforeEach(() => { process.env.PP_DESKTOP_REBUILD = "1"; });
afterEach(() => { delete process.env.PP_DESKTOP_REBUILD; roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function edit(source: string, operation: (db: Database.Database) => void) {
  const db = new Database(join(source, "print-partner.db"));
  try { db.pragma("foreign_keys = OFF"); operation(db); } finally { db.close(); }
}
function fixture(tracked = true) {
  const root = mkdtempSync(join(tmpdir(), "pp-history-copy-")); roots.push(root);
  const sourceDir = join(root, "source"); mkdirSync(sourceDir);
  const initialized = new SqliteDatabase(sourceDir); initialized.connect(); initialized.close();
  edit(sourceDir, db => {
    db.exec(`INSERT INTO users (id,display_name,created_at) VALUES ('account-a','A','${now}'),('account-b','B','${now}');
      INSERT INTO projects (id,name,url) VALUES (1,'Source A','https://example.test/a'),(2,'Source B','https://example.test/b');
      INSERT INTO build_profiles (id,name) VALUES (1,'Plan A'),(2,'Plan B');
      INSERT INTO parts (id,profile_id,match_key,relative_path,filename,source_layer) VALUES (1,1,'a','a.stl','a.stl','base:A'),(2,2,'b','b.stl','b.stl','base:B');
      INSERT INTO print_progress (id,part_id,unit_index) VALUES (1,1,0),(2,2,0);`);
    for (const id of [1, 2]) {
      for (const version of [1, 2]) {
        const locator = `${id}/revisions/commit-${version}`;
        const snapshot = join(sourceDir, "repos", locator); mkdirSync(snapshot, { recursive: true });
        writeFileSync(join(snapshot, id === 1 ? "a.stl" : "b.stl"), `Source ${id} v${version}`);
        db.prepare("INSERT INTO source_revisions (id,project_id,upstream_revision_key,manifest_digest,snapshot_locator,synced_at) VALUES (?,?,?,?,?,?)")
          .run(id * 10 + version, id, `commit-${version}`, hash(`manifest-${id}-${version}`), locator, now);
      }
      db.prepare("UPDATE projects SET current_source_revision_id=?,local_path=? WHERE id=?").run(id * 10 + 2, join(sourceDir, "repos", `${id}/revisions/commit-2`), id);
      if (tracked) {
        const inputs = [{ source_id: id, source_layer: id === 1 ? "base:A" : "base:B", layer_order: 0, tracking_kind: "revision" as const,
          source_revision_id: id * 10 + 2, manifest_digest: hash(`manifest-${id}-2`), effective_naming_digest: "c".repeat(64) }];
        db.prepare("INSERT INTO plan_revision_input_sets (id,profile_id,input_set_digest,expected_input_count,format_version,recorded_at,published_at) VALUES (?,?,?,1,2,?,?)")
          .run(id, id, digestPlanInputs(inputs), now, now);
        db.prepare("INSERT INTO plan_revision_inputs (id,input_set_id,source_id,source_layer,source_revision_id,manifest_digest,effective_naming_digest) VALUES (?,?,?,?,?,?,?)")
          .run(id, id, id, inputs[0]!.source_layer, id * 10 + 2, inputs[0]!.manifest_digest, inputs[0]!.effective_naming_digest);
        db.prepare("INSERT INTO plan_accepted_input_sets VALUES ('default',?,?,?)").run(id, id, now);
      }
    }
    backfillAcceptedPlanRevisions(db, now);
    backfillCurrentRequiredUnitSets(db, { now: () => now });
    if (tracked) {
      const triggers = z.array(z.object({ sql: z.string() })).parse(db.prepare("SELECT sql FROM sqlite_schema WHERE name IN ('trg_plan_revision_parts_immutable_update','trg_plan_revisions_immutable_update')").all());
      db.exec("DROP TRIGGER trg_plan_revision_parts_immutable_update; DROP TRIGGER trg_plan_revisions_immutable_update");
      for (const id of [1, 2]) db.prepare("UPDATE plan_revision_parts SET artifact_digest=? WHERE revision_id=?").run(hash(`Source ${id} v2`), id);
      const parts = drizzle(db).select().from(schema.planRevisionParts).all();
      for (const id of [1, 2]) db.prepare("UPDATE plan_revisions SET snapshot_digest=? WHERE id=?").run(digestPlanRevisionParts(parts.filter(part => part.revisionId === id)), id);
      triggers.forEach(trigger => db.exec(trigger.sql));
    }
    db.pragma("journal_mode = DELETE");
  });
  return { sourceDir, destinationDir: join(root, "copy") };
}
function manifest(sourceDir: string) {
  const inventory = inspectOwnershipCopy({ sourceDir });
  const db = new Database(join(sourceDir, "print-partner.db"), { readonly: true });
  try {
    const claims = inventory.claims.map(claim => {
      const row = z.record(z.string(), z.unknown()).parse(db.prepare(`SELECT rowid AS __rowid,* FROM "${claim.table}" WHERE rowid=?`).get(claim.rowid));
      let plan = row.profile_id ?? row.project_id ?? row.source_id;
      if (claim.table === "projects" || claim.table === "build_profiles") plan = row.id;
      if (claim.table === "plan_revision_parts" || claim.table === "plan_revision_required_units" || claim.table === "plan_revision_required_unit_sets") plan = row.revision_id;
      if (claim.table === "parts" || claim.table === "print_progress") plan = row.profile_id ?? row.part_id;
      return { ...claim, user_id: plan === 2 ? "account-b" : "account-a" };
    });
    return { version: 1, source_digest: inventory.source_digest, selected_user_id: "account-a", claims,
      exports: inventory.exports.map(artifact => ({ path: artifact.path, sha256: artifact.sha256, profile_id: artifact.profile_id, user_id: artifact.profile_id === 2 ? "account-b" : "account-a" })) };
  } finally { db.close(); }
}
function files(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => { for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name.startsWith(".desktop")) continue;
    const path = join(dir, name.name); const key = prefix + name.name;
    if (name.isDirectory()) walk(path, `${key}/`); else result[key] = hash(readFileSync(path));
  } };
  walk(root, ""); return result;
}
async function refused(paths: ReturnType<typeof fixture>, input: ReturnType<typeof manifest>) {
  const before = files(paths.sourceDir);
  await expect(executeOwnershipCopy({ ...paths, manifest: input })).rejects.toThrow();
  expect(existsSync(paths.destinationDir)).toBe(false);
  expect(files(paths.sourceDir)).toEqual(before);
  expect(readdirSync(join(paths.sourceDir, "..")).filter(name => name.startsWith(".ownership-copy-"))).toEqual([]);
}
function addExport(source: string, id: number, kind: "checklist" | "direct-3mf" | "kit", scope = "tenant-default") {
  const bytes = `Artifact ${id} ${kind}`; const digest = hash(bytes);
  const filename = kind === "checklist" ? `checklist-${digest}.html` : kind === "direct-3mf" ? `direct-${digest.slice(0, 16)}.3mf` : `Plan-20261015T000000-${digest}.print-partner-kit.zip`;
  const key = `profile-${id}-Plan/${kind}/${filename}`;
  const path = join(source, "exports", scope, key); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, bytes);
  return { key, path, bytes };
}

it.each([true, false])("copies tracked=%s accepted history and keeps both owners isolated after restart", async tracked => {
  const paths = fixture(tracked); const before = files(paths.sourceDir);
  const input = manifest(paths.sourceDir);
  for (const table of ownershipHistoryTables) expect(inspectOwnershipCopy(paths).tables.some(entry => entry.table === table)).toBe(true);
  await executeOwnershipCopy({ ...paths, manifest: input });
  expect(files(paths.sourceDir)).toEqual(before);
  const source = new Database(join(paths.sourceDir, "print-partner.db"), { readonly: true });
  const copy = new Database(join(paths.destinationDir, "print-partner.db"));
  try {
    for (const table of ownershipHistoryTables) {
      const beforeRows = source.prepare(`SELECT rowid AS __rowid,* FROM "${table}" ORDER BY rowid`).all();
      const afterRows = copy.prepare(`SELECT rowid AS __rowid,* FROM "${table}" ORDER BY rowid`).all();
      expect(afterRows).toEqual(beforeRows.map(raw => { const row = z.record(z.string(), z.unknown()).parse(raw); return { ...row, tenant_id: input.claims.find(claim => claim.table === table && claim.rowid === row.__rowid)?.user_id ?? row.tenant_id }; }));
    }
    expect(copy.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all()).toEqual(source.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all());
    for (const table of ["plan_revisions", "plan_revision_parts", "required_units", "plan_revision_required_units", "plan_revision_required_unit_sets"]) expect(() => copy.exec(`UPDATE "${table}" SET tenant_id='default'`)).toThrow(/immutable/);
    expect(copy.pragma("foreign_key_check")).toEqual([]);
    expect(copy.prepare("SELECT local_path FROM projects WHERE id=1").get()).toEqual({ local_path: join(paths.destinationDir, "repos/1/revisions/commit-2") });
  } finally { source.close(); copy.close(); }
  for (let restart = 0; restart < 2; restart++) {
    const store = new SqliteDatabase(paths.destinationDir); store.connect();
    try {
      const a = new AppRepository(getDb(store), "account-a", store.reposDir);
      const b = new AppRepository(getDb(store), "account-b", store.reposDir);
      expect(a.getAcceptedPlanRevision(1)?.parts.map(part => part.partKey)).toEqual(["a"]);
      expect(b.getAcceptedPlanRevision(2)?.parts.map(part => part.partKey)).toEqual(["b"]);
      expect(a.readAcceptedPlanOperationalSnapshot(1).kind).toBe("ready");
      expect(b.readAcceptedPlanOperationalSnapshot(2).kind).toBe("ready");
      expect(a.getAcceptedPlanRevision(2)).toBeNull(); expect(b.getAcceptedPlanRevision(1)).toBeNull();
      expect(a.listSourceRevisions(1).map(revision => revision.id)).toEqual(expect.arrayContaining([11, 12]));
      expect(a.getSourceRevision(22)).toBeNull(); expect(b.getSourceRevision(12)).toBeNull();
      expect(readFileSync(join(paths.destinationDir, "repos/1/revisions/commit-1/a.stl"), "utf8")).toBe("Source 1 v1");
      if (tracked) expect(a.getAcceptedPlanRevisionInputSet(1)?.inputs[0]?.source_revision_id).toBe(12);
    } finally { store.close(); }
  }
});

it.each(ownershipHistoryTables)("requires an explicit owner for every %s history row", async table => {
  const paths = fixture(); const input = manifest(paths.sourceDir);
  const selected = input.claims.findIndex(claim => claim.table === table);
  expect(selected).toBeGreaterThanOrEqual(0); input.claims.splice(selected, 1);
  await refused(paths, input);
});
it.each(ownershipHistoryTables)("refuses conflicting %s history owners", async table => {
  const paths = fixture(); const input = manifest(paths.sourceDir);
  const selected = input.claims.find(claim => claim.table === table); expect(selected).toBeDefined();
  if (selected) selected.user_id = selected.user_id === "account-a" ? "account-b" : "account-a";
  await refused(paths, input);
});

it.each(["pointer", "active-source", "source-input", "input-plan", "projection-plan", "snapshot-path", "missing-snapshot", "snapshot-symlink", "input-digest", "revision-digest", "unit-digest", "unpublished"])("refuses unsafe %s history during inspect and apply", async kind => {
  const paths = fixture(); const input = manifest(paths.sourceDir);
  edit(paths.sourceDir, db => {
    if (kind === "pointer") { db.exec("DROP TRIGGER trg_build_profiles_revision_ownership_update; UPDATE build_profiles SET accepted_plan_revision_id=2 WHERE id=1"); }
    if (kind === "active-source") db.exec("UPDATE projects SET current_source_revision_id=22 WHERE id=1");
    if (kind === "source-input") db.exec("UPDATE plan_revision_inputs SET source_revision_id=22 WHERE id=1");
    if (kind === "input-plan") { db.exec("DROP TRIGGER trg_plan_revisions_immutable_update; UPDATE plan_revisions SET input_set_id=2 WHERE id=1"); }
    if (kind === "projection-plan") { db.exec("DROP TRIGGER trg_plan_revision_parts_immutable_update; UPDATE plan_revision_parts SET projection_part_id=2 WHERE id=1"); }
    if (kind === "snapshot-path") db.exec("UPDATE source_revisions SET snapshot_locator='../outside' WHERE id=11");
    if (kind === "input-digest") db.exec("UPDATE plan_revision_input_sets SET input_set_digest='wrong' WHERE id=1");
    if (kind === "revision-digest") db.exec("DROP TRIGGER trg_plan_revisions_immutable_update; UPDATE plan_revisions SET snapshot_digest='wrong' WHERE id=1");
    if (kind === "unit-digest") db.exec("DROP TRIGGER trg_plan_revision_required_unit_sets_immutable_update; UPDATE plan_revision_required_unit_sets SET mapping_digest='wrong' WHERE revision_id=1");
    if (kind === "unpublished") db.exec("UPDATE plan_revision_input_sets SET published_at=NULL WHERE id=1");
    input.source_digest = hash(db.serialize());
  });
  if (kind === "missing-snapshot" || kind === "snapshot-symlink") {
    const path = join(paths.sourceDir, "repos/1/revisions/commit-1"); rmSync(path, { recursive: true });
    if (kind === "snapshot-symlink") symlinkSync(join(paths.sourceDir, "repos/2/revisions/commit-1"), path);
  }
  expect(() => inspectOwnershipCopy(paths)).toThrow();
  if (kind === "snapshot-symlink") {
    await expect(executeOwnershipCopy({ ...paths, manifest: input })).rejects.toThrow(); expect(existsSync(paths.destinationDir)).toBe(false);
  } else await refused(paths, input);
});

it("copies supported export bytes into each mapped tenant and serves only that tenant", async () => {
  const paths = fixture();
  const exports = [addExport(paths.sourceDir, 1, "checklist"), addExport(paths.sourceDir, 1, "direct-3mf"), addExport(paths.sourceDir, 2, "kit")];
  const before = files(paths.sourceDir); const input = manifest(paths.sourceDir);
  await executeOwnershipCopy({ ...paths, manifest: input }); expect(files(paths.sourceDir)).toEqual(before);
  const app = Fastify(); app.addHook("onRequest", async request => { request.tenantId = String(request.headers["x-test-tenant"]); });
  await registerExportRoutes(app, { dataDir: paths.destinationDir });
  try {
    for (const artifact of exports) {
      const owner = artifact.key.startsWith("profile-2-") ? "account-b" : "account-a";
      expect(readFileSync(join(tenantExportDirectory(join(paths.destinationDir, "exports"), owner), artifact.key), "utf8")).toBe(artifact.bytes);
      const url = `/exports/${artifact.key}`;
      expect((await app.inject({ url, headers: { "x-test-tenant": owner } })).body).toBe(artifact.bytes);
      for (const other of ["default", owner === "account-a" ? "account-b" : "account-a"]) expect((await app.inject({ url, headers: { "x-test-tenant": other } })).statusCode).toBe(404);
    }
    expect(existsSync(join(paths.destinationDir, "exports/tenant-default"))).toBe(false);
  } finally { await app.close(); }
});
it.each(["missing", "duplicate", "wrong-owner", "wrong-plan", "wrong-digest", "extra", "changed", "added"])("refuses %s export claims without publishing", async kind => {
  const paths = fixture(); const artifact = addExport(paths.sourceDir, 1, "checklist"); const input = manifest(paths.sourceDir);
  const claim = input.exports[0]!;
  if (kind === "missing") input.exports = [];
  if (kind === "duplicate") input.exports.push({ ...claim });
  if (kind === "wrong-owner") claim.user_id = "account-b";
  if (kind === "wrong-plan") claim.profile_id = 2;
  if (kind === "wrong-digest") claim.sha256 = "a".repeat(64);
  if (kind === "extra") input.exports.push({ ...claim, path: "nonexistent.html" });
  if (kind === "changed") writeFileSync(artifact.path, "changed bytes");
  if (kind === "added") addExport(paths.sourceDir, 2, "kit");
  await refused(paths, input);
});
it.each(["unknown-plan", "wrong-scope", "unknown-layout", "symlink", "collision"])("refuses %s export artifacts", async kind => {
  const paths = fixture(); const input = manifest(paths.sourceDir);
  if (kind === "unknown-plan") addExport(paths.sourceDir, 999, "checklist");
  if (kind === "wrong-scope") addExport(paths.sourceDir, 1, "checklist", "tenant-x6163636f756e742d62");
  if (kind === "unknown-layout") { const dir = join(paths.sourceDir, "exports"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "old.zip"), "ambiguous"); }
  if (kind === "symlink") { const artifact = addExport(paths.sourceDir, 1, "checklist"); rmSync(artifact.path); symlinkSync(join(paths.sourceDir, "print-partner.db"), artifact.path); }
  if (kind === "collision") { addExport(paths.sourceDir, 1, "checklist"); addExport(paths.sourceDir, 1, "checklist", ""); }
  if (kind === "collision") {
    const claimed = manifest(paths.sourceDir); await refused(paths, claimed);
  } else {
    expect(() => inspectOwnershipCopy(paths)).toThrow();
    await expect(executeOwnershipCopy({ ...paths, manifest: input })).rejects.toThrow(); expect(existsSync(paths.destinationDir)).toBe(false);
  }
});

it.each([false, true])("validates retained parent Plan history, corrupt=%s", async corrupt => {
  const paths = fixture();
  edit(paths.sourceDir, raw => {
    const db = drizzle(raw);
    const revision = db.select().from(schema.planRevisions).all().find(row => row.id === 1)!;
    const part = db.select().from(schema.planRevisionParts).all().find(row => row.revisionId === 1)!;
    const mapping = db.select().from(schema.planRevisionRequiredUnits).all().find(row => row.revisionId === 1)!;
    const unit = db.select().from(schema.requiredUnits).all().find(row => row.token === mapping.requiredUnitToken)!;
    db.insert(schema.planRevisions).values({ ...revision, id: 3, revisionNumber: 2, parentRevisionId: 1 }).run();
    db.insert(schema.planRevisionParts).values({ ...part, id: 3, revisionId: 3 }).run();
    db.insert(schema.planRevisionRequiredUnits).values({ ...mapping, revisionId: 3, revisionPartId: 3 }).run();
    const header = db.select().from(schema.planRevisionRequiredUnitSets).all().find(row => row.revisionId === 1)!;
    db.insert(schema.planRevisionRequiredUnitSets).values({ ...header, revisionId: 3,
      mappingDigest: digestRequiredUnitMap({ revisionId: 3, expectedUnitCount: 1, rows: [{ revisionPartId: 3, unitIndex: 0, token: unit.token, objectName: unit.objectName }] }) }).run();
    raw.exec("UPDATE build_profiles SET accepted_plan_revision_id=3,accepted_plan_version=2 WHERE id=1");
  });
  const input = manifest(paths.sourceDir);
  if (corrupt) {
    edit(paths.sourceDir, db => { db.exec("DROP TRIGGER trg_plan_revisions_immutable_update; UPDATE plan_revisions SET snapshot_digest='wrong' WHERE id=1"); input.source_digest = hash(db.serialize()); });
    expect(() => inspectOwnershipCopy(paths)).toThrow(); await refused(paths, input);
  } else {
    await executeOwnershipCopy({ ...paths, manifest: input });
    const copy = new Database(join(paths.destinationDir, "print-partner.db"));
    try { expect(copy.prepare("SELECT id,parent_revision_id,tenant_id FROM plan_revisions WHERE profile_id=1 ORDER BY id").all()).toEqual([
      { id: 1, parent_revision_id: null, tenant_id: "account-a" }, { id: 3, parent_revision_id: 1, tenant_id: "account-a" },
    ]); } finally { copy.close(); }
  }
});
it("preserves existing foreign export ownership and refuses reassignment", async () => {
  const paths = fixture();
  edit(paths.sourceDir, db => db.exec("INSERT INTO build_profiles (id,tenant_id,name) VALUES (9,'account-b','Foreign')"));
  const artifact = addExport(paths.sourceDir, 9, "checklist", tenantExportDirectory("", "account-b"));
  const input = manifest(paths.sourceDir); input.exports[0]!.user_id = "account-b";
  await refused(paths, { ...input, exports: [{ ...input.exports[0]!, user_id: "account-a" }] });
  await executeOwnershipCopy({ ...paths, manifest: input });
  expect(readFileSync(join(tenantExportDirectory(join(paths.destinationDir, "exports"), "account-b"), artifact.key), "utf8")).toBe(artifact.bytes);
});
it.each(["changed-export", "changed-repository", "missing-trigger", "replaced-trigger"])("refuses %s across the backup boundary", async kind => {
  const paths = fixture(); const artifact = addExport(paths.sourceDir, 1, "checklist"); const input = manifest(paths.sourceDir);
  if (kind.endsWith("trigger")) edit(paths.sourceDir, db => {
    db.exec("DROP TRIGGER trg_plan_revisions_immutable_update");
    if (kind === "replaced-trigger") db.exec("CREATE TRIGGER trg_plan_revisions_immutable_update BEFORE UPDATE ON plan_revisions BEGIN SELECT 1; END");
    input.source_digest = hash(db.serialize());
  });
  const pending = executeOwnershipCopy({ ...paths, manifest: input });
  if (kind === "changed-export") writeFileSync(artifact.path, "changed while backing up");
  if (kind === "changed-repository") writeFileSync(join(paths.sourceDir, "repos/1/revisions/commit-1/a.stl"), "changed while backing up");
  await expect(pending).rejects.toThrow(); expect(existsSync(paths.destinationDir)).toBe(false);
  expect(readdirSync(join(paths.sourceDir, "..")).filter(name => name.startsWith(".ownership-copy-"))).toEqual([]);
});
it("copies actual checklist and kit publications without changing their bytes", async () => {
  const paths = fixture();
  const raw = new Database(join(paths.sourceDir, "print-partner.db"));
  const repo = new AppRepository(drizzle(raw, { schema }), "default", join(paths.sourceDir, "repos"));
  const capture = captureAcceptedOperationalExport({ repository: repo, profileId: 1 });
  expect(capture.kind).toBe("ready");
  if (capture.kind !== "ready") throw new Error("Expected accepted export");
  const exportsDir = tenantExportDirectory(join(paths.sourceDir, "exports"), "default");
  const checklist = materializeAcceptedChecklistHtml({ capture, tenantExportsDir: exportsDir, thumbsDir: join(paths.sourceDir, "thumbs"), dateFormat: "ymd_24h", generatedAt: now });
  expect(checklist.kind).toBe("materialized");
  if (checklist.kind !== "materialized") throw new Error("Expected checklist publication");
  const data = buildKitBundleData({ mode: { kind: "accepted_progress", accepted: capture.export,
    recipe: { profile: capture.export.profile, workingParts: [], layers: [], kitManifest: EMPTY_KIT_MANIFEST, sources: [] } }, exportedAt: now });
  const kit = writeKitBundleData({ data, profileId: 1, profileName: "Plan A", exportsDir });
  raw.close();
  const input = manifest(paths.sourceDir); const before = [checklist.path, kit].map(path => hash(readFileSync(path)));
  await executeOwnershipCopy({ ...paths, manifest: input });
  const copied = input.exports.map(artifact => join(tenantExportDirectory(join(paths.destinationDir, "exports"), "account-a"), artifact.path.split("/").slice(1).join("/")));
  expect(copied.map(path => hash(readFileSync(path))).sort()).toEqual(before.sort());
  expect(loadKitBundleBytes(copied.find(path => path.endsWith(".zip"))!)).toEqual(data);
});

it.each(["inspect", "apply"])("%s refuses normalized cross-Source local paths", async mode => {
  const paths = fixture(); const input = manifest(paths.sourceDir);
  edit(paths.sourceDir, db => {
    db.prepare("UPDATE projects SET local_path=? WHERE id=1").run(`${paths.sourceDir}/repos/1/../2/revisions/commit-2`);
    input.source_digest = hash(db.serialize());
  });
  if (mode === "inspect") expect(() => inspectOwnershipCopy(paths)).toThrow("Unsafe Source local_path");
  else await refused(paths, input);
});
it("copies valid format-1 accepted history while retaining its uninitialized operational state", async () => {
  const paths = fixture();
  edit(paths.sourceDir, db => {
    for (const id of [1, 2]) {
      const manifestDigest = hash(`manifest-${id}-2`);
      db.prepare("UPDATE plan_revision_inputs SET source_layer=?,effective_naming_digest=NULL WHERE id=?").run(`legacy:${id}`, id);
      db.prepare("UPDATE plan_revision_input_sets SET format_version=1,input_set_digest=? WHERE id=?")
        .run(digestFormat1Inputs([{ sourceRevisionId: id * 10 + 2, manifestDigest }]), id);
    }
  });
  const input = manifest(paths.sourceDir); const before = files(paths.sourceDir);
  await executeOwnershipCopy({ ...paths, manifest: input }); expect(files(paths.sourceDir)).toEqual(before);
  const store = new SqliteDatabase(paths.destinationDir); store.connect();
  try {
    const repo = new AppRepository(getDb(store), "account-a", store.reposDir);
    expect(repo.getAcceptedPlanRevisionInputSet(1)?.format_version).toBe(1);
    expect(repo.readAcceptedPlanOperationalSnapshot(1).kind).toBe("uninitialized");
    expect(repo.getAcceptedPlanRevision(2)).toBeNull();
  } finally { store.close(); }
});
it.each(["absent", "partial-mapping", "orphan-unit"])("copies retained pre-map history only when its map state is %s", async state => {
  const paths = fixture(); const originalInput = manifest(paths.sourceDir);
  edit(paths.sourceDir, raw => {
    const db = drizzle(raw);
    const revision = db.select().from(schema.planRevisions).all().find(row => row.id === 1)!;
    const part = db.select().from(schema.planRevisionParts).all().find(row => row.revisionId === 1)!;
    raw.exec("DROP TRIGGER trg_plan_revisions_immutable_update");
    raw.exec("UPDATE plan_revisions SET revision_number=2 WHERE id=1");
    db.insert(schema.planRevisions).values({ ...revision, id: 3 }).run();
    db.insert(schema.planRevisionParts).values({ ...part, id: 3, revisionId: 3 }).run();
    raw.exec("UPDATE plan_revisions SET parent_revision_id=3 WHERE id=1");
    raw.exec(schemaMigrations.find(sql => sql.startsWith("CREATE TRIGGER IF NOT EXISTS trg_plan_revisions_immutable_update\n"))!);
    if (state === "partial-mapping") {
      const mapping = db.select().from(schema.planRevisionRequiredUnits).all().find(row => row.revisionId === 1)!;
      db.insert(schema.planRevisionRequiredUnits).values({ ...mapping, revisionId: 3, revisionPartId: 3 }).run();
    }
    if (state === "orphan-unit") db.insert(schema.requiredUnits).values({ token: "ppu_" + "f".repeat(32), objectName: "old__ppu_" + "f".repeat(32),
      tenantId: "default", profileId: 1, createdInRevisionId: 3, createdAt: now }).run();
  });
  if (state !== "absent") {
    expect(() => inspectOwnershipCopy(paths)).toThrow("missing or partial Required-unit map");
    edit(paths.sourceDir, db => { originalInput.source_digest = hash(db.serialize()); });
    await refused(paths, originalInput); return;
  }
  const input = manifest(paths.sourceDir); const before = files(paths.sourceDir);
  await executeOwnershipCopy({ ...paths, manifest: input }); expect(files(paths.sourceDir)).toEqual(before);
  const store = new SqliteDatabase(paths.destinationDir); store.connect();
  try {
    expect(new AppRepository(getDb(store), "account-a", store.reposDir).readAcceptedPlanOperationalSnapshot(1).kind).toBe("ready");
    const copy = new Database(join(paths.destinationDir, "print-partner.db"), { readonly: true });
    try { expect(copy.prepare("SELECT tenant_id FROM plan_revisions WHERE id=3").get()).toEqual({ tenant_id: "account-a" });
      expect(copy.prepare("SELECT * FROM plan_revision_required_unit_sets WHERE revision_id=3").all()).toEqual([]);
    } finally { copy.close(); }
  } finally { store.close(); }
});
