import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AppRepository } from "./db/repository.js";
import { getDb, SqliteDatabase } from "./db/client.js";
import { currentSchemaVersion } from "./db/schema.js";
import { admitDesktopAccount } from "./desktop-account.js";
import { acquireDataDirectory } from "./desktop-context.js";
import { executeOwnershipCopy, inspectOwnershipCopy } from "./ownership-migration.js";

const dirs: string[] = [];
beforeEach(() => { process.env.PP_DESKTOP_REBUILD = "1"; });
afterEach(() => { delete process.env.PP_DESKTOP_REBUILD; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pp-ownership-")); dirs.push(root);
  const sourceDir = join(root, "source"); mkdirSync(sourceDir);
  const initialized = new SqliteDatabase(sourceDir); initialized.connect(); initialized.close();
  const db = new Database(join(sourceDir, "print-partner.db"));
  db.exec(`INSERT INTO users (id,display_name,created_at) VALUES ('account-a','A','now'),('account-b','B','now');
    INSERT INTO projects (id,name,url) VALUES (1,'Source A','https://example.test/a'),(2,'Source B','https://example.test/b');
    INSERT INTO build_profiles (id,name) VALUES (1,'Plan A'),(2,'Plan B');
    INSERT INTO profile_layers (id,profile_id,layer_type,project_id) VALUES (1,1,'base',1),(2,2,'base',2);
    INSERT INTO parts (id,profile_id,match_key,relative_path) VALUES (1,1,'a','a.stl'),(2,2,'b','b.stl');
    INSERT INTO print_progress (id,part_id) VALUES (1,1),(2,2);
    INSERT INTO build_profiles (id,tenant_id,name) VALUES (3,'account-b','Foreign');
    INSERT INTO source_docs (id,project_id,path,kind,updated_at) VALUES (1,1,'README.md','markdown','now'),(2,2,'README.md','markdown','now');
    INSERT INTO source_notes (id,project_id,profile_id,updated_at,created_at) VALUES (1,1,1,'now','now'),(2,2,2,'now','now');
    INSERT INTO plan_decisions (id,profile_id,created_at,kind) VALUES (1,1,'now','note'),(2,2,'now','note');`);
  db.close();
  mkdirSync(join(sourceDir, "repos", "1"), { recursive: true }); writeFileSync(join(sourceDir, "repos", "1", "a.stl"), "source bytes");
  return { sourceDir, destinationDir: join(root, "copy") };
}
function manifest(sourceDir: string, split = true) {
  const inventory = inspectOwnershipCopy({ sourceDir });
  return { version: 1, source_digest: inventory.source_digest, selected_user_id: "account-a",
    claims: inventory.claims.map(row => ({ ...row, user_id: split && !["printer_profiles", "process_profiles", "filament_profiles"].includes(row.table) && row.rowid === 2 ? "account-b" : "account-a" })) };
}
function edit(sourceDir: string, sql: string) { const db = new Database(join(sourceDir, "print-partner.db")); try { db.pragma("foreign_keys = OFF"); db.exec(sql); } finally { db.close(); } }

it("copies shared default Plans to explicit separate owners and admits the selected account", async () => {
  const paths = fixture(); const before = readFileSync(join(paths.sourceDir, "print-partner.db"));
  const inventory = inspectOwnershipCopy(paths);
  expect(inspectOwnershipCopy(paths)).toEqual(inventory);
  expect(JSON.stringify(inventory)).not.toContain("password");
  const receipt = await executeOwnershipCopy({ ...paths, manifest: manifest(paths.sourceDir) });
  expect(receipt).toEqual({ destinationDir: paths.destinationDir, user_id: "account-a" });
  expect(readFileSync(join(paths.sourceDir, "print-partner.db"))).toEqual(before);
  expect(readFileSync(join(paths.sourceDir, "repos/1/a.stl"), "utf8")).toBe("source bytes");
  expect(readFileSync(join(paths.destinationDir, "repos/1/a.stl"), "utf8")).toBe("source bytes");
  const db = new Database(join(paths.destinationDir, "print-partner.db"));
  expect(db.prepare("SELECT id,tenant_id FROM build_profiles ORDER BY id").all()).toEqual([
    { id: 1, tenant_id: "account-a" }, { id: 2, tenant_id: "account-b" }, { id: 3, tenant_id: "account-b" }]);
  expect(db.prepare("SELECT value FROM app_settings WHERE tenant_id='default' AND key='schema_version'").get()).toEqual({ value: String(currentSchemaVersion) });
  db.close();
  const mapping = join(paths.destinationDir, "desktop-account.json");
  expect(lstatSync(mapping).mode & 0o777).toBe(0o600);
  const account = admitDesktopAccount(paths.destinationDir, { kind: "present", sha256: createHash("sha256").update(readFileSync(mapping)).digest("hex") });
  expect(account.kind).toBe("existing");
  if (account.kind === "existing") { expect(account.principal().tenant_id).toBe("account-a"); account.close(); }
});
it("assigns a whole unclaimed source to one existing user", async () => {
  const paths = fixture(); await executeOwnershipCopy({ ...paths, manifest: manifest(paths.sourceDir, false) });
  const db = new Database(join(paths.destinationDir, "print-partner.db"));
  expect(db.prepare("SELECT count(*) AS n FROM parts WHERE tenant_id='account-a'").get()).toEqual({ n: 2 }); db.close();
});
it.each(["missing", "extra", "duplicate", "unknown", "default", "conflict", "stale", "collision"])("refuses %s claims without publishing", async kind => {
  const paths = fixture(); const input = manifest(paths.sourceDir);
  if (kind === "missing") input.claims.pop();
  if (kind === "extra") input.claims.push({ table: "build_profiles", rowid: 3, user_id: "account-a" });
  if (kind === "duplicate") input.claims.push({ table: "parts", rowid: 1, user_id: "account-a" });
  if (kind === "unknown") input.selected_user_id = "missing";
  if (kind === "default") input.claims[0]!.user_id = "default";
  if (kind === "conflict") input.claims.find(row => row.table === "parts" && row.rowid === 1)!.user_id = "account-b";
  if (kind === "stale") edit(paths.sourceDir, "UPDATE users SET display_name='changed' WHERE id='account-a'");
  if (kind === "collision") { edit(paths.sourceDir, "INSERT INTO build_profiles (tenant_id,name) VALUES ('account-a','Plan A')"); input.source_digest = inspectOwnershipCopy(paths).source_digest; }
  await expect(executeOwnershipCopy({ ...paths, manifest: input })).rejects.toThrow(); expect(existsSync(paths.destinationDir)).toBe(false);
});
it.each(["settings", "unsupported", "opaque", "absolute", "dangling", "unknown-tree", "exports", "symlink", "db-symlink"])("refuses %s source state", async kind => {
  const paths = fixture();
  if (kind === "settings") edit(paths.sourceDir, "INSERT INTO app_settings VALUES ('default','secret','{}')");
  if (kind === "unsupported") edit(paths.sourceDir, "CREATE TABLE future (tenant_id TEXT); INSERT INTO future VALUES ('default')");
  if (kind === "opaque") edit(paths.sourceDir, "UPDATE projects SET metadata_json='{}' WHERE id=1");
  if (kind === "absolute") edit(paths.sourceDir, "UPDATE projects SET local_path='/tmp/elsewhere' WHERE id=1");
  if (kind === "dangling") edit(paths.sourceDir, "UPDATE parts SET profile_id=999 WHERE id=1");
  if (kind === "unknown-tree") mkdirSync(join(paths.sourceDir, "unknown"));
  if (kind === "exports") { mkdirSync(join(paths.sourceDir, "exports"), { recursive: true }); writeFileSync(join(paths.sourceDir, "exports/a"), "ambiguous"); }
  if (kind === "symlink") symlinkSync("/tmp", join(paths.sourceDir, "repos/1/link"));
  if (kind === "db-symlink") { const path = join(paths.sourceDir, "print-partner.db"); const bytes = readFileSync(path); rmSync(path); writeFileSync(join(paths.sourceDir, "other.db"), bytes); symlinkSync("other.db", path); }
  expect(() => inspectOwnershipCopy(paths)).toThrow(/Unsupported|Unsafe|integrity|regular|artifact|symlink|Dangling/);
  expect(existsSync(paths.destinationDir)).toBe(false);
});
it("refuses an owned source, existing empty destination, and disabled gate", async () => {
  const paths = fixture(); const input = manifest(paths.sourceDir); const release = acquireDataDirectory(paths.sourceDir);
  try { await expect(executeOwnershipCopy({ ...paths, manifest: input })).rejects.toThrow(); } finally { release(); }
  mkdirSync(paths.destinationDir); await expect(executeOwnershipCopy({ ...paths, manifest: input })).rejects.toThrow();
  delete process.env.PP_DESKTOP_REBUILD; expect(() => inspectOwnershipCopy(paths)).toThrow();
});

it("reopens the selected tenant through the repository and persists new Plans", async () => {
  const paths = fixture(); await executeOwnershipCopy({ ...paths, manifest: manifest(paths.sourceDir) });
  for (let index = 0; index < 2; index++) {
    const store = new SqliteDatabase(paths.destinationDir); store.connect();
    try {
      const repo = new AppRepository(getDb(store), "account-a", store.reposDir);
      expect(repo.listProfileHeaders().map(row => row.name)).toEqual(index === 0 ? ["Plan A"] : ["New Plan", "Plan A"]);
      if (index === 0) repo.createProfile("New Plan");
      expect(new AppRepository(getDb(store), "account-b", store.reposDir).listProfileHeaders().map(row => row.name)).toEqual(["Foreign", "Plan B"]);
    } finally { store.close(); }
  }
});
it("includes committed WAL changes in the full snapshot digest and backup", async () => {
  const paths = fixture(); const first = manifest(paths.sourceDir);
  const writer = new Database(join(paths.sourceDir, "print-partner.db"));
  writer.pragma("journal_mode = WAL"); writer.pragma("wal_autocheckpoint = 0");
  writer.exec("UPDATE users SET display_name='WAL value' WHERE id='account-a'");
  try {
    const next = manifest(paths.sourceDir);
    expect(next.source_digest).not.toBe(first.source_digest);
    await expect(executeOwnershipCopy({ ...paths, manifest: first })).rejects.toThrow("Stale source snapshot");
    const dbBefore = readFileSync(join(paths.sourceDir, "print-partner.db"));
    const walBefore = readFileSync(join(paths.sourceDir, "print-partner.db-wal"));
    await executeOwnershipCopy({ ...paths, manifest: next });
    expect(readFileSync(join(paths.sourceDir, "print-partner.db"))).toEqual(dbBefore);
    expect(readFileSync(join(paths.sourceDir, "print-partner.db-wal"))).toEqual(walBefore);
    const copy = new Database(join(paths.destinationDir, "print-partner.db"));
    expect(copy.prepare("SELECT display_name FROM users WHERE id='account-a'").get()).toEqual({ display_name: "WAL value" }); copy.close();
  } finally { writer.close(); }
});
it("refuses triggers that mutate foreign rows and removes staging", async () => {
  const paths = fixture();
  edit(paths.sourceDir, "CREATE TRIGGER unexpected AFTER UPDATE OF tenant_id ON parts BEGIN UPDATE users SET display_name='changed' WHERE id='account-b'; END");
  const input = manifest(paths.sourceDir);
  await expect(executeOwnershipCopy({ ...paths, manifest: input })).rejects.toThrow("Unexpected row changes in users");
  expect(existsSync(paths.destinationDir)).toBe(false);
  const db = new Database(join(paths.sourceDir, "print-partner.db"));
  expect(db.prepare("SELECT display_name FROM users WHERE id='account-b'").get()).toEqual({ display_name: "B" }); db.close();
});
it.each(["directory", "symlink", "nested"])("refuses an existing or overlapping %s destination", async kind => {
  const paths = fixture(); const input = manifest(paths.sourceDir);
  if (kind === "directory") mkdirSync(paths.destinationDir);
  if (kind === "symlink") symlinkSync(paths.sourceDir, paths.destinationDir);
  if (kind === "nested") paths.destinationDir = join(paths.sourceDir, "copy");
  await expect(executeOwnershipCopy({ ...paths, manifest: input })).rejects.toThrow(/already exists|overlap/);
});
it("runs gated inspect and apply through the CLI and reports invalid arguments", () => {
  const paths = fixture(); const cli = fileURLToPath(new URL("./ownership-migration-cli.ts", import.meta.url));
  const run = (args: string[], enabled: string) => spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", cli, ...args], { encoding: "utf8", env: { ...process.env, PP_DESKTOP_REBUILD: enabled } });
  const disabled = run(["inspect", paths.sourceDir], "false");
  expect(disabled.status).toBe(1); expect(disabled.stderr).toContain("PP_DESKTOP_REBUILD"); expect(disabled.stdout).toBe("");
  const inspected = run(["inspect", paths.sourceDir], "true");
  expect(inspected.status, inspected.stderr).toBe(0); expect(JSON.parse(inspected.stdout)).toEqual(inspectOwnershipCopy(paths));
  const manifestPath = join(dirs.at(-1)!, "manifest.json"); writeFileSync(manifestPath, JSON.stringify(manifest(paths.sourceDir)));
  const applied = run(["apply", paths.sourceDir, paths.destinationDir, manifestPath], "1");
  expect(applied.status, applied.stderr).toBe(0); expect(JSON.parse(applied.stdout)).toEqual({ destinationDir: paths.destinationDir, user_id: "account-a" });
  const invalid = run(["apply"], "1"); expect(invalid.status).toBe(1); expect(invalid.stderr).toContain("Usage:");
});

it.each(["source_path", "raw_json", "raw_ini", "compatible_printers"])("refuses imported profiles with %s", field => {
  const paths = fixture(); const table = field === "compatible_printers" ? "process_profiles" : "printer_profiles";
  edit(paths.sourceDir, `UPDATE ${table} SET ${field}='external' WHERE id=1`);
  expect(() => inspectOwnershipCopy(paths)).toThrow("Unsupported imported or externally backed profile");
});
it("does not replace a destination created during the backup", async () => {
  const paths = fixture(); const input = manifest(paths.sourceDir);
  const pending = executeOwnershipCopy({ ...paths, manifest: input });
  mkdirSync(paths.destinationDir);
  await expect(pending).rejects.toThrow();
  expect(readdirSync(paths.destinationDir)).toEqual([]);
  expect(readdirSync(join(paths.destinationDir, "..")).filter(name => name.startsWith(".ownership-copy-"))).toEqual([]);
});
it("refuses accepted history even without a history table row", () => {
  const paths = fixture(); edit(paths.sourceDir, "UPDATE build_profiles SET accepted_plan_version=1 WHERE id=1");
  expect(() => inspectOwnershipCopy(paths)).toThrow("Unsupported accepted history");
});
