import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema.js";
import { schemaMigrations } from "./db/migrations-sqlite.js";
import { digestPlanRevisionParts, MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES } from "./services/plan-publication.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { layoutDigest, LEGACY_ACCEPTED_PLATE_LAYOUT_FORMAT } from "./db/accepted-plate-layout-model.js";
import { validateOwnershipPlateTextBytes } from "./ownership-plate-history.js";
import * as plateReader from "./db/accepted-plates.js";
import * as operationalReader from "./db/accepted-plan-operational.js";
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
afterEach(() => { vi.restoreAllMocks(); delete process.env.PP_DESKTOP_REBUILD; roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function edit(source: string, operation: (db: Database.Database) => void) {
  const db = new Database(join(source, "print-partner.db"));
  try { db.pragma("foreign_keys = OFF"); operation(db); } finally { db.close(); }
}
function fixture(tracked = true, quantity = 1) {
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
    db.prepare("UPDATE parts SET quantity_auto=?,quantity_effective=?").run(quantity, quantity);
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
function appendAcceptedRevision(sourceDir: string) {
  edit(sourceDir, raw => {
    const db = drizzle(raw);
    const revision = db.select().from(schema.planRevisions).all().filter(row => row.profileId === 1).sort((left, right) => right.revisionNumber - left.revisionNumber)[0];
    const part = db.select().from(schema.planRevisionParts).all().find(row => row.revisionId === revision?.id);
    const mapping = db.select().from(schema.planRevisionRequiredUnits).all().find(row => row.revisionId === revision?.id);
    const unit = db.select().from(schema.requiredUnits).all().find(row => row.token === mapping?.requiredUnitToken);
    const header = db.select().from(schema.planRevisionRequiredUnitSets).all().find(row => row.revisionId === revision?.id);
    if (!revision || !part || !mapping || !unit || !header) throw new Error("Missing accepted parent fixture");
    const child = db.insert(schema.planRevisions).values({ ...revision, id: undefined, revisionNumber: revision.revisionNumber + 1, parentRevisionId: revision.id }).returning().get();
    const childPart = db.insert(schema.planRevisionParts).values({ ...part, id: undefined, revisionId: child.id }).returning().get();
    db.insert(schema.planRevisionRequiredUnits).values({ ...mapping, revisionId: child.id, revisionPartId: childPart.id }).run();
    db.insert(schema.planRevisionRequiredUnitSets).values({ ...header, revisionId: child.id,
      mappingDigest: digestRequiredUnitMap({ revisionId: child.id, expectedUnitCount: 1, rows: [{ revisionPartId: childPart.id, unitIndex: 0, token: unit.token, objectName: unit.objectName }] }) }).run();
    raw.prepare("UPDATE build_profiles SET accepted_plan_revision_id=?,accepted_plan_version=? WHERE id=1").run(child.id, child.revisionNumber);
  });
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
      if (claim.table === "accepted_plates" || claim.table === "accepted_plate_units") {
        plan = z.object({ profile_id: z.number() }).parse(db.prepare("SELECT profile_id FROM accepted_plate_revisions WHERE id=?").get(z.number().parse(row.revision_id))).profile_id;
      }
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

function plateFixture(quantity = 1) {
  const paths = fixture(true, quantity);
  const store = new SqliteDatabase(paths.sourceDir); store.connect();
  try {
    const repo = new AppRepository(getDb(store), "default", store.reposDir);
    for (const profileId of [1, 2]) {
      const setup = repo.readAcceptedPlateWorkspaceInput(profileId);
      if (setup.kind !== "setup" || !setup.units[0]) throw new Error("Missing Plate setup");
      const token = setup.units[0].token;
      const published = repo.publishAcceptedPlates({ profileId, expected: setup.basis, expectedPlateRevisionId: null,
        plates: [{ plateId: "plate-main", printerId: "printer", printerName: "Printer", printerModel: "Model",
          bedWidthUm: 250000, bedDepthUm: 220000, bedHeightUm: 220000, marginUm: 5000,
          units: [{ token, xUm: 5000, yUm: 5000, widthUm: 50000, depthUm: 40000, heightUm: 30000 }] }] });
      if (published.kind !== "published") throw new Error(`Plate publication failed ${published.kind}`);
      const moved = repo.moveAcceptedPlateUnit({ profileId, expected: setup.basis, expectedPlateRevisionId: published.plateRevisionId,
        plateId: "plate-main", token, xUm: 15000, yUm: 15000 });
      if (moved.kind !== "moved") throw new Error(`Plate move failed ${moved.kind}`);
      const pinned = repo.pinAcceptedPlateUnit({ profileId, expected: setup.basis, expectedPlateRevisionId: moved.plateRevisionId,
        plateId: "plate-main", token, pinned: true });
      if (pinned.kind !== "moved") throw new Error(`Plate pin failed ${pinned.kind}`);
    }
  } finally { store.close(); }
  return paths;
}

it("copies accepted Plate history and reads it after two reopens", async () => {
  const paths = plateFixture();
  const reader = vi.spyOn(plateReader, "readAcceptedPlatesInternal");
  const planReader = vi.spyOn(operationalReader, "readAcceptedPlanOperationalSnapshotInternal");
  const input = manifest(paths.sourceDir);
  reader.mockClear(); planReader.mockClear();
  const before = files(paths.sourceDir);
  await executeOwnershipCopy({ ...paths, manifest: input });
  expect(files(paths.sourceDir)).toEqual(before);
  for (const [tenantId, root] of [["default", paths.sourceDir], ["account-a", ".ownership-copy-"]]) {
    expect(planReader.mock.calls.some(([dependencies], index) => dependencies.profileId === 1 && dependencies.tenantId === tenantId
      && dependencies.reposDir.includes(root ?? "") && planReader.mock.results[index]?.type === "return"
      && planReader.mock.results[index]?.value.kind === "ready")).toBe(true);
    expect(reader.mock.calls.some(([dependencies, profileId], index) => profileId === 1 && dependencies.tenantId === tenantId
      && dependencies.reposDir.includes(root ?? "") && reader.mock.results[index]?.type === "return"
      && reader.mock.results[index]?.value.kind === "ready")).toBe(true);
  }
  const source = new Database(join(paths.sourceDir, "print-partner.db"), { readonly: true });
  const copy = new Database(join(paths.destinationDir, "print-partner.db"));
  try {
    for (const table of ["accepted_plate_revisions", "accepted_plate_heads", "accepted_plates", "accepted_plate_units"]) {
      const original = z.array(z.record(z.string(), z.unknown())).parse(source.prepare(`SELECT rowid AS __rowid,* FROM "${table}" ORDER BY rowid`).all());
      expect(copy.prepare(`SELECT rowid AS __rowid,* FROM "${table}" ORDER BY rowid`).all()).toEqual(original.map(row => ({ ...row,
        tenant_id: input.claims.find(claim => claim.table === table && claim.rowid === row.__rowid)?.user_id })));
    }
    expect(copy.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all())
      .toEqual(source.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all());
    for (const table of ["accepted_plate_revisions", "accepted_plates", "accepted_plate_units"]) {
      expect(() => copy.exec(`UPDATE "${table}" SET tenant_id='default'`)).toThrow(/immutable/);
      expect(() => copy.exec(`DELETE FROM "${table}"`)).toThrow(/immutable/);
    }
    expect(() => copy.exec("UPDATE accepted_plate_heads SET tenant_id='account-b' WHERE profile_id=1")).toThrow();
  } finally { source.close(); copy.close(); }
  const expectedStates = new Map<number, ReturnType<AppRepository["readAcceptedPlates"]>>();
  for (let restart = 0; restart < 2; restart++) {
    for (const [root, owners] of [[paths.sourceDir, ["default", "default"]], [paths.destinationDir, ["account-a", "account-b"]]] as const) {
      const store = new SqliteDatabase(root); store.connect();
      try {
        for (const profileId of [1, 2]) {
          const owner = owners[profileId - 1];
          if (!owner) throw new Error("Missing owner");
          const repo = new AppRepository(getDb(store), owner, store.reposDir);
          const accepted = repo.readAcceptedPlates(profileId);
          if (restart === 0 && root === paths.sourceDir) expectedStates.set(profileId, accepted);
          expect(accepted).toEqual(expectedStates.get(profileId));
          expect(accepted.kind).toBe("ready");
          if (accepted.kind !== "ready") throw new Error("Missing Plate layout");
          expect(accepted.plateRevisionNumber).toBe(3);
          expect(accepted.plates[0]?.units[0]).toMatchObject({ xUm: 15000, yUm: 15000, placement: "manual", pinned: true });
          expect(repo.readAcceptedPlateWorkspaceInput(profileId).kind).toBe("ready");
          expect(repo.readAcceptedPlateExportInput(profileId).kind).toBe("ready");
          if (root === paths.destinationDir) {
            expect(new AppRepository(getDb(store), "default", store.reposDir).readAcceptedPlates(profileId)).toEqual({ kind: "empty_plan" });
            expect(new AppRepository(getDb(store), profileId === 1 ? "account-b" : "account-a", store.reposDir).readAcceptedPlates(profileId)).toEqual({ kind: "empty_plan" });
          }
        }
      } finally { store.close(); }
    }
  }
});

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

it.each([true, false].flatMap(tracked => ["notes", "quantity", "insert", "delete"].map(change => ({ tracked, change }))))(
  "copies tracked=$tracked compatibility_dirty history after a working $change edit", async ({ tracked, change }) => {
    const paths = fixture(tracked);
    edit(paths.sourceDir, db => {
      if (change === "delete") { db.pragma("foreign_keys = ON"); db.exec("DELETE FROM parts WHERE id=1"); }
      if (change === "notes") db.exec("UPDATE parts SET notes='working edit' WHERE id=1");
      if (change === "quantity") db.exec("UPDATE parts SET quantity_override=3,quantity_effective=3 WHERE id=1");
      if (change === "insert") db.exec("INSERT INTO parts (id,profile_id,match_key,relative_path,filename,source_layer) VALUES (3,1,'new','new.stl','new.stl','base:A')");
      expect(db.prepare("SELECT accepted_plan_revision_id,accepted_plan_version FROM build_profiles WHERE id=1").get())
        .toEqual({ accepted_plan_revision_id: null, accepted_plan_version: 1 });
    });
    const reader = vi.spyOn(operationalReader, "readAcceptedPlanOperationalSnapshotInternal");
    const input = manifest(paths.sourceDir); const before = files(paths.sourceDir);
    const dirtyReads = () => reader.mock.calls.flatMap(([dependencies], index) => dependencies.profileId === 1
      ? [{ tenantId: dependencies.tenantId, reposDir: dependencies.reposDir, result: reader.mock.results[index] }]
      : []);
    expect(dirtyReads()).toEqual([{ tenantId: "default", reposDir: join(paths.sourceDir, "repos"),
      result: { type: "return", value: { kind: "compatibility_dirty" } } }]);
    reader.mockClear();
    await executeOwnershipCopy({ ...paths, manifest: input });
    expect(dirtyReads()).toEqual([
      { tenantId: "default", reposDir: join(paths.sourceDir, "repos"), result: { type: "return", value: { kind: "compatibility_dirty" } } },
      { tenantId: "account-a", reposDir: expect.stringMatching(/\/\.ownership-copy-[^/]+\/repos$/),
        result: { type: "return", value: { kind: "compatibility_dirty" } } },
    ]);
    expect(files(paths.sourceDir)).toEqual(before);
    const source = new Database(join(paths.sourceDir, "print-partner.db"), { readonly: true });
    const copy = new Database(join(paths.destinationDir, "print-partner.db"), { readonly: true });
    try {
      for (const table of ["build_profiles", "parts", "print_progress", ...ownershipHistoryTables]) {
        const rows = z.array(z.record(z.string(), z.unknown())).parse(source.prepare(`SELECT rowid AS __rowid,* FROM "${table}" ORDER BY rowid`).all());
        expect(copy.prepare(`SELECT rowid AS __rowid,* FROM "${table}" ORDER BY rowid`).all()).toEqual(rows.map(row => ({
          ...row, tenant_id: input.claims.find(claim => claim.table === table && claim.rowid === row.__rowid)?.user_id ?? row.tenant_id,
        })));
      }
      expect(copy.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name").all()).toEqual(source.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name").all());
    } finally { source.close(); copy.close(); }
    for (let restart = 0; restart < 2; restart++) {
      const store = new SqliteDatabase(paths.destinationDir); store.connect();
      try {
        const a = new AppRepository(getDb(store), "account-a", store.reposDir);
        const b = new AppRepository(getDb(store), "account-b", store.reposDir);
        expect(a.readAcceptedPlanOperationalSnapshot(1)).toEqual({ kind: "compatibility_dirty" });
        expect(a.getAcceptedPlanRevision(1)).toBeNull();
        expect(b.readAcceptedPlanOperationalSnapshot(2).kind).toBe("ready");
        expect(() => b.readAcceptedPlanOperationalSnapshot(1)).toThrow("Profile not found");
        expect(() => a.readAcceptedPlanOperationalSnapshot(2)).toThrow("Profile not found");
        expect(a.getAcceptedPlanRevisionInputSet(1)?.inputs[0]?.source_revision_id ?? null).toBe(tracked ? 12 : null);
      } finally { store.close(); }
    }
  },
);

it.each(["zero-version", "negative-version", "fractional-version", "missing-history", "digest", "artifact", "owner"])(
  "refuses unsafe compatibility_dirty $0 state during inspect and apply", async kind => {
    const paths = fixture(); const input = manifest(paths.sourceDir);
    edit(paths.sourceDir, db => {
      db.exec("UPDATE parts SET notes='working edit' WHERE id=1");
      if (kind === "zero-version") db.exec("UPDATE build_profiles SET accepted_plan_version=0 WHERE id=1");
      if (kind === "negative-version") db.exec("UPDATE build_profiles SET accepted_plan_version=-1 WHERE id=1");
      if (kind === "fractional-version") db.exec("UPDATE build_profiles SET accepted_plan_version=1.5 WHERE id=1");
      if (kind === "missing-history") db.exec("INSERT INTO build_profiles (id,name,accepted_plan_version) VALUES (3,'Missing history',1)");
      if (kind === "digest") db.exec("DROP TRIGGER trg_plan_revisions_immutable_update; UPDATE plan_revisions SET snapshot_digest='wrong' WHERE id=1");
      if (kind === "owner") db.exec("DROP TRIGGER trg_plan_revisions_immutable_update; UPDATE plan_revisions SET tenant_id='account-b' WHERE id=1");
      input.source_digest = hash(db.serialize());
    });
    if (kind === "artifact") writeFileSync(join(paths.sourceDir, "repos/1/revisions/commit-2/a.stl"), "tampered");
    expect(() => inspectOwnershipCopy(paths)).toThrow();
    await refused(paths, input);
  },
);

it.each(["inspect", "apply"].flatMap(mode => ["missing", "other-set", "timestamp"].map(kind => ({ mode, kind }))))("$mode refuses a dirty Plan's $kind retained accepted-input pointer", async ({ mode, kind }) => {
  const paths = fixture();
  edit(paths.sourceDir, raw => {
    raw.exec("UPDATE parts SET notes='working edit' WHERE id=1");
    const db = drizzle(raw);
    const header = db.select().from(schema.planRevisionInputSets).all().find(row => row.id === 1);
    const input = db.select().from(schema.planRevisionInputs).all().find(row => row.id === 1);
    if (!header || !input) throw new Error("Missing tracked fixture inputs");
    const namingDigest = "d".repeat(64);
    const digest = digestPlanInputs([{ source_id: input.sourceId, source_layer: input.sourceLayer, layer_order: input.layerOrder,
      tracking_kind: "revision", source_revision_id: input.sourceRevisionId, manifest_digest: input.manifestDigest, effective_naming_digest: namingDigest }]);
    db.insert(schema.planRevisionInputSets).values({ ...header, id: 3, inputSetDigest: digest }).run();
    db.insert(schema.planRevisionInputs).values({ ...input, id: 3, inputSetId: 3, effectiveNamingDigest: namingDigest }).run();
  });
  const input = manifest(paths.sourceDir);
  edit(paths.sourceDir, db => {
    if (kind === "missing") db.exec("DELETE FROM plan_accepted_input_sets WHERE profile_id=1");
    if (kind === "other-set") db.exec("UPDATE plan_accepted_input_sets SET input_set_id=3 WHERE profile_id=1");
    if (kind === "timestamp") db.exec("UPDATE plan_accepted_input_sets SET accepted_at='2026-10-15T01:00:00.000Z' WHERE profile_id=1");
    input.source_digest = hash(db.serialize());
  });
  if (kind === "missing") input.claims = input.claims.filter(claim => claim.table !== "plan_accepted_input_sets" || claim.rowid !== 1);
  if (mode === "inspect") expect(() => inspectOwnershipCopy(paths)).toThrow(/input/i);
  else await refused(paths, input);
});

it.each(["inspect", "apply"].flatMap(mode => ["missing-map", "version-mismatch"].map(kind => ({ mode, kind }))))(
  "$mode refuses a dirty Plan's $kind inferred current revision", async ({ mode, kind }) => {
    const paths = fixture();
    edit(paths.sourceDir, db => { db.exec("UPDATE parts SET notes='working edit' WHERE id=1"); });
    const input = manifest(paths.sourceDir);
    edit(paths.sourceDir, db => {
      if (kind === "version-mismatch") db.exec("UPDATE build_profiles SET accepted_plan_version=100 WHERE id=1");
      if (kind === "missing-map") {
        const triggers = z.array(z.object({ name: z.string(), sql: z.string() })).parse(db.prepare("SELECT name,sql FROM sqlite_schema WHERE name IN ('trg_plan_revision_required_units_immutable_delete','trg_required_units_immutable_delete','trg_plan_revision_required_unit_sets_immutable_delete')").all());
        for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
        db.exec("DELETE FROM plan_revision_required_units WHERE revision_id=1; DELETE FROM required_units WHERE created_in_revision_id=1; DELETE FROM plan_revision_required_unit_sets WHERE revision_id=1");
        for (const trigger of triggers) db.exec(trigger.sql);
      }
      input.source_digest = hash(db.serialize());
    });
    if (kind === "missing-map") input.claims = input.claims.filter(claim => !["plan_revision_required_units", "required_units", "plan_revision_required_unit_sets"].includes(claim.table) || claim.rowid !== 1);
    if (mode === "inspect") expect(() => inspectOwnershipCopy(paths)).toThrow(kind === "missing-map" ? /Required-unit map/ : /version/);
    else await refused(paths, input);
  },
);

it.each(["inspect", "apply"].flatMap(mode => ["foreign-projection", "invalid-projection", "missing-ready-projection"].map(kind => ({ mode, kind }))))(
  "$mode refuses $kind references after relaxing dirty historical projections", async ({ mode, kind }) => {
    const paths = fixture(); const input = manifest(paths.sourceDir);
    edit(paths.sourceDir, db => {
      if (kind !== "missing-ready-projection") {
        db.exec("UPDATE parts SET notes='working edit' WHERE id=1");
        const trigger = z.object({ sql: z.string() }).parse(db.prepare("SELECT sql FROM sqlite_schema WHERE name='trg_plan_revision_parts_immutable_update'").get());
        db.exec("DROP TRIGGER trg_plan_revision_parts_immutable_update");
        db.prepare("UPDATE plan_revision_parts SET projection_part_id=? WHERE revision_id=1").run(kind === "foreign-projection" ? 2 : -1);
        db.exec(trigger.sql);
      } else {
        db.pragma("foreign_keys = ON");
        db.exec("DELETE FROM parts WHERE id=1; UPDATE build_profiles SET accepted_plan_revision_id=1 WHERE id=1");
      }
      input.source_digest = hash(db.serialize());
    });
    if (kind === "missing-ready-projection") input.claims = input.claims.filter(claim => !["parts", "print_progress"].includes(claim.table) || claim.rowid !== 1);
    if (mode === "inspect") expect(() => inspectOwnershipCopy(paths)).toThrow(kind === "invalid-projection" ? /identity/ : /Part projection Plan/);
    else await refused(paths, input);
  },
);

it.each(["inspect", "apply"].flatMap(mode => ["null-projection", "history-gap", "zero-inferred", "zero-override", "quantity-mismatch", "oversized", "boolean", "oversized-text", "multibyte-text", "combined-text", "actor-text", "source-text"].map(kind => ({ mode, kind }))))(
  "$mode refuses $kind on the inferred immutable revision", async ({ mode, kind }) => {
    const paths = fixture();
    edit(paths.sourceDir, db => { db.exec("UPDATE parts SET notes='working edit' WHERE id=1"); });
    const input = manifest(paths.sourceDir);
    edit(paths.sourceDir, raw => {
      const triggers = z.array(z.object({ name: z.string(), sql: z.string() })).parse(raw.prepare("SELECT name,sql FROM sqlite_schema WHERE name IN ('trg_plan_revision_parts_immutable_update','trg_plan_revisions_immutable_update')").all());
      for (const trigger of triggers) raw.exec(`DROP TRIGGER "${trigger.name}"`);
      if (kind === "null-projection") raw.exec("UPDATE plan_revision_parts SET projection_part_id=NULL WHERE revision_id=1");
      if (kind === "history-gap") raw.exec("UPDATE plan_revisions SET revision_number=2 WHERE id=1; UPDATE build_profiles SET accepted_plan_version=2 WHERE id=1");
      if (kind === "zero-inferred") raw.exec("UPDATE plan_revision_parts SET quantity_inferred=0 WHERE revision_id=1");
      if (kind === "zero-override") raw.exec("UPDATE plan_revision_parts SET quantity_override=0 WHERE revision_id=1");
      if (kind === "quantity-mismatch") raw.exec("UPDATE plan_revision_parts SET quantity_inferred=2 WHERE revision_id=1");
      if (kind === "oversized") raw.exec("UPDATE plan_revision_parts SET quantity_inferred=10001 WHERE revision_id=1");
      if (kind === "boolean") raw.exec("UPDATE plan_revision_parts SET included=2 WHERE revision_id=1");
      if (kind === "oversized-text") raw.prepare("UPDATE plan_revision_parts SET notes=? WHERE revision_id=1").run("x".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES + 1));
      if (kind === "multibyte-text") raw.prepare("UPDATE plan_revision_parts SET notes=? WHERE revision_id=1").run("é".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES / 2 + 1));
      if (kind === "combined-text") raw.prepare("UPDATE plan_revision_parts SET notes=?,github_blob_url=? WHERE revision_id=1").run("x".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES / 2), "y".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES / 2));
      if (kind === "actor-text") raw.prepare("UPDATE plan_revisions SET accepted_by=? WHERE id=1").run("x".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES + 1));
      if (kind === "source-text") raw.prepare("UPDATE source_revisions SET upstream_revision_key=? WHERE id=12").run("x".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES + 1));
      const parts = drizzle(raw).select().from(schema.planRevisionParts).all().filter(part => part.revisionId === 1);
      raw.prepare("UPDATE plan_revisions SET snapshot_digest=? WHERE id=1").run(digestPlanRevisionParts(parts));
      for (const trigger of triggers) raw.exec(trigger.sql);
      input.source_digest = hash(raw.serialize());
    });
    if (mode === "inspect") expect(() => inspectOwnershipCopy(paths)).toThrow(/identity|booleans|history|text/i);
    else await refused(paths, input);
  },
);

it.each(["mapped-limit", "mapped-overflow"])("enforces the dirty history row-text budget at $0", async kind => {
  const paths = fixture();
  edit(paths.sourceDir, db => { db.exec("UPDATE parts SET notes='working edit' WHERE id=1"); });
  edit(paths.sourceDir, raw => {
    const triggers = z.array(z.object({ name: z.string(), sql: z.string() })).parse(raw.prepare("SELECT name,sql FROM sqlite_schema WHERE name IN ('trg_plan_revision_parts_immutable_update','trg_plan_revisions_immutable_update')").all());
    for (const trigger of triggers) raw.exec(`DROP TRIGGER "${trigger.name}"`);
    const db = drizzle(raw);
    const part = db.select().from(schema.planRevisionParts).all().find(part => part.revisionId === 1);
    if (!part) throw new Error("Missing revision Part");
    const bytes = Object.values(part).reduce<number>((total, value) => total + (typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0), 0);
    raw.prepare("UPDATE plan_revision_parts SET notes=? WHERE revision_id=1").run("x".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES - bytes - (kind === "mapped-limit" ? 2 : 0)));
    raw.prepare("UPDATE plan_revisions SET snapshot_digest=? WHERE id=1").run(digestPlanRevisionParts(db.select().from(schema.planRevisionParts).all().filter(part => part.revisionId === 1)));
    for (const trigger of triggers) raw.exec(trigger.sql);
  });
  const input = manifest(paths.sourceDir);
  if (kind === "mapped-overflow") { await refused(paths, input); return; }
  await executeOwnershipCopy({ ...paths, manifest: input });
  const copy = new Database(join(paths.destinationDir, "print-partner.db"), { readonly: true });
  try {
    const part = drizzle(copy).select().from(schema.planRevisionParts).all().find(part => part.revisionId === 1);
    if (!part) throw new Error("Missing copied revision Part");
    expect(Object.values(part).reduce<number>((total, value) => total + (typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0), 0)).toBe(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES);
  } finally { copy.close(); }
});

it.each(["inspect", "apply"].flatMap(mode => ["missing-parent", "non-immediate-parent"].map(kind => ({ mode, kind }))))(
  "$mode refuses dirty history with $kind", async ({ mode, kind }) => {
    const paths = fixture(); appendAcceptedRevision(paths.sourceDir);
    if (kind === "non-immediate-parent") appendAcceptedRevision(paths.sourceDir);
    edit(paths.sourceDir, db => { db.exec("UPDATE parts SET notes='working edit' WHERE id=1"); });
    const input = manifest(paths.sourceDir);
    edit(paths.sourceDir, db => {
      const trigger = z.object({ sql: z.string() }).parse(db.prepare("SELECT sql FROM sqlite_schema WHERE name='trg_plan_revisions_immutable_update'").get());
      db.exec("DROP TRIGGER trg_plan_revisions_immutable_update");
      if (kind === "missing-parent") db.exec("UPDATE plan_revisions SET parent_revision_id=NULL WHERE profile_id=1 AND revision_number=2");
      else db.exec("UPDATE plan_revisions SET parent_revision_id=1 WHERE profile_id=1 AND revision_number=3");
      db.exec(trigger.sql);
      input.source_digest = hash(db.serialize());
    });
    if (mode === "inspect") expect(() => inspectOwnershipCopy(paths)).toThrow(/lineage/);
    else await refused(paths, input);
  },
);
it.each(["inspect", "apply"].flatMap(mode => ["current", "historical"].map(kind => ({ mode, kind }))))(
  "$mode refuses post-initial legacy provenance on the $kind dirty revision", async ({ mode, kind }) => {
    const paths = fixture(); appendAcceptedRevision(paths.sourceDir);
    if (kind === "historical") appendAcceptedRevision(paths.sourceDir);
    edit(paths.sourceDir, db => { db.exec("UPDATE parts SET notes='working edit' WHERE id=1"); });
    const input = manifest(paths.sourceDir);
    edit(paths.sourceDir, db => {
      const trigger = z.object({ sql: z.string() }).parse(db.prepare("SELECT sql FROM sqlite_schema WHERE name='trg_plan_revisions_immutable_update'").get());
      db.exec("DROP TRIGGER trg_plan_revisions_immutable_update; UPDATE plan_revisions SET provenance_kind='legacy',input_set_id=NULL WHERE profile_id=1 AND revision_number=2");
      db.exec(trigger.sql);
      if (kind === "current") db.exec("DELETE FROM plan_accepted_input_sets WHERE profile_id=1");
      input.source_digest = hash(db.serialize());
    });
    if (kind === "current") input.claims = input.claims.filter(claim => claim.table !== "plan_accepted_input_sets" || claim.rowid !== 1);
    if (mode === "inspect") expect(() => inspectOwnershipCopy(paths)).toThrow(/provenance/);
    else await refused(paths, input);
  },
);
it.each(["inspect", "apply"].flatMap(mode => ["current", "historical"].map(kind => ({ mode, kind }))))(
  "$mode refuses post-initial format-1 inputs on the $kind dirty revision", async ({ mode, kind }) => {
    const paths = fixture(); appendAcceptedRevision(paths.sourceDir);
    if (kind === "historical") appendAcceptedRevision(paths.sourceDir);
    edit(paths.sourceDir, raw => {
      const db = drizzle(raw);
      const set = db.select().from(schema.planRevisionInputSets).all().find(row => row.id === 1);
      const input = db.select().from(schema.planRevisionInputs).all().find(row => row.inputSetId === 1);
      if (!set || !input) throw new Error("Missing accepted input fixture");
      const legacy = db.insert(schema.planRevisionInputSets).values({ ...set, id: undefined, formatVersion: 1,
        inputSetDigest: digestFormat1Inputs([{ sourceRevisionId: 12, manifestDigest: hash("manifest-1-2") }]) }).returning().get();
      db.insert(schema.planRevisionInputs).values({ ...input, id: undefined, inputSetId: legacy.id, sourceLayer: "legacy:1", effectiveNamingDigest: null }).run();
      raw.exec("UPDATE parts SET notes='working edit' WHERE id=1");
    });
    const input = manifest(paths.sourceDir);
    edit(paths.sourceDir, db => {
      const trigger = z.object({ sql: z.string() }).parse(db.prepare("SELECT sql FROM sqlite_schema WHERE name='trg_plan_revisions_immutable_update'").get());
      db.exec("DROP TRIGGER trg_plan_revisions_immutable_update; UPDATE plan_revisions SET input_set_id=(SELECT id FROM plan_revision_input_sets WHERE profile_id=1 AND format_version=1) WHERE profile_id=1 AND revision_number=2");
      db.exec(trigger.sql);
      if (kind === "current") db.exec("UPDATE plan_accepted_input_sets SET input_set_id=(SELECT id FROM plan_revision_input_sets WHERE profile_id=1 AND format_version=1) WHERE profile_id=1");
      input.source_digest = hash(db.serialize());
    });
    if (mode === "inspect") expect(() => inspectOwnershipCopy(paths)).toThrow(/publication format/);
    else await refused(paths, input);
  },
);
it.each(["inspect", "apply"].flatMap(mode => ["completed", "assembled", "assembled-without-completed"].map(kind => ({ mode, kind }))))(
  "$mode refuses dirty current-coordinate progress with invalid $kind", async ({ mode, kind }) => {
    const paths = fixture();
    edit(paths.sourceDir, db => { db.exec("UPDATE parts SET notes='working edit' WHERE id=1"); });
    const input = manifest(paths.sourceDir);
    edit(paths.sourceDir, db => {
      if (kind === "completed") db.exec("UPDATE print_progress SET completed=2 WHERE part_id=1 AND unit_index=0");
      if (kind === "assembled") db.exec("UPDATE print_progress SET completed=1,assembled=2 WHERE part_id=1 AND unit_index=0");
      if (kind === "assembled-without-completed") db.exec("UPDATE print_progress SET completed=0,assembled=1 WHERE part_id=1 AND unit_index=0");
      input.source_digest = hash(db.serialize());
    });
    if (mode === "inspect") expect(() => inspectOwnershipCopy(paths)).toThrow(/progress/);
    else await refused(paths, input);
  },
);
it("copies a complete three-revision dirty chain and retained out-of-range progress", async () => {
  const paths = fixture(); appendAcceptedRevision(paths.sourceDir); appendAcceptedRevision(paths.sourceDir);
  edit(paths.sourceDir, db => { db.exec("UPDATE parts SET notes='working edit' WHERE id=1; INSERT INTO print_progress (part_id,unit_index,completed,assembled) VALUES (1,3,1,1)"); });
  const input = manifest(paths.sourceDir); const before = files(paths.sourceDir);
  await executeOwnershipCopy({ ...paths, manifest: input }); expect(files(paths.sourceDir)).toEqual(before);
  const copy = new Database(join(paths.destinationDir, "print-partner.db"), { readonly: true });
  try {
    expect(copy.prepare("SELECT revision_number,parent_revision_id FROM plan_revisions WHERE profile_id=1 ORDER BY revision_number").all()).toEqual([
      { revision_number: 1, parent_revision_id: null }, { revision_number: 2, parent_revision_id: 1 }, { revision_number: 3, parent_revision_id: 3 },
    ]);
    expect(copy.prepare("SELECT tenant_id,completed,assembled FROM print_progress WHERE part_id=1 AND unit_index=3").get()).toEqual({ tenant_id: "account-a", completed: 1, assembled: 1 });
  } finally { copy.close(); }
});

it.each([
  { kind: "source-overflow", mode: "inspect" }, { kind: "source-overflow", mode: "apply" },
  { kind: "mapped-overflow", mode: "apply" }, { kind: "mapped-limit", mode: "apply" },
])("$mode enforces the dirty Build text budget at $kind", async ({ mode, kind }) => {
  const paths = fixture();
  edit(paths.sourceDir, db => { db.exec("UPDATE parts SET notes='working edit' WHERE id=1"); });
  const input = manifest(paths.sourceDir);
  edit(paths.sourceDir, raw => {
    const profile = drizzle(raw).select().from(schema.buildProfiles).all().find(profile => profile.id === 1);
    if (!profile) throw new Error("Missing Build");
    const bytes = [profile.tenantId, profile.name, profile.orderNumber, profile.specialRequest, profile.archivedAt]
      .reduce((total, value) => total + (value == null ? 0 : Buffer.byteLength(value, "utf8")), 0);
    const targetBytes = MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES + (kind === "source-overflow" ? 1 : kind === "mapped-limit" ? -2 : 0);
    raw.prepare("UPDATE build_profiles SET special_request=? WHERE id=1").run("x".repeat(targetBytes - bytes));
    input.source_digest = hash(raw.serialize());
  });
  if (mode === "inspect") { expect(() => inspectOwnershipCopy(paths)).toThrow(/Build text/); return; }
  if (kind !== "source-overflow") expect(inspectOwnershipCopy(paths).source_digest).toBe(input.source_digest);
  if (kind !== "mapped-limit") { await refused(paths, input); return; }
  await executeOwnershipCopy({ ...paths, manifest: input });
  const store = new SqliteDatabase(paths.destinationDir); store.connect();
  try { expect(new AppRepository(getDb(store), "account-a", store.reposDir).readAcceptedPlanOperationalSnapshot(1)).toEqual({ kind: "compatibility_dirty" }); }
  finally { store.close(); }
});

it.each(["inspect", "apply"].flatMap(mode => ["default", "account-b"].map(owner => ({ mode, owner }))))(
  "$mode preserves an unaccepted $owner Build with a large supported special request", async ({ mode, owner }) => {
    const paths = fixture();
    edit(paths.sourceDir, db => { db.prepare("INSERT INTO build_profiles (id,tenant_id,name) VALUES (9,?,'Unaccepted Plan')").run(owner); });
    const input = manifest(paths.sourceDir);
    const specialRequest = "x".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES + 1);
    const store = new SqliteDatabase(paths.sourceDir); store.connect();
    try { new AppRepository(getDb(store), owner, store.reposDir).updateProfileSpecialRequest(9, specialRequest); }
    finally { store.close(); }
    edit(paths.sourceDir, db => { db.pragma("journal_mode = DELETE"); input.source_digest = hash(db.serialize()); });
    const before = files(paths.sourceDir);
    if (mode === "inspect") {
      expect(inspectOwnershipCopy(paths).source_digest).toBe(input.source_digest);
    } else {
      await executeOwnershipCopy({ ...paths, manifest: input });
      const copy = new Database(join(paths.destinationDir, "print-partner.db"), { readonly: true });
      try {
        expect(copy.prepare("SELECT tenant_id,special_request,accepted_plan_version,accepted_plan_revision_id FROM build_profiles WHERE id=9").get()).toEqual({
          tenant_id: owner === "default" ? "account-a" : owner, special_request: specialRequest, accepted_plan_version: 0, accepted_plan_revision_id: null,
        });
      } finally { copy.close(); }
    }
    expect(files(paths.sourceDir)).toEqual(before);
  },
);

it.each(ownershipHistoryTables)("requires an explicit owner for every %s history row", async table => {
  const paths = table.startsWith("accepted_plate") ? plateFixture() : fixture(); const input = manifest(paths.sourceDir);
  const selected = input.claims.findIndex(claim => claim.table === table);
  expect(selected).toBeGreaterThanOrEqual(0); input.claims.splice(selected, 1);
  await refused(paths, input);
});
it.each(ownershipHistoryTables)("refuses conflicting %s history owners", async table => {
  const paths = table.startsWith("accepted_plate") ? plateFixture() : fixture(); const input = manifest(paths.sourceDir);
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

it.each([{ corrupt: false, dirty: false }, { corrupt: true, dirty: false }, { corrupt: false, dirty: true }])("validates retained parent Plan history, corrupt=$corrupt dirty=$dirty", async ({ corrupt, dirty }) => {
  const paths = fixture();
  appendAcceptedRevision(paths.sourceDir);
  if (dirty) edit(paths.sourceDir, raw => { raw.exec("UPDATE parts SET notes='working edit after two revisions' WHERE id=1"); });
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

it.each(["inspect", "apply"].flatMap(mode => ["valid", "layer", "order"].map(duplicate => ({ mode, duplicate }))))(
  "$mode validates retained format-2 input identity with $duplicate layers/orders", async ({ mode, duplicate }) => {
    const paths = fixture();
    const canonical = [
      { source_id: 1, source_layer: "base:A", layer_order: 0, tracking_kind: "revision" as const, source_revision_id: 12, manifest_digest: hash("manifest-1-2"), effective_naming_digest: "c".repeat(64) },
      { source_id: 2, source_layer: "addon:B", layer_order: 1, tracking_kind: "revision" as const, source_revision_id: 22, manifest_digest: hash("manifest-2-2"), effective_naming_digest: "c".repeat(64) },
    ];
    edit(paths.sourceDir, raw => {
      const db = drizzle(raw);
      const header = db.select().from(schema.planRevisionInputSets).all().find(row => row.id === 1)!;
      db.insert(schema.planRevisionInputSets).values({ ...header, id: 3, expectedInputCount: 2, inputSetDigest: digestPlanInputs(canonical) }).run();
      const inputs = db.select().from(schema.planRevisionInputs).all();
      for (const [index, input] of inputs.entries()) db.insert(schema.planRevisionInputs).values({ ...input, id: index + 3,
        inputSetId: 3, sourceLayer: canonical[index]!.source_layer, layerOrder: canonical[index]!.layer_order }).run();
      const revision = db.select().from(schema.planRevisions).all().find(row => row.id === 1)!;
      const part = db.select().from(schema.planRevisionParts).all().find(row => row.revisionId === 1)!;
      raw.exec("DROP TRIGGER trg_plan_revisions_immutable_update; UPDATE plan_revisions SET revision_number=2 WHERE id=1");
      db.insert(schema.planRevisions).values({ ...revision, id: 3, inputSetId: 3 }).run();
      db.insert(schema.planRevisionParts).values({ ...part, id: 3, revisionId: 3 }).run();
      raw.exec("UPDATE plan_revisions SET parent_revision_id=3 WHERE id=1");
      raw.exec(schemaMigrations.find(sql => sql.startsWith("CREATE TRIGGER IF NOT EXISTS trg_plan_revisions_immutable_update\n"))!);
    });
    const input = manifest(paths.sourceDir); input.claims.forEach(claim => { claim.user_id = "account-a"; });
    if (duplicate !== "valid") edit(paths.sourceDir, raw => {
      if (duplicate === "layer") canonical[1]!.source_layer = canonical[0]!.source_layer;
      if (duplicate === "order") canonical[1]!.layer_order = canonical[0]!.layer_order;
      raw.prepare("UPDATE plan_revision_inputs SET source_layer=?,layer_order=? WHERE id=4").run(canonical[1]!.source_layer, canonical[1]!.layer_order);
      raw.prepare("UPDATE plan_revision_input_sets SET input_set_digest=? WHERE id=3").run(digestPlanInputs(canonical));
      input.source_digest = hash(raw.serialize());
    });
    if (duplicate !== "valid") {
      if (mode === "inspect") expect(() => inspectOwnershipCopy(paths)).toThrow("duplicate Plan input layer or order");
      else await refused(paths, input);
    } else if (mode === "inspect") expect(inspectOwnershipCopy(paths).claims.some(claim => claim.table === "plan_revision_input_sets" && claim.rowid === 3)).toBe(true);
    else {
      await executeOwnershipCopy({ ...paths, manifest: input });
      const db = new Database(join(paths.destinationDir, "print-partner.db"));
      try { expect(db.prepare("SELECT source_layer,layer_order,tenant_id FROM plan_revision_inputs WHERE input_set_id=3 ORDER BY layer_order").all()).toEqual([
        { source_layer: "base:A", layer_order: 0, tenant_id: "account-a" }, { source_layer: "addon:B", layer_order: 1, tenant_id: "account-a" },
      ]); } finally { db.close(); }
    }
  },
);

function corruptPlate(source: string, mutate: (raw: Database.Database) => void) {
  edit(source, raw => {
    const triggers = z.array(z.object({ name: z.string(), sql: z.string() })).parse(raw.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name LIKE 'trg_accepted_plate%'").all());
    for (const trigger of triggers) raw.exec(`DROP TRIGGER "${trigger.name}"`);
    raw.pragma("ignore_check_constraints = ON");
    mutate(raw);
    for (const trigger of triggers) raw.exec(trigger.sql);
  });
}

it.each(["digest", "count", "ordinal", "geometry", "token", "association", "basis-digest", "mapping-digest", "version", "timestamp", "owner", "undo", "head", "pinned", "placement", "unplaced-pinned", "trimmed-text"])(
  "refuses malformed retained Plate $0 without publishing", async kind => {
    const paths = plateFixture(); const input = manifest(paths.sourceDir);
    corruptPlate(paths.sourceDir, raw => {
      if (kind === "digest") raw.exec("UPDATE accepted_plate_revisions SET layout_digest='" + "f".repeat(64) + "' WHERE id=1");
      if (kind === "count") raw.exec("UPDATE accepted_plate_revisions SET expected_unit_count=2 WHERE id=1");
      if (kind === "ordinal") raw.exec("UPDATE accepted_plates SET ordinal=2 WHERE revision_id=1");
      if (kind === "geometry") raw.exec("UPDATE accepted_plate_units SET x_um=250000 WHERE revision_id=1");
      if (kind === "token") raw.exec("UPDATE accepted_plate_units SET required_unit_token=(SELECT required_unit_token FROM plan_revision_required_units WHERE revision_id=2 LIMIT 1) WHERE revision_id=1");
      if (kind === "association") raw.exec("UPDATE accepted_plate_units SET plate_id='absent' WHERE revision_id=1");
      if (kind === "basis-digest") raw.exec("UPDATE accepted_plate_revisions SET plan_revision_digest='" + "f".repeat(64) + "' WHERE id=1");
      if (kind === "mapping-digest") raw.exec("UPDATE accepted_plate_revisions SET required_unit_mapping_digest='" + "f".repeat(64) + "' WHERE id=1");
      if (kind === "version") raw.exec("UPDATE accepted_plate_revisions SET plan_version=2 WHERE id=1");
      if (kind === "timestamp") raw.exec("UPDATE accepted_plate_revisions SET created_at='yesterday' WHERE id=1");
      if (kind === "owner") raw.exec("UPDATE accepted_plates SET tenant_id='account-b' WHERE revision_id=1");
      if (kind === "undo") raw.exec("UPDATE accepted_plate_revisions SET undo_from_revision_id=4 WHERE id=1");
      if (kind === "head") raw.exec("UPDATE accepted_plate_heads SET current_revision_id=4 WHERE profile_id=1");
      if (kind === "pinned") raw.exec("UPDATE accepted_plate_units SET pinned=2 WHERE revision_id=1");
      if (kind === "placement") raw.exec("UPDATE accepted_plate_units SET placement='unknown' WHERE revision_id=1");
      if (kind === "unplaced-pinned") raw.exec("UPDATE accepted_plate_units SET placement='unplaced',pinned=1 WHERE revision_id=1");
      if (kind === "trimmed-text") raw.exec("UPDATE accepted_plates SET printer_name=' Printer ' WHERE revision_id=1");
      input.source_digest = hash(raw.serialize());
    });
    if (["digest", "geometry", "token", "association", "basis-digest", "mapping-digest", "version", "timestamp", "undo", "unplaced-pinned", "trimmed-text"].includes(kind)) {
      const store = new SqliteDatabase(paths.sourceDir); store.connect();
      try { expect(new AppRepository(getDb(store), "default", store.reposDir).readAcceptedPlates(1).kind).toBe("ready"); }
      finally { store.close(); }
      edit(paths.sourceDir, raw => { input.source_digest = hash(raw.serialize()); });
    }
    expect(() => inspectOwnershipCopy(paths)).toThrow();
    await refused(paths, input);
  },
);

it.each(["missing", "conflicting"])("refuses $0 explicit Plate ownership claims", async kind => {
  const paths = plateFixture(); const input = manifest(paths.sourceDir);
  const claim = input.claims.find(claim => claim.table === "accepted_plate_units");
  if (!claim) throw new Error("Missing unit claim");
  if (kind === "missing") input.claims = input.claims.filter(row => row !== claim);
  else claim.user_id = "account-b";
  await refused(paths, input);
});

it.each(["missing", "replaced"])("refuses $0 Plate trigger protection", async kind => {
  const paths = plateFixture(); const input = manifest(paths.sourceDir);
  edit(paths.sourceDir, raw => {
    raw.exec("DROP TRIGGER trg_accepted_plate_units_immutable_delete");
    if (kind === "replaced") raw.exec("CREATE TRIGGER trg_accepted_plate_units_immutable_delete BEFORE DELETE ON accepted_plate_units BEGIN SELECT 1; END");
    input.source_digest = hash(raw.serialize());
  });
  expect(() => inspectOwnershipCopy(paths)).toThrow(/trigger protection/);
  await refused(paths, input);
});

it.each(["combined", "multibyte"])("refuses $0 Plate text byte overflow", async kind => {
  const paths = plateFixture(); const input = manifest(paths.sourceDir);
  corruptPlate(paths.sourceDir, raw => {
    const text = kind === "multibyte" ? "é".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES / 2) : "x".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES / 2);
    raw.prepare("UPDATE accepted_plates SET printer_name=?,printer_model=? WHERE revision_id=1").run(text, text);
    input.source_digest = hash(raw.serialize());
  });
  expect(() => inspectOwnershipCopy(paths)).toThrow(/text/);
  await refused(paths, input);
});

it("bounds the aggregate Plate row bytes before and after owner expansion", () => {
  const paths = plateFixture();
  corruptPlate(paths.sourceDir, raw => {
    const row = z.object({ bytes: z.number() }).parse(raw.prepare("SELECT SUM(length(CAST(tenant_id AS BLOB))+length(CAST(plate_id AS BLOB))+length(CAST(printer_id AS BLOB))+length(CAST(printer_name AS BLOB))+length(CAST(printer_model AS BLOB))) AS bytes FROM accepted_plates WHERE revision_id=1").get());
    raw.prepare("UPDATE accepted_plates SET printer_model=printer_model||? WHERE revision_id=1").run("x".repeat(MAX_ACCEPTED_OPERATIONAL_ROW_TEXT_BYTES - row.bytes));
    expect(() => validateOwnershipPlateTextBytes(raw)).not.toThrow();
    raw.exec("UPDATE accepted_plates SET tenant_id='account-a' WHERE revision_id=1");
    expect(() => validateOwnershipPlateTextBytes(raw)).toThrow(/text/);
  });
});

it.each(["unplaced", "restore", "legacy", "missing-head", "stale-basis"])("copies supported $0 Plate history", async kind => {
  const paths = plateFixture();
  const store = new SqliteDatabase(paths.sourceDir); store.connect();
  let expected: ReturnType<AppRepository["readAcceptedPlates"]>;
  try {
    const repo = new AppRepository(getDb(store), "default", store.reposDir);
    const state = repo.readAcceptedPlateWorkspaceInput(1);
    if (state.kind !== "ready" || !state.plates[0]?.units[0]) throw new Error("Missing Plate state");
    if (kind === "unplaced") expect(repo.unplaceAcceptedPlateUnit({ profileId: 1, expected: state.basis,
      expectedPlateRevisionId: state.plateRevisionId, plateId: "plate-main", token: state.plates[0].units[0].token }).kind).toBe("moved");
    if (kind === "restore") {
      const changed = repo.publishAcceptedPlates({ profileId: 1, expected: state.basis, expectedPlateRevisionId: state.plateRevisionId,
        undoFromRevisionId: state.plateRevisionId, plates: state.plates.map(plate => ({ ...plate,
          units: plate.units.map(unit => ({ ...unit, xUm: unit.xUm + 1000 })) })) });
      if (changed.kind !== "published") throw new Error("Missing undo publication");
      expect(repo.restoreAcceptedPlates({ profileId: 1, expected: state.basis, expectedPlateRevisionId: changed.plateRevisionId,
        restorePlateRevisionId: state.plateRevisionId }).kind).toBe("restored");
    }
    if (kind === "legacy") corruptPlate(paths.sourceDir, raw => raw.prepare("UPDATE accepted_plate_revisions SET layout_digest=? WHERE id=?")
      .run(layoutDigest(state.plates, LEGACY_ACCEPTED_PLATE_LAYOUT_FORMAT), state.plateRevisionId));
  } finally { store.close(); }
  if (kind === "missing-head") edit(paths.sourceDir, raw => raw.exec("DELETE FROM accepted_plate_heads WHERE profile_id=1"));
  if (kind === "stale-basis") appendAcceptedRevision(paths.sourceDir);
  const capture = new SqliteDatabase(paths.sourceDir); capture.connect();
  try { expected = new AppRepository(getDb(capture), "default", capture.reposDir).readAcceptedPlates(1); } finally { capture.close(); }
  expect(expected.kind).toBe(kind === "missing-head" ? "empty" : kind === "stale-basis" ? "stale_accepted_plan" : "ready");
  const input = manifest(paths.sourceDir); const before = files(paths.sourceDir);
  await executeOwnershipCopy({ ...paths, manifest: input });
  expect(files(paths.sourceDir)).toEqual(before);
  for (let restart = 0; restart < 2; restart++) {
    for (const [root, tenant] of [[paths.sourceDir, "default"], [paths.destinationDir, "account-a"]]) {
      if (!root || !tenant) throw new Error("Missing reopen identity");
      const reopened = new SqliteDatabase(root); reopened.connect();
      try {
        const repo = new AppRepository(getDb(reopened), tenant, reopened.reposDir);
        expect(repo.readAcceptedPlates(1)).toEqual(expected);
        if (kind === "unplaced") expect(repo.readAcceptedPlateExportInput(1)).toEqual({ kind: "unplaced_units" });
      } finally { reopened.close(); }
    }
  }
});

it("copies a selected subset of the historical Required-unit map", async () => {
  const paths = plateFixture(2); const input = manifest(paths.sourceDir);
  await executeOwnershipCopy({ ...paths, manifest: input });
  const store = new SqliteDatabase(paths.destinationDir); store.connect();
  try {
    const repo = new AppRepository(getDb(store), "account-a", store.reposDir);
    const state = repo.readAcceptedPlates(1);
    const plan = repo.readAcceptedPlanOperationalSnapshot(1);
    if (state.kind !== "ready" || plan.kind !== "ready") throw new Error("Missing selected layout");
    expect(state.plates.flatMap(plate => plate.units)).toHaveLength(1);
    expect(plan.snapshot.parts.flatMap(part => part.units)).toHaveLength(2);
  } finally { store.close(); }
});
