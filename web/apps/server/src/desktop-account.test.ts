import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentSchemaVersion, schemaVersionKey } from "./db/schema.js";
import { admitDesktopAccount, accountModeSchema, type DesktopAccount } from "./desktop-account.js";

const mapping = { version: 1, kind: "existing-account", user_id: "account-a", tenant_id: "account-a" };
const directories: string[] = [];
const accounts: DesktopAccount[] = [];
afterEach(() => {
  for (const account of accounts.splice(0)) if (account.kind === "existing") account.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture(users = true): string {
  const directory = mkdtempSync(join(tmpdir(), "pp-desktop-account-"));
  directories.push(directory);
  if (users) {
    const db = new Database(join(directory, "print-partner.db"));
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, display_name TEXT, password_hash TEXT, is_admin INTEGER);
      INSERT INTO users VALUES ('account-b', 'b@example.test', 'B', NULL, 1);
      INSERT INTO users VALUES ('account-a', 'a@example.test', 'A', 'hash', 0);`);
    db.exec("CREATE TABLE app_settings (tenant_id TEXT, key TEXT, value TEXT)");
    db.prepare("INSERT INTO app_settings VALUES ('default', ?, ?)").run(schemaVersionKey, String(currentSchemaVersion));
    db.close();
  }
  return directory;
}
function map(directory: string, value: unknown = mapping): string {
  const path = join(directory, "desktop-account.json");
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}
function admit(directory: string, mode?: "existing-account-v1") {
  const path = join(directory, "desktop-account.json");
  const pin: Parameters<typeof admitDesktopAccount>[1] = mode ? (existsSync(path)
    ? { kind: "present", sha256: createHash("sha256").update(readFileSync(path)).digest("hex") }
    : { kind: "missing" }) : { kind: "disabled" };
  const account = admitDesktopAccount(directory, pin);
  accounts.push(account);
  return account;
}

describe("desktop account admission", () => {
  it("keeps a fresh copy synthetic with the gate on or off", () => {
    const directory = fixture(false);
    expect(admit(directory)).toEqual({ kind: "synthetic" });
    expect(admit(directory, "existing-account-v1")).toEqual({ kind: "synthetic" });
  });
  it("refuses a present corrupt mapping even without a database", () => {
    const directory = fixture(false);
    writeFileSync(join(directory, "desktop-account.json"), "{", { mode: 0o600 });
    expect(() => admit(directory, "existing-account-v1")).toThrow();
    expect(existsSync(join(directory, "print-partner.db"))).toBe(false);
  });
  it("requires mapping for existing users and refuses them with the gate off", () => {
    const directory = fixture();
    expect(() => admit(directory, "existing-account-v1")).toThrow("explicit desktop owner mapping");
    map(directory);
    expect(() => admit(directory)).toThrow("explicit desktop owner mapping");
  });
  it("rejects a mapping owned by a different uid", () => {
    const directory = fixture();
    map(directory);
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Unix uid required");
    const identity = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    try { expect(() => admit(directory, "existing-account-v1")).toThrow("owned by the current user"); }
    finally { identity.mockRestore(); }
  });
  it("selects the exact account and preserves nonadmin metadata", () => {
    const directory = fixture();
    map(directory);
    const account = admit(directory, "existing-account-v1");
    if (account.kind !== "existing") throw new Error("Expected mapped account");
    expect(account.principal()).toEqual({ user_id: "account-a", tenant_id: "account-a", login: "a@example.test",
      display_name: "A", email: "a@example.test", provider: "desktop", hasPassword: true, is_admin: false });
    map(directory, { ...mapping, user_id: "account-b", tenant_id: "account-b" });
    expect(account.principal().user_id).toBe("account-a");
  });
  it.each(["changed", "removed", "appeared"])("refuses a %s mapping against the runtime pin before writes", kind => {
    const directory = fixture();
    const path = map(directory);
    const present = accountModeSchema.parse({ kind: "existing-account-v1", pin: {
      kind: "present", sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    } }).pin;
    if (kind === "changed") map(directory, { ...mapping, user_id: "account-b", tenant_id: "account-b" });
    if (kind === "removed") rmSync(path);
    const before = readFileSync(join(directory, "print-partner.db"));
    expect(() => admitDesktopAccount(directory, kind === "appeared" ? { kind: "missing" } : present)).toThrow();
    expect(readFileSync(join(directory, "print-partner.db"))).toEqual(before);
  });
  it.each([{}, { kind: "existing-account-v1" }, { kind: "existing-account-v1", pin: { kind: "disabled" } },
    { kind: "existing-account-v1", pin: { kind: "missing", sha256: "00".repeat(32) } },
    { kind: "existing-account-v1", pin: { kind: "present", sha256: "bad" } }])("rejects invalid account mode %j", value => {
    expect(accountModeSchema.safeParse(value).success).toBe(false);
  });
  it("reads metadata again after demotion and fails after deletion", () => {
    const directory = fixture();
    map(directory, { ...mapping, user_id: "account-b", tenant_id: "account-b" });
    const account = admit(directory, "existing-account-v1");
    if (account.kind !== "existing") throw new Error("Expected mapped account");
    expect(account.principal().is_admin).toBe(true);
    const db = new Database(join(directory, "print-partner.db"));
    try {
      db.prepare("UPDATE users SET is_admin = 0, email = NULL, display_name = 'Changed', password_hash = 'hash' WHERE id = 'account-b'").run();
      expect(account.principal()).toEqual({ user_id: "account-b", tenant_id: "account-b", login: "Changed",
        display_name: "Changed", email: null, provider: "desktop", hasPassword: true, is_admin: false });
      db.prepare("DELETE FROM users WHERE id = 'account-b'").run();
      expect(() => account.principal()).toThrow();
    } finally { db.close(); }
  });
  it.each([null, {}, { ...mapping, version: 2 }, { ...mapping, extra: true },
    { ...mapping, user_id: "unknown", tenant_id: "unknown" }, { ...mapping, tenant_id: "account-b" },
    { ...mapping, user_id: "default", tenant_id: "default" }, { ...mapping, kind: "synthetic" }])(
    "rejects an invalid or absent selected account %j without changing the database", (value) => {
      const directory = fixture();
      map(directory, value);
      const before = readFileSync(join(directory, "print-partner.db"));
      expect(() => admit(directory, "existing-account-v1")).toThrow();
      expect(readFileSync(join(directory, "print-partner.db"))).toEqual(before);
    });
  it.each(["symlink", "directory", "public", "large", "corrupt", "fifo"])("rejects an unsafe %s mapping", async (kind) => {
    const directory = fixture();
    const path = join(directory, "desktop-account.json");
    if (kind === "directory") mkdirSync(path);
    else if (kind === "symlink") { const target = map(directory); renameSync(target, `${target}.private`); symlinkSync(`${target}.private`, path); }
    else if (kind === "fifo") {
      const { spawnSync } = await import("node:child_process");
      expect(spawnSync("mkfifo", [path]).status).toBe(0);
    } else {
      map(directory);
      if (kind === "public") chmodSync(path, 0o644);
      if (kind === "large") writeFileSync(path, " ".repeat(4097));
      if (kind === "corrupt") writeFileSync(path, "{");
    }
    expect(() => admitDesktopAccount(directory, { kind: "present", sha256: "00".repeat(32) })).toThrow();
  });
  it("fails if an otherwise valid mapping points into a fresh store", () => {
    const directory = fixture(false);
    map(directory);
    expect(() => admit(directory, "existing-account-v1")).toThrow("does not exist");
  });
  it.each(["0", String(currentSchemaVersion - 1), String(currentSchemaVersion + 1), "bad"])("refuses schema %s before writing", version => {
    const directory = fixture();
    map(directory);
    const db = new Database(join(directory, "print-partner.db"));
    db.prepare("UPDATE app_settings SET value = ? WHERE key = ?").run(version, schemaVersionKey);
    db.close();
    const before = readFileSync(join(directory, "print-partner.db"));
    expect(() => admit(directory, "existing-account-v1")).toThrow();
    expect(readFileSync(join(directory, "print-partner.db"))).toEqual(before);
  });
  it.each([false, true])("rejects database replacement through a path alias %s", (alias) => {
    const directory = fixture();
    map(directory);
    const path = join(directory, "print-partner.db");
    if (alias) { renameSync(path, `${path}.actual`); symlinkSync(`${path}.actual`, path); }
    const account = admit(directory, "existing-account-v1");
    if (account.kind !== "existing") throw new Error("Expected mapped account");
    expect(account.principal().user_id).toBe("account-a");
    const actual = alias ? `${path}.actual` : path;
    renameSync(actual, `${actual}.old`);
    const replacement = new Database(actual);
    replacement.exec("CREATE TABLE users (id TEXT)");
    replacement.close();
    expect(() => account.principal()).toThrow("database changed");
  });
});
