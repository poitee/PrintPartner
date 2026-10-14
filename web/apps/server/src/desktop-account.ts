import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { currentSchemaVersion } from "./db/schema.js";
import { readSchemaVersion } from "./db/upgrade-guard.js";
import type { SessionUser } from "./routes/auth-types.js";

const mappingSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("existing-account"),
  user_id: z.string().min(1).max(256),
  tenant_id: z.string().min(1).max(256),
}).refine(value => value.user_id !== "default" && value.tenant_id === value.user_id);
const userSchema = z.object({
  id: z.string(), email: z.string().nullable(), display_name: z.string(),
  password_hash: z.string().nullable(), is_admin: z.union([z.literal(0), z.literal(1)]),
});

export const accountModeSchema = z.strictObject({
  kind: z.literal("existing-account-v1"),
  pin: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("missing") }),
    z.strictObject({ kind: z.literal("present"), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  ]),
});
type MappingPin = { kind: "disabled" } | z.infer<typeof accountModeSchema>["pin"];

type Mapping = z.infer<typeof mappingSchema>;
export type DesktopAccount =
  | { kind: "synthetic" }
  | { kind: "existing"; mapping: Mapping; assertDatabase: () => void; principal: () => SessionUser; close: () => void };

function readMapping(path: string, pin: Exclude<MappingPin, { kind: "disabled" }>): Mapping | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT" && pin.kind === "missing") return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || process.getuid?.() !== stat.uid || (stat.mode & 0o7777) !== 0o600 || stat.size > 4096) {
      throw new Error("Desktop account mapping must be a private regular file owned by the current user");
    }
    const bytes = Buffer.alloc(4097);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null);
      if (read === 0) break;
      size += read;
    }
    if (size > 4096) throw new Error("Desktop account mapping is too large");
    const contents = bytes.subarray(0, size);
    if (pin.kind !== "present" || createHash("sha256").update(contents).digest("hex") !== pin.sha256) {
      throw new Error("Desktop account mapping changed; full runtime restart required");
    }
    return mappingSchema.parse(JSON.parse(contents.toString("utf8")));
  } finally { closeSync(fd); }
}

export function admitDesktopAccount(dataDir: string, pin: MappingPin = { kind: "disabled" }): DesktopAccount {
  const mapping = pin.kind === "disabled" ? null : readMapping(join(dataDir, "desktop-account.json"), pin);
  const path = join(dataDir, "print-partner.db");
  let exists = true;
  try { lstatSync(path); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") exists = false;
    else throw error;
  }
  if (!exists) {
    if (mapping) throw new Error("Mapped desktop account does not exist");
    return { kind: "synthetic" };
  }
  const canonical = realpathSync(path);
  const identity = statSync(canonical);
  if (!identity.isFile()) throw new Error("Desktop database must be a regular file");
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const users = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
    if (!mapping) {
      if (users && db.prepare("SELECT 1 FROM users LIMIT 1").get()) {
        throw new Error("Existing accounts require explicit desktop owner mapping");
      }
      db.close();
      return { kind: "synthetic" };
    }
    if (readSchemaVersion(db) !== currentSchemaVersion) {
      throw new Error("Mapped desktop requires the current database schema; upgrade with the unmapped server first");
    }
    const assertDatabase = (): void => {
      const current = statSync(path);
      if (realpathSync(path) !== canonical || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new Error("Mapped desktop database changed; restart required");
      }
    };
    const readPrincipal = (): SessionUser => {
      assertDatabase();
      const row = userSchema.parse(db.prepare(
        "SELECT id, email, display_name, password_hash, is_admin FROM users WHERE id = ?",
      ).get(mapping.user_id));
      return { user_id: row.id, tenant_id: mapping.tenant_id, login: row.email ?? row.display_name,
        display_name: row.display_name, email: row.email, provider: "desktop",
        hasPassword: Boolean(row.password_hash), is_admin: row.is_admin === 1 };
    };
    readPrincipal();
    return { kind: "existing", mapping, assertDatabase, principal: readPrincipal, close: () => db.close() };
  } catch (error) { db.close(); throw error; }
}
