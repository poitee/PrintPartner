import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { acquireDataDirectory, desktopContext } from "./desktop-context.js";
import { currentSchemaVersion } from "./db/schema.js";
import { readSchemaVersion } from "./db/upgrade-guard.js";

const supported = ["build_profiles", "projects", "profile_layers", "parts", "print_progress", "source_docs", "source_notes", "plan_decisions", "printer_profiles", "process_profiles", "filament_profiles"] as const;
const ownerSchema = z.string().min(1).max(256).refine(value => value !== "default", "Owner must be an existing non-default user");
export const ownershipManifestSchema = z.strictObject({
  version: z.literal(1),
  source_digest: z.string().regex(/^[a-f0-9]{64}$/),
  selected_user_id: ownerSchema,
  claims: z.array(z.strictObject({ table: z.enum(supported), rowid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), user_id: ownerSchema })),
});
const rowSchema = z.record(z.string(), z.unknown());
const namedSchema = z.object({ name: z.string() });
const fkSchema = z.object({ id: z.number(), seq: z.number(), table: z.string(), from: z.string(), to: z.string().nullable() });
type Row = z.infer<typeof rowSchema>;
type Inventory = { version: 1; source_digest: string; tables: { table: string; rowids: number[] }[]; claims: { table: string; rowid: number; user_id: string }[] };
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const key = (table: string, rowid: unknown) => `${table}/${String(rowid)}`;
function gate(): void {
  if (desktopContext()) throw new Error("Ownership copy requires a stopped source and an offline process");
  if (process.env.PP_DESKTOP_REBUILD !== "1" && process.env.PP_DESKTOP_REBUILD !== "true") throw new Error("PP_DESKTOP_REBUILD must be exactly 1 or true");
}
function missing(path: string): boolean {
  try { lstatSync(path); return false; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}
function regular(path: string): void {
  if (!lstatSync(path).isFile()) throw new Error("Expected regular file without symlinks");
}
function rows(db: Database.Database, table: string): Row[] {
  return z.array(rowSchema).parse(db.prepare(`SELECT rowid AS __rowid, * FROM ${quote(table)} ORDER BY rowid`).all());
}
function tables(db: Database.Database): string[] {
  return z.array(namedSchema).parse(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name").all()).map(row => row.name);
}
function columns(db: Database.Database, table: string): string[] {
  return z.array(namedSchema).parse(db.pragma(`table_info(${quote(table)})`)).map(row => row.name);
}
function snapshotDigest(db: Database.Database): string {
  return createHash("sha256").update(db.serialize()).digest("hex");
}
function safeRelative(value: unknown): void {
  if (value === null || value === "" || value === undefined) return;
  if (typeof value !== "string" || isAbsolute(value) || value.includes("\\") || value.includes(":") || value.includes("\0") || value.split("/").some(piece => piece === ".." || piece === "." || piece === "")) {
    throw new Error("Unsafe path or locator");
  }
}
function validateData(db: Database.Database, claims = new Map<string, string>()): Inventory["tables"] {
  if (readSchemaVersion(db) !== currentSchemaVersion) throw new Error("Current database schema required");
  if (db.pragma("integrity_check", { simple: true }) !== "ok" || z.array(z.unknown()).parse(db.pragma("foreign_key_check")).length) throw new Error("Database integrity or dangling relationship");
  const names = tables(db);
  const tenantTables = new Set(names.filter(table => columns(db, table).includes("tenant_id")));
  const inventory: Inventory["tables"] = [];
  const effective = (table: string, row: Row) => claims.get(key(table, row.__rowid)) ?? row.tenant_id;
  for (const table of names) {
    const data = rows(db, table);
    if (["sessions", "password_reset_tokens", "plan_shares"].includes(table) && data.length) throw new Error(`Unsupported active authority in ${table}`);
    const defaults = data.filter(row => row.tenant_id === "default");
    if (defaults.length && !supported.some(name => name === table)) {
      if (table !== "app_settings" || defaults.some(row => row.key !== "schema_version")) throw new Error(`Unsupported default rows in ${table}`);
    }
    if (supported.some(name => name === table)) {
      const rowids = defaults.map(row => z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(row.__rowid)).sort((a, b) => a - b);
      inventory.push({ table, rowids });
      for (const row of defaults) {
        if (["printer_profiles", "process_profiles", "filament_profiles"].includes(table)) {
          for (const field of ["source_path", "raw_json", "raw_ini", "compatible_printers"]) {
            if (row[field] != null && row[field] !== "") throw new Error(`Unsupported imported or externally backed profile in ${table}`);
          }
        }
        if (row.accepted_plan_revision_id != null || row.current_source_revision_id != null || Number(row.accepted_plan_version ?? 0) !== 0) throw new Error("Unsupported accepted history");
        for (const field of ["metadata_json", "imported_paths", "result_json"]) if (row[field] != null && row[field] !== "") throw new Error(`Unsupported opaque state in ${table}`);
        if (row.params_json != null && row.params_json !== "{}") throw new Error("Unsupported decision parameters");
      }
      for (const row of data) {
        for (const field of ["local_path", "relative_path", "filename", "path"]) safeRelative(row[field]);
        if (row.local_path) throw new Error("Unsupported nonempty project local_path");
      }
    }
    const foreignKeys = z.array(fkSchema).parse(db.pragma(`foreign_key_list(${quote(table)})`));
    const links = new Map<number, typeof foreignKeys>();
    for (const fk of foreignKeys) { const group = links.get(fk.id) ?? []; group.push(fk); links.set(fk.id, group); }
    let supplementalId = -1;
    for (const [field, target] of Object.entries({ profile_id: "build_profiles", project_id: "projects", part_id: "parts", projection_part_id: "parts", source_id: "projects" })) {
      if (columns(db, table).includes(field) && !foreignKeys.some(fk => fk.from === field)) links.set(supplementalId--, [{ id: -1, seq: 0, table: target, from: field, to: "id" }]);
    }
    for (const row of data) for (const link of links.values()) {
      if (link.some(fk => row[fk.from] == null)) continue;
      const head = link[0]; if (!head) continue;
      const conditions = link.map(fk => {
        if (fk.to === null) throw new Error("Unsupported implicit foreign key");
        return `${quote(fk.to)} = ?`;
      });
      const values = link.map(fk => z.union([z.string(), z.number(), z.instanceof(Buffer)]).parse(row[fk.from]));
      const parent = rowSchema.optional().parse(db.prepare(`SELECT rowid AS __rowid, * FROM ${quote(head.table)} WHERE ${conditions.join(" AND ")}`).get(...values));
      if (!parent) throw new Error(`Dangling relationship in ${table}`);
      if (tenantTables.has(table) && tenantTables.has(head.table) && effective(table, row) !== effective(head.table, parent)) throw new Error(`Conflicting owner relationship in ${table}`);
    }
  }
  return inventory;
}
const excluded = new Set(["print-partner.db", "print-partner.db-wal", "print-partner.db-shm", "desktop-account.json", ".desktop.lock", ".desktop-owner.json", ".desktop-lease"]);
const emptyDirectories = new Set(["exports", "uploads", "upload-staging", "staging", "backups", "thumbnails", "previews", "thumbs", "covers"]);
function checkTree(path: string, destination?: string): void {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    if (destination) mkdirSync(destination, { mode: 0o700 });
    for (const name of readdirSync(path).sort()) checkTree(join(path, name), destination && join(destination, name));
  } else {
    regular(path);
    if (destination) copyFileSync(path, destination);
  }
}
function productFiles(source: string, db: Database.Database, destination?: string): void {
  const projects = new Set(rows(db, "projects").map(row => String(row.id)));
  for (const name of readdirSync(source).sort()) {
    if (excluded.has(name) || /^\.desktop-(lease|owner-release)-/.test(name)) continue;
    const path = join(source, name);
    if (name === "repos" || name === "sources") {
      if (!lstatSync(path).isDirectory()) throw new Error("Product root must be a directory");
      if (destination) mkdirSync(join(destination, name), { mode: 0o700 });
      for (const project of readdirSync(path).sort()) {
        if (!projects.has(project) || !lstatSync(join(path, project)).isDirectory()) throw new Error("Unassigned project artifact");
        checkTree(join(path, project), destination && join(destination, name, project));
      }
    } else if (emptyDirectories.has(name)) {
      if (!lstatSync(path).isDirectory() || readdirSync(path).length) throw new Error(`Unsupported nonempty ${name}`);
      if (destination) mkdirSync(join(destination, name), { mode: 0o700 });
    } else throw new Error(`Unsupported top-level artifact ${name}`);
  }
}
function sourceDatabase(sourceDir: string): Database.Database {
  regular(join(sourceDir, "print-partner.db"));
  for (const name of ["print-partner.db-wal", "print-partner.db-shm"]) if (!missing(join(sourceDir, name))) regular(join(sourceDir, name));
  return new Database(join(sourceDir, "print-partner.db"), { readonly: true, fileMustExist: true });
}
export function inspectOwnershipCopy({ sourceDir }: { sourceDir: string }): Inventory {
  gate();
  const source = realpathSync(sourceDir);
  const release = acquireDataDirectory(source);
  let db: Database.Database | undefined;
  try {
    db = sourceDatabase(source);
    const inventory = validateData(db);
    productFiles(source, db);
    return { version: 1, source_digest: snapshotDigest(db), tables: inventory,
      claims: inventory.flatMap(({ table, rowids }) => rowids.map(rowid => ({ table, rowid, user_id: "" }))) };
  } finally { db?.close(); release(); }
}
function publish(stage: string, destination: string): void {
  if (process.platform !== "linux") throw new Error("Atomic ownership copy publication requires Linux renameat2");
  execFileSync("python3", ["-c", `import ctypes, os, sys
lib = ctypes.CDLL(None, use_errno=True)
rename = lib.renameat2
rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
if rename(-100, os.fsencode(sys.argv[1]), -100, os.fsencode(sys.argv[2]), 1) != 0:
    code = ctypes.get_errno()
    raise OSError(code, os.strerror(code))
`, stage, destination], { stdio: "pipe" });
}
export async function executeOwnershipCopy({ sourceDir, destinationDir, manifest }: { sourceDir: string; destinationDir: string; manifest: unknown }): Promise<{ destinationDir: string; user_id: string }> {
  gate();
  const input = ownershipManifestSchema.parse(manifest);
  const source = realpathSync(sourceDir);
  const destination = join(realpathSync(dirname(resolve(destinationDir))), resolve(destinationDir).split(sep).at(-1) ?? "");
  if (!missing(destination)) throw new Error("Destination already exists");
  const under = (a: string, b: string) => { const path = relative(a, b); return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path)); };
  if (under(source, destination) || under(destination, source)) throw new Error("Source and destination must not overlap");
  const release = acquireDataDirectory(source);
  let db: Database.Database | undefined;
  let stage: string | undefined;
  try {
    db = sourceDatabase(source);
    if (snapshotDigest(db) !== input.source_digest) throw new Error("Stale source snapshot digest");
    const inventory = validateData(db);
    productFiles(source, db);
    const users = new Set(rows(db, "users").map(row => row.id));
    if (!users.has(input.selected_user_id)) throw new Error("Unknown selected owner");
    const expected = new Set(inventory.flatMap(({ table, rowids }) => rowids.map(rowid => key(table, rowid))));
    const claims = new Map<string, string>();
    for (const claim of input.claims) {
      const id = key(claim.table, claim.rowid);
      if (!expected.has(id) || claims.has(id) || !users.has(claim.user_id)) throw new Error("Invalid, duplicate, or unrelated owner claim");
      claims.set(id, claim.user_id);
    }
    if (claims.size !== expected.size) throw new Error("Missing explicit owner claims");
    validateData(db, claims);
    stage = mkdtempSync(join(dirname(destination), ".ownership-copy-"));
    await db.backup(join(stage, "print-partner.db"));
    if (snapshotDigest(db) !== input.source_digest) throw new Error("Source snapshot changed during copy");
    productFiles(source, db, stage);
    const original = db;
    const copy = new Database(join(stage, "print-partner.db"));
    try {
      copy.pragma("foreign_keys = ON");
      copy.transaction(() => {
        for (const claim of input.claims) copy.prepare(`UPDATE ${quote(claim.table)} SET tenant_id = ? WHERE rowid = ? AND tenant_id = 'default'`).run(claim.user_id, claim.rowid);
        validateData(copy);
        for (const table of tables(original)) {
          const expectedRows = rows(original, table).map(row => {
            const owner = claims.get(key(table, row.__rowid));
            return owner ? { ...row, tenant_id: owner } : row;
          });
          if (JSON.stringify(rows(copy, table)) !== JSON.stringify(expectedRows)) throw new Error(`Unexpected row changes in ${table}`);
        }
      })();
      if (copy.pragma("integrity_check", { simple: true }) !== "ok" || z.array(z.unknown()).parse(copy.pragma("foreign_key_check")).length) throw new Error("Staged database integrity failed");
    } finally { copy.close(); }
    writeFileSync(join(stage, "desktop-account.json"), JSON.stringify({ version: 1, kind: "existing-account", user_id: input.selected_user_id, tenant_id: input.selected_user_id }), { mode: 0o600, flag: "wx" });
    publish(stage, destination);
    stage = undefined;
    return { destinationDir: destination, user_id: input.selected_user_id };
  } finally {
    db?.close();
    if (stage) rmSync(stage, { recursive: true, force: true });
    release();
  }
}
