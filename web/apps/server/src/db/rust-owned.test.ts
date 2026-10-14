import Database from "better-sqlite3";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { presentDesktopChildCredential } from "../desktop-child-credential.js";
import { acquireDataDirectory } from "../desktop-context.js";
import { processIdentity } from "../storage-lease.js";
import { SqliteDatabase } from "./client.js";
import { rustOwnedCopy } from "./rust-owned.js";

const roots: string[] = [];

afterEach(() => {
  presentDesktopChildCredential(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function markerDir(marker: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pp-rust-owned-"));
  roots.push(dir);
  writeFileSync(join(dir, ".desktop-owner.json"), JSON.stringify(marker));
  return dir;
}

function deadPid(): number {
  const exited = spawnSync(process.execPath, ["-e", ""]);
  if (exited.status !== 0 || typeof exited.pid !== "number") throw new Error("dead pid unavailable");
  return exited.pid;
}

function foreignProcessIdentity(pid: number): string {
  if (process.platform !== "linux") return `instance:${"ab".repeat(16)}`;
  return processIdentity(pid);
}

describe("rust owner marker", () => {
  it("keeps the recorded child authoritative after the owner dies", () => {
    const dir = markerDir({
      storage_protocol_version: 1,
      pid: deadPid(),
      process_identity: "prior",
      child_pid: process.pid,
      child_process_identity: processIdentity(process.pid),
    });
    expect(rustOwnedCopy(dir)).toEqual({ kind: "child" });
  });

  it("refuses a third process while the recorded child is alive", () => {
    const child = spawn("sleep", ["30"]);
    if (typeof child.pid !== "number") throw new Error("live child unavailable");
    try {
      const dir = markerDir({
        storage_protocol_version: 1,
        pid: deadPid(),
        process_identity: "prior",
        child_pid: child.pid,
        child_process_identity: foreignProcessIdentity(child.pid),
      });
      expect(rustOwnedCopy(dir)).toEqual({ kind: "foreign" });
    } finally {
      child.kill();
    }
  });

  it("releases the copy after the owner and the child are both dead", () => {
    const dir = markerDir({
      storage_protocol_version: 1,
      pid: deadPid(),
      process_identity: "prior",
      child_pid: deadPid(),
      child_process_identity: "prior-child",
    });
    expect(rustOwnedCopy(dir)).toEqual({ kind: "absent" });
  });

  it("admits an unmatched instance token only after this process presents it", () => {
    const token = `instance:${"ab".repeat(16)}`;
    const dir = markerDir({
      storage_protocol_version: 1,
      pid: deadPid(),
      process_identity: "prior",
      child_pid: process.pid,
      child_process_identity: token,
    });
    expect(rustOwnedCopy(dir)).toEqual({ kind: "absent" });
    presentDesktopChildCredential(`instance:${"ff".repeat(16)}`);
    expect(rustOwnedCopy(dir)).toEqual({ kind: "absent" });
    presentDesktopChildCredential(token);
    expect(rustOwnedCopy(dir)).toEqual({ kind: "child" });
  });

  it("refuses a recycled child pid while the owner is alive until the credential is presented", () => {
    const owner = spawn("sleep", ["30"]);
    if (typeof owner.pid !== "number") throw new Error("live owner unavailable");
    const token = `instance:${"cd".repeat(16)}`;
    try {
      const dir = markerDir({
        storage_protocol_version: 1,
        pid: owner.pid,
        process_identity: foreignProcessIdentity(owner.pid),
        child_pid: process.pid,
        child_process_identity: token,
      });
      expect(rustOwnedCopy(dir)).toEqual({ kind: "foreign" });
      expect(() => new SqliteDatabase(dir).connect()).toThrow(/will not migrate or write/);
      expect(existsSync(join(dir, "print-partner.db"))).toBe(false);
      presentDesktopChildCredential(token);
      expect(rustOwnedCopy(dir)).toEqual({ kind: "child" });
    } finally {
      owner.kill();
    }
  });

  it("keeps an unknown protocol marker blocking after its owner dies", () => {
    const dir = markerDir({
      storage_protocol_version: 2,
      pid: deadPid(),
      process_identity: "prior",
    });
    expect(rustOwnedCopy(dir)).toEqual({ kind: "foreign" });
    expect(() => new SqliteDatabase(dir).connect()).toThrow(/will not migrate or write/);
    expect(existsSync(join(dir, "print-partner.db"))).toBe(false);
  });

  it("keeps a protocol marker with an unreadable child blocking", () => {
    const dir = markerDir({
      storage_protocol_version: 1,
      pid: deadPid(),
      process_identity: "prior",
      child_pid: "not-a-pid",
    });
    expect(rustOwnedCopy(dir)).toEqual({ kind: "foreign" });
  });

  it("releases a dead standalone marker and keeps this process's own marker", () => {
    const dead = markerDir({ pid: deadPid(), kind: "standalone", process_identity: "prior" });
    expect(rustOwnedCopy(dead)).toEqual({ kind: "absent" });
    const ours = markerDir({
      pid: process.pid,
      kind: "standalone",
      process_identity: processIdentity(process.pid),
    });
    expect(rustOwnedCopy(ours)).toEqual({ kind: "absent" });
  });

  it("refuses connect while another process holds the lease and the marker is absent", () => {
    const owner = spawn("sleep", ["30"]);
    if (typeof owner.pid !== "number") throw new Error("lease owner unavailable");
    const dir = mkdtempSync(join(tmpdir(), "pp-rust-owned-"));
    roots.push(dir);
    try {
      mkdirSync(join(dir, ".desktop-lease"));
      writeFileSync(join(dir, ".desktop-lease", "owner.json"), JSON.stringify({
        pid: owner.pid,
        process_identity: foreignProcessIdentity(owner.pid),
        instance: "ab".repeat(16),
      }));
      expect(() => new SqliteDatabase(dir).connect()).toThrow(/will not migrate or write/);
      expect(existsSync(join(dir, "print-partner.db"))).toBe(false);
    } finally {
      owner.kill();
    }
  });

  it("refuses connect when the owner marker is unreadable", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-rust-owned-"));
    roots.push(dir);
    writeFileSync(join(dir, ".desktop-owner.json"), "{");
    expect(() => new SqliteDatabase(dir).connect()).toThrow(/will not migrate or write/);
    expect(existsSync(join(dir, "print-partner.db"))).toBe(false);
  });

  it("keeps an incomplete lease blocking", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-rust-owned-"));
    roots.push(dir);
    mkdirSync(join(dir, ".desktop-lease"));
    writeFileSync(join(dir, ".desktop-lease", "owner.json"), JSON.stringify({ pid: deadPid() }));
    expect(rustOwnedCopy(dir)).toEqual({ kind: "foreign" });
    expect(() => new SqliteDatabase(dir).connect()).toThrow(/will not migrate or write/);
    expect(existsSync(join(dir, "print-partner.db"))).toBe(false);
  });

  it("still migrates when the only lease belongs to this process", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-rust-owned-"));
    roots.push(dir);
    const releaseOwner = acquireDataDirectory(dir);
    const before = readFileSync(join(dir, ".desktop-lease", "owner.json"), "utf8");
    try {
      const database = new SqliteDatabase(dir);
      database.connect();
      database.close();
      expect(existsSync(join(dir, "print-partner.db"))).toBe(true);
      expect(readFileSync(join(dir, ".desktop-lease", "owner.json"), "utf8")).toBe(before);
    } finally {
      releaseOwner();
    }
    expect(existsSync(join(dir, ".desktop-lease"))).toBe(false);
  });

  it("replays the migration DDL for a current recorded child without replaying seeds", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-rust-owned-"));
    roots.push(dir);
    const first = new SqliteDatabase(dir);
    first.connect();
    first.close();
    const raw = new Database(join(dir, "print-partner.db"));
    raw.exec("ALTER TABLE print_progress DROP COLUMN assembled");
    raw.exec("ALTER TABLE print_jobs DROP COLUMN completed_at");
    raw.exec("DROP TRIGGER trg_parts_invalidate_accepted_revision_insert");
    const before = raw.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'printer_profiles'").get() as { seq: number };
    raw.close();
    writeFileSync(join(dir, ".desktop-owner.json"), JSON.stringify({
      storage_protocol_version: 1,
      pid: deadPid(),
      process_identity: "prior",
      child_pid: process.pid,
      child_process_identity: processIdentity(process.pid),
    }));
    const second = new SqliteDatabase(dir);
    second.connect();
    second.close();
    const check = new Database(join(dir, "print-partner.db"), { readonly: true });
    const cols = check.pragma("table_info(print_progress)") as { name: string }[];
    const jobCols = check.pragma("table_info(print_jobs)") as { name: string }[];
    const trigger = check
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_parts_invalidate_accepted_revision_insert'")
      .get();
    const after = check.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'printer_profiles'").get() as { seq: number };
    const version = check.prepare("SELECT value FROM app_settings WHERE tenant_id = 'default' AND key = 'schema_version'").get() as { value: string };
    check.close();
    expect(cols.some((column) => column.name === "assembled")).toBe(true);
    expect(jobCols.some((column) => column.name === "completed_at")).toBe(true);
    expect(trigger).toEqual({ name: "trg_parts_invalidate_accepted_revision_insert" });
    expect(after.seq).toBe(before.seq);
    expect(version.value).toBe("34");
  });

  it("repairs a missing starter profile without replaying the existing seeds", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-rust-owned-"));
    roots.push(dir);
    const first = new SqliteDatabase(dir);
    first.connect();
    first.close();
    const raw = new Database(join(dir, "print-partner.db"));
    const before = raw.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'printer_profiles'").get() as { seq: number };
    raw.prepare("DELETE FROM printer_profiles WHERE name = ?").run("Generic FDM Machine");
    raw.close();
    writeFileSync(join(dir, ".desktop-owner.json"), JSON.stringify({
      storage_protocol_version: 1,
      pid: deadPid(),
      process_identity: "prior",
      child_pid: process.pid,
      child_process_identity: processIdentity(process.pid),
    }));
    const second = new SqliteDatabase(dir);
    second.connect();
    second.close();
    const check = new Database(join(dir, "print-partner.db"), { readonly: true });
    const count = check.prepare("SELECT COUNT(*) AS n FROM printer_profiles WHERE name = ?").get("Generic FDM Machine") as { n: number };
    const after = check.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'printer_profiles'").get() as { seq: number };
    check.close();
    expect(count.n).toBe(1);
    expect(after.seq).toBe(before.seq + 1);
  });
});
