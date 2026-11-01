import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { z } from "zod";
import { acquireDataDirectory, desktopContext } from "./desktop-context.js";
import * as schema from "./db/schema.js";
import { readAcceptedPlanOperationalSnapshotInternal } from "./db/accepted-plan-operational.js";
import { readAcceptedPlatesInternal } from "./db/accepted-plates.js";
import {
  validateOwnershipPlateComparisonBudget,
  validateOwnershipPlateProtection,
  validateOwnershipPlateTextBytes,
} from "./ownership-plate-history.js";
import { openVerifiedAcceptedArtifact } from "./services/accepted-artifacts.js";
import { ownershipHistoryTables, validateOwnershipHistory } from "./ownership-history.js";
import {
  inOwnershipExportStage,
  inspectOwnershipExports,
  ownershipExportClaimSchema,
  ownershipExportTarget,
  ownershipFileDigest,
  type OwnershipExport,
} from "./ownership-exports.js";
import { schemaMigrations } from "./db/migrations-sqlite.js";
import { currentSchemaVersion } from "./db/schema.js";
import { readSchemaVersion } from "./db/upgrade-guard.js";

const supported = [
  "build_profiles",
  "projects",
  "profile_layers",
  "parts",
  "print_progress",
  "source_docs",
  "source_notes",
  "plan_decisions",
  "printer_profiles",
  "process_profiles",
  "filament_profiles",
  ...ownershipHistoryTables,
] as const;
const ownerSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value !== "default", "Owner must be an existing non-default user");
const ownershipManifestSchema = z.strictObject({
  version: z.literal(1),
  source_digest: z.string().regex(/^[a-f0-9]{64}$/),
  selected_user_id: ownerSchema,
  exports: z.array(ownershipExportClaimSchema).default([]),
  claims: z.array(
    z.strictObject({
      table: z.enum(supported),
      rowid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      user_id: ownerSchema,
    }),
  ),
});
const rowSchema = z.record(z.string(), z.unknown());
const namedSchema = z.object({ name: z.string() });
const fkSchema = z.object({
  id: z.number(),
  seq: z.number(),
  table: z.string(),
  from: z.string(),
  to: z.string().nullable(),
});
type Row = z.infer<typeof rowSchema>;
type Inventory = {
  exports: OwnershipExport[];
  version: 1;
  source_digest: string;
  tables: { table: string; rowids: number[] }[];
  claims: { table: string; rowid: number; user_id: string }[];
};
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const key = (table: string, rowid: unknown) => `${table}/${String(rowid)}`;
function gate(): void {
  if (desktopContext())
    throw new Error("Ownership copy requires a stopped source and an offline process");
  if (process.env.PP_DESKTOP_REBUILD !== "1" && process.env.PP_DESKTOP_REBUILD !== "true")
    throw new Error("PP_DESKTOP_REBUILD must be exactly 1 or true");
}
function missing(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}
function regular(path: string): void {
  if (!lstatSync(path).isFile()) throw new Error("Expected regular file without symlinks");
}
function rows(db: Database.Database, table: string): Row[] {
  return z
    .array(rowSchema)
    .parse(db.prepare(`SELECT rowid AS __rowid, * FROM ${quote(table)} ORDER BY rowid`).all());
}
function tables(db: Database.Database): string[] {
  return z
    .array(namedSchema)
    .parse(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name",
        )
        .all(),
    )
    .map((row) => row.name);
}
function columns(db: Database.Database, table: string): string[] {
  return z
    .array(namedSchema)
    .parse(db.pragma(`table_info(${quote(table)})`))
    .map((row) => row.name);
}
function snapshotDigest(db: Database.Database): string {
  return createHash("sha256").update(db.serialize()).digest("hex");
}
function safeRelative(value: unknown): void {
  if (value === null || value === "" || value === undefined) return;
  if (
    typeof value !== "string" ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.includes(":") ||
    value.includes("\0") ||
    value.split("/").some((piece) => piece === ".." || piece === "." || piece === "")
  ) {
    throw new Error("Unsafe path or locator");
  }
}
function validateData(
  db: Database.Database,
  claims = new Map<string, string>(),
): Inventory["tables"] {
  if (readSchemaVersion(db) !== currentSchemaVersion)
    throw new Error("Current database schema required");
  if (
    db.pragma("integrity_check", { simple: true }) !== "ok" ||
    z.array(z.unknown()).parse(db.pragma("foreign_key_check")).length
  )
    throw new Error("Database integrity or dangling relationship");
  validateOwnershipPlateTextBytes(db);
  validateOwnershipPlateComparisonBudget(db);
  validateOwnershipPlateProtection(db);
  const names = tables(db);
  const tableColumns = new Map(names.map((table) => [table, new Set(columns(db, table))]));
  const tenantTables = new Set(names.filter((table) => tableColumns.get(table)?.has("tenant_id")));
  const inventory: Inventory["tables"] = [];
  const effective = (table: string, row: Row) =>
    claims.get(key(table, row.__rowid)) ?? row.tenant_id;
  for (const table of names) {
    const data = rows(db, table);
    if (["sessions", "password_reset_tokens", "plan_shares"].includes(table) && data.length)
      throw new Error(`Unsupported active authority in ${table}`);
    const defaults = data.filter((row) => row.tenant_id === "default");
    if (defaults.length && !supported.some((name) => name === table)) {
      if (table !== "app_settings" || defaults.some((row) => row.key !== "schema_version"))
        throw new Error(`Unsupported default rows in ${table}`);
    }
    if (supported.some((name) => name === table)) {
      const rowids = defaults
        .map((row) => z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(row.__rowid))
        .sort((a, b) => a - b);
      inventory.push({ table, rowids });
      for (const row of defaults) {
        if (["printer_profiles", "process_profiles", "filament_profiles"].includes(table)) {
          for (const field of ["source_path", "raw_json", "raw_ini", "compatible_printers"]) {
            if (row[field] != null && row[field] !== "")
              throw new Error(`Unsupported imported or externally backed profile in ${table}`);
          }
        }
        for (const field of ["metadata_json", "imported_paths", "result_json"])
          if (row[field] != null && row[field] !== "")
            throw new Error(`Unsupported opaque state in ${table}`);
        if (row.params_json != null && row.params_json !== "{}")
          throw new Error("Unsupported decision parameters");
      }
      for (const row of data) {
        for (const field of ["relative_path", "filename", "path", "snapshot_locator"])
          safeRelative(row[field]);
      }
    }
    const foreignKeys = z.array(fkSchema).parse(db.pragma(`foreign_key_list(${quote(table)})`));
    const links = new Map<number, typeof foreignKeys>();
    for (const fk of foreignKeys) {
      const group = links.get(fk.id) ?? [];
      group.push(fk);
      links.set(fk.id, group);
    }
    let supplementalId = -1;
    for (const [field, target] of Object.entries({
      profile_id: "build_profiles",
      project_id: "projects",
      part_id: "parts",
      projection_part_id: "parts",
      source_id: "projects",
      machine_profile_id: "printer_profiles",
      filament_profile_id: "filament_profiles",
    })) {
      if (table === "plan_revision_parts" && field === "projection_part_id") continue;
      if (tableColumns.get(table)?.has(field) && !foreignKeys.some((fk) => fk.from === field))
        links.set(supplementalId--, [{ id: -1, seq: 0, table: target, from: field, to: "id" }]);
    }
    for (const row of data)
      for (const link of links.values()) {
        if (link.some((fk) => row[fk.from] == null)) continue;
        const head = link[0];
        if (!head) continue;
        const conditions = link.map((fk) => {
          if (fk.to === null) throw new Error("Unsupported implicit foreign key");
          return `${quote(fk.to)} = ?`;
        });
        const values = link.map((fk) =>
          z.union([z.string(), z.number(), z.instanceof(Buffer)]).parse(row[fk.from]),
        );
        const parent = rowSchema
          .optional()
          .parse(
            db
              .prepare(
                `SELECT rowid AS __rowid, * FROM ${quote(head.table)} WHERE ${conditions.join(" AND ")}`,
              )
              .get(...values),
          );
        if (!parent) throw new Error(`Dangling relationship in ${table}`);
        if (
          tenantTables.has(table) &&
          tenantTables.has(head.table) &&
          effective(table, row) !== effective(head.table, parent)
        )
          throw new Error(`Conflicting owner relationship in ${table}`);
      }
  }
  validateOwnershipHistory(db);
  return inventory;
}
const excluded = new Set([
  "print-partner.db",
  "print-partner.db-wal",
  "print-partner.db-shm",
  "desktop-account.json",
  "printpartner.lock",
  ".desktop.lock",
  ".desktop-owner.json",
  ".desktop-lease",
  ".desktop-focus.sock",
]);
const emptyDirectories = new Set([
  "uploads",
  "upload-staging",
  "staging",
  "backups",
  "thumbnails",
  "previews",
  "thumbs",
  "covers",
]);
function checkTree(path: string, destination?: string): void {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    if (destination) mkdirSync(destination, { mode: 0o700 });
    for (const name of readdirSync(path).sort()) {
      safeRelative(name);
      checkTree(join(path, name), destination && join(destination, name));
    }
  } else {
    const digest = ownershipFileDigest(path);
    if (destination) {
      copyFileSync(path, destination);
      if (ownershipFileDigest(destination) !== digest || ownershipFileDigest(path) !== digest)
        throw new Error("Source artifact changed during copy");
    }
  }
}
function productFiles(source: string, db: Database.Database, destination?: string): void {
  const projects = new Set(rows(db, "projects").map((row) => String(row.id)));
  for (const name of readdirSync(source).sort()) {
    if (name === "exports") continue;
    if (excluded.has(name) || /^\.desktop-(lease|owner-release)-/.test(name)) continue;
    const path = join(source, name);
    if (name === "repos" || name === "sources") {
      if (!lstatSync(path).isDirectory()) throw new Error("Product root must be a directory");
      if (destination) mkdirSync(join(destination, name), { mode: 0o700 });
      for (const project of readdirSync(path).sort()) {
        if (!projects.has(project) || !lstatSync(join(path, project)).isDirectory())
          throw new Error("Unassigned project artifact");
        checkTree(join(path, project), destination && join(destination, name, project));
      }
    } else if (emptyDirectories.has(name)) {
      if (!lstatSync(path).isDirectory() || readdirSync(path).length)
        throw new Error(`Unsupported nonempty ${name}`);
      if (destination) mkdirSync(join(destination, name), { mode: 0o700 });
    } else throw new Error(`Unsupported top-level artifact ${name}`);
  }
}
function exportInventory(source: string, db: Database.Database): OwnershipExport[] {
  const root = join(source, "exports");
  return missing(root)
    ? []
    : inspectOwnershipExports(
        root,
        drizzle(db).select().from(schema.buildProfiles).all(),
        drizzle(db).select().from(schema.acceptedPlateRevisions).all(),
        drizzle(db).select().from(schema.planRevisions).all(),
      );
}
function relocatedLocalPath(row: Row, source: string, destination: string): string {
  const path = z.string().parse(row.local_path);
  const root = join(source, "repos", String(row.id));
  const candidate = resolve(path);
  if (!isAbsolute(path) || (candidate !== root && !candidate.startsWith(`${root}${sep}`)))
    throw new Error("Unsafe Source local_path");
  safeRelative(relative(root, candidate));
  return join(destination, relative(source, candidate));
}
function validateSnapshotPaths(source: string, db: Database.Database, checkLocalPaths = true) {
  for (const project of rows(db, "projects")) {
    if (checkLocalPaths && project.local_path) {
      relocatedLocalPath(project, source, source);
      checkTree(z.string().parse(project.local_path));
    }
  }
  for (const revision of rows(db, "source_revisions")) {
    const locator = z.string().parse(revision.snapshot_locator);
    let cursor = join(source, "repos");
    for (const piece of locator.split("/")) {
      cursor = join(cursor, piece);
      if (!lstatSync(cursor).isDirectory())
        throw new Error("Unsafe or missing Source snapshot directory");
    }
    checkTree(cursor);
  }
  const driver = drizzle(db, { schema });
  const sets = driver.select().from(schema.planRevisionInputSets).all();
  const revisions = driver.select().from(schema.planRevisions).all();
  for (const profile of driver.select().from(schema.buildProfiles).all()) {
    if (profile.acceptedPlanRevisionId == null && profile.acceptedPlanVersion === 0) continue;
    const accepted = readAcceptedPlanOperationalSnapshotInternal({
      db: driver,
      schema,
      tenantId: profile.tenantId,
      profileId: profile.id,
      reposDir: join(source, "repos"),
      sqlite: true,
      resolveSourceSnapshotPath: (sourceId, locator) =>
        locator.startsWith(`${sourceId}/revisions/`) ? join(source, "repos", locator) : null,
    });
    if (profile.acceptedPlanRevisionId == null) {
      if (accepted.kind !== "compatibility_dirty")
        throw new Error("Unsafe accepted Plan operational state");
      continue;
    }
    const revision = revisions.find((revision) => revision.id === profile.acceptedPlanRevisionId);
    const format1 = sets.some((set) => set.id === revision?.inputSetId && set.formatVersion === 1);
    if (accepted.kind !== "ready" && !(accepted.kind === "uninitialized" && format1))
      throw new Error("Unsafe accepted Plan operational state");
  }
  const plateProfiles = new Set(
    driver
      .select()
      .from(schema.acceptedPlateRevisions)
      .all()
      .map((revision) => revision.profileId),
  );
  const plates = driver
    .select()
    .from(schema.buildProfiles)
    .all()
    .filter((profile) => plateProfiles.has(profile.id))
    .map((profile) => {
      const state = readAcceptedPlatesInternal(
        {
          db: driver,
          schema,
          tenantId: profile.tenantId,
          reposDir: join(source, "repos"),
          sqlite: true,
          resolveSourceSnapshotPath: (sourceId, locator) =>
            locator.startsWith(`${sourceId}/revisions/`) ? join(source, "repos", locator) : null,
          transaction: (operation) =>
            db.inTransaction ? operation() : db.transaction(operation)(),
          readTransaction: (operation) =>
            db.inTransaction ? operation() : db.transaction(operation)(),
        },
        profile.id,
      );
      if (state.kind === "transaction_unavailable")
        throw new Error("Unsafe accepted Plate operational state");
      return { profileId: profile.id, state };
    });
  const inputs = driver.select().from(schema.planRevisionInputs).all();
  const sourceRevisions = driver.select().from(schema.sourceRevisions).all();
  for (const part of driver.select().from(schema.planRevisionParts).all()) {
    const revision = revisions.find((revision) => revision.id === part.revisionId);
    const set = sets.find((set) => set.id === revision?.inputSetId);
    if (!set || set.formatVersion !== 2) continue;
    const input = inputs.find(
      (input) => input.inputSetId === set.id && input.sourceLayer === part.sourceLayer,
    );
    if (!input) throw new Error("Unsafe historical Part input linkage");
    if (input.trackingKind === "untracked") {
      if (part.artifactDigest != null) throw new Error("Untracked Part has an artifact digest");
      continue;
    }
    const pinned = sourceRevisions.find((revision) => revision.id === input.sourceRevisionId);
    if (!pinned || !part.artifactDigest)
      throw new Error("Missing historical Part artifact identity");
    const opened = openVerifiedAcceptedArtifact({
      reposDir: join(source, "repos"),
      artifact: {
        kind: "tracked",
        sourceId: pinned.projectId,
        sourceRevisionId: pinned.id,
        snapshotRoot: join(source, "repos", pinned.snapshotLocator),
        relativePath: part.relativePath,
        expectedSha256: part.artifactDigest,
      },
    });
    if (opened.kind !== "verified") throw new Error("Unsafe or missing accepted Part artifact");
    opened.lease.close();
  }
  return plates;
}
function suspendOwnershipTriggers(db: Database.Database): { name: string; sql: string }[] {
  const names = new Set([
    "trg_parts_invalidate_accepted_revision_update",
    "trg_accepted_plate_revisions_immutable_update",
    "trg_accepted_plates_immutable_update",
    "trg_accepted_plate_units_immutable_update",
    "trg_accepted_plate_heads_ownership_update",
    "trg_plan_revisions_immutable_update",
    "trg_plan_revision_parts_immutable_update",
    "trg_required_units_immutable_update",
    "trg_plan_revision_required_units_immutable_update",
    "trg_plan_revision_required_unit_sets_immutable_update",
  ]);
  const triggers = z
    .array(z.object({ name: z.string(), sql: z.string() }))
    .parse(
      db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all(),
    )
    .filter((trigger) => names.has(trigger.name));
  const normalize = (sql: string) =>
    sql.replace("CREATE TRIGGER IF NOT EXISTS", "CREATE TRIGGER").replace(/;\s*$/, "").trim();
  if (triggers.length !== names.size) throw new Error("Missing ownership copy trigger protection");
  for (const trigger of triggers) {
    const expected = schemaMigrations.find((sql) =>
      sql.startsWith(`CREATE TRIGGER IF NOT EXISTS ${trigger.name}\n`),
    );
    if (!expected || normalize(expected) !== normalize(trigger.sql))
      throw new Error("Unexpected ownership copy trigger definition");
    db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
  }
  return triggers;
}
function productFileDigests(source: string): [string, string][] {
  const result: [string, string][] = [];
  const walk = (path: string) => {
    if (lstatSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        safeRelative(name);
        walk(join(path, name));
      }
    } else result.push([relative(source, path), ownershipFileDigest(path)]);
  };
  for (const name of readdirSync(source).sort()) {
    if (excluded.has(name) || /^\.desktop-(lease|owner-release)-/.test(name)) continue;
    walk(join(source, name));
  }
  return result;
}
function sourceDatabase(sourceDir: string): Database.Database {
  regular(join(sourceDir, "print-partner.db"));
  for (const name of ["print-partner.db-wal", "print-partner.db-shm"])
    if (!missing(join(sourceDir, name))) regular(join(sourceDir, name));
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
    validateSnapshotPaths(source, db);
    return {
      exports: exportInventory(source, db),
      version: 1,
      source_digest: snapshotDigest(db),
      tables: inventory,
      claims: inventory.flatMap(({ table, rowids }) =>
        rowids.map((rowid) => ({ table, rowid, user_id: "" })),
      ),
    };
  } finally {
    db?.close();
    release();
  }
}
function publish(stage: string, destination: string): void {
  if (process.platform !== "linux")
    throw new Error("Atomic ownership copy publication requires Linux renameat2");
  execFileSync(
    "python3",
    [
      "-c",
      `import ctypes, os, sys
lib = ctypes.CDLL(None, use_errno=True)
rename = lib.renameat2
rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
if rename(-100, os.fsencode(sys.argv[1]), -100, os.fsencode(sys.argv[2]), 1) != 0:
    code = ctypes.get_errno()
    raise OSError(code, os.strerror(code))
`,
      stage,
      destination,
    ],
    { stdio: "pipe" },
  );
}
export async function executeOwnershipCopy({
  sourceDir,
  destinationDir,
  manifest,
}: {
  sourceDir: string;
  destinationDir: string;
  manifest: unknown;
}): Promise<{ destinationDir: string; user_id: string }> {
  gate();
  const input = ownershipManifestSchema.parse(manifest);
  const source = realpathSync(sourceDir);
  const destination = join(
    realpathSync(dirname(resolve(destinationDir))),
    resolve(destinationDir).split(sep).at(-1) ?? "",
  );
  if (!missing(destination)) throw new Error("Destination already exists");
  const under = (a: string, b: string) => {
    const path = relative(a, b);
    return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
  };
  if (under(source, destination) || under(destination, source))
    throw new Error("Source and destination must not overlap");
  const release = acquireDataDirectory(source);
  let db: Database.Database | undefined;
  let stage: string | undefined;
  try {
    db = sourceDatabase(source);
    if (snapshotDigest(db) !== input.source_digest) throw new Error("Stale source snapshot digest");
    const inventory = validateData(db);
    productFiles(source, db);
    const sourcePlateState = validateSnapshotPaths(source, db);
    const artifacts = exportInventory(source, db);
    const sourceFiles = productFileDigests(source);
    const users = new Set(rows(db, "users").map((row) => row.id));
    if (!users.has(input.selected_user_id)) throw new Error("Unknown selected owner");
    const expected = new Set(
      inventory.flatMap(({ table, rowids }) => rowids.map((rowid) => key(table, rowid))),
    );
    const claims = new Map<string, string>();
    for (const claim of input.claims) {
      const id = key(claim.table, claim.rowid);
      if (!expected.has(id) || claims.has(id) || !users.has(claim.user_id))
        throw new Error("Invalid, duplicate, or unrelated owner claim");
      claims.set(id, claim.user_id);
    }
    if (claims.size !== expected.size) throw new Error("Missing explicit owner claims");
    validateData(db, claims);
    const exportOwners = new Map<string, string>();
    const targets = new Set<string>();
    for (const claim of input.exports) {
      const artifact = artifacts.find((artifact) => artifact.path === claim.path);
      if (
        !artifact ||
        exportOwners.has(claim.path) ||
        artifact.sha256 !== claim.sha256 ||
        artifact.profile_id !== claim.profile_id
      )
        throw new Error("Invalid or stale export claim");
      const profile = rows(db, "build_profiles").find((row) => row.id === artifact.profile_id);
      if (!profile) throw new Error("Unassigned export Plan");
      const owner = claims.get(key("build_profiles", profile.__rowid)) ?? profile.tenant_id;
      if (claim.user_id !== owner || !users.has(claim.user_id))
        throw new Error("Conflicting export owner");
      const target = ownershipExportTarget(artifact, claim.user_id);
      if (targets.has(target)) throw new Error("Export destination collision");
      targets.add(target);
      exportOwners.set(claim.path, claim.user_id);
    }
    if (exportOwners.size !== artifacts.length) throw new Error("Missing explicit export claims");
    stage = mkdtempSync(join(dirname(destination), ".ownership-copy-"));
    await db.backup(join(stage, "print-partner.db"));
    if (snapshotDigest(db) !== input.source_digest)
      throw new Error("Source snapshot changed during copy");
    productFiles(source, db, stage);
    for (const artifact of artifacts) {
      const owner = exportOwners.get(artifact.path);
      if (!owner) throw new Error("Missing export owner");
      const target = join(stage, ownershipExportTarget(artifact, owner));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(join(source, "exports", artifact.path), target);
      if (ownershipFileDigest(target) !== artifact.sha256)
        throw new Error("Export changed during copy");
    }
    if (JSON.stringify(exportInventory(source, db)) !== JSON.stringify(artifacts))
      throw new Error("Export inventory changed during copy");
    const original = db;
    const copy = new Database(join(stage, "print-partner.db"));
    try {
      copy.pragma("foreign_keys = ON");
      copy.transaction(() => {
        const suspended = suspendOwnershipTriggers(copy);
        for (const claim of [...input.claims].sort(
          (left, right) =>
            Number(left.table === "build_profiles") - Number(right.table === "build_profiles"),
        ))
          copy
            .prepare(
              `UPDATE ${quote(claim.table)} SET tenant_id = ? WHERE rowid = ? AND tenant_id = 'default'`,
            )
            .run(claim.user_id, claim.rowid);
        for (const row of rows(original, "projects")) {
          if (row.local_path)
            copy
              .prepare("UPDATE projects SET local_path = ? WHERE id = ?")
              .run(relocatedLocalPath(row, source, destination), z.number().parse(row.id));
        }
        for (const trigger of suspended) copy.exec(trigger.sql);
        const schemaRows = (database: Database.Database) =>
          database
            .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
            .all();
        if (JSON.stringify(schemaRows(copy)) !== JSON.stringify(schemaRows(original)))
          throw new Error("Staged schema changed during ownership copy");
        validateData(copy);
        const stagedPlateState = validateSnapshotPaths(stage ?? "", copy, false);
        if (JSON.stringify(stagedPlateState) !== JSON.stringify(sourcePlateState))
          throw new Error("Staged accepted Plate state differs from source");
        for (const table of tables(original)) {
          const expectedRows = rows(original, table).map((row) => {
            const owner = claims.get(key(table, row.__rowid));
            const changed = owner ? { ...row, tenant_id: owner } : row;
            return table === "projects" && row.local_path
              ? { ...changed, local_path: relocatedLocalPath(row, source, destination) }
              : changed;
          });
          if (JSON.stringify(rows(copy, table)) !== JSON.stringify(expectedRows))
            throw new Error(`Unexpected row changes in ${table}`);
        }
      })();
      if (
        copy.pragma("integrity_check", { simple: true }) !== "ok" ||
        z.array(z.unknown()).parse(copy.pragma("foreign_key_check")).length
      )
        throw new Error("Staged database integrity failed");
    } finally {
      copy.close();
    }
    const stagedFiles = new Map(productFileDigests(stage));
    const copiedFiles = sourceFiles.filter(
      ([path]) =>
        !(
          path.startsWith(`exports${sep}`) &&
          inOwnershipExportStage(path.slice(8).split(sep).join("/"))
        ),
    );
    if (stagedFiles.size !== copiedFiles.length)
      throw new Error("Staged artifact inventory differs from source");
    for (const [path, digest] of copiedFiles) {
      const artifact = path.startsWith(`exports${sep}`)
        ? artifacts.find((artifact) => artifact.path === path.slice(8).split(sep).join("/"))
        : undefined;
      const owner = artifact && exportOwners.get(artifact.path);
      const target = artifact && owner ? ownershipExportTarget(artifact, owner) : path;
      if (stagedFiles.get(target) !== digest)
        throw new Error("Staged artifact bytes differ from source");
    }
    if (JSON.stringify(productFileDigests(source)) !== JSON.stringify(sourceFiles))
      throw new Error("Source artifacts changed during copy");
    if (snapshotDigest(db) !== input.source_digest)
      throw new Error("Source snapshot changed during copy");
    writeFileSync(
      join(stage, "desktop-account.json"),
      JSON.stringify({
        version: 1,
        kind: "existing-account",
        user_id: input.selected_user_id,
        tenant_id: input.selected_user_id,
      }),
      { mode: 0o600, flag: "wx" },
    );
    publish(stage, destination);
    stage = undefined;
    return { destinationDir: destination, user_id: input.selected_user_id };
  } finally {
    db?.close();
    if (stage) rmSync(stage, { recursive: true, force: true });
    release();
  }
}
