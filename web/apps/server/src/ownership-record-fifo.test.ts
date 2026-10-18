import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parentReservedCopy, rustOwnedCopy } from "./db/rust-owned.js";
import { acquireDataDirectory, installDesktopContext, releaseOrphanedDesktopOwner } from "./desktop-context.js";
import { acquireStorageLease } from "./storage-lease.js";

const roots: string[] = [];
const releaseAfterMs = 2_000;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataDir(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pp-ownership-fifo-")));
  roots.push(root);
  mkdirSync(join(root, ".desktop-lease"));
  return root;
}

function fifo(path: string): void {
  expect(spawnSync("mkfifo", [path]).status).toBe(0);
}

// A blocked synchronous read stalls this thread, so a separate process opens the
// write side after a delay. A reader that blocked then sees EOF and the elapsed
// time reports the hang instead of the suite never finishing.
function admitWithinBound<T>(path: string, admit: () => T): T {
  const before = lstatSync(path);
  const releaser = spawn(process.execPath, [
    "-e",
    `setTimeout(() => { const fs = require("node:fs"); fs.closeSync(fs.openSync(process.argv[1], "w")); }, ${releaseAfterMs})`,
    path,
  ], { stdio: "ignore" });
  const started = performance.now();
  try {
    let outcome: { value: T } | { error: unknown };
    try { outcome = { value: admit() }; } catch (error) { outcome = { error }; }
    const elapsed = performance.now() - started;
    expect(elapsed, `admission blocked on a FIFO record for ${Math.round(elapsed)}ms`).toBeLessThan(releaseAfterMs / 2);
    const after = lstatSync(path);
    expect(after.isFIFO()).toBe(true);
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  } finally {
    releaser.kill("SIGKILL");
  }
}

describe("FIFO ownership records", () => {
  it("refuses a FIFO lease owner record when acquiring the storage lease", () => {
    const dir = dataDir();
    const owner = join(dir, ".desktop-lease", "owner.json");
    fifo(owner);
    expect(() => admitWithinBound(owner, () => acquireStorageLease(dir))).toThrow("storage_lease_marker_invalid");
  });

  it("refuses a FIFO desktop owner marker when reserving the data directory", () => {
    const dir = dataDir();
    rmSync(join(dir, ".desktop-lease"), { recursive: true });
    const marker = join(dir, ".desktop-owner.json");
    fifo(marker);
    expect(() => admitWithinBound(marker, () => acquireDataDirectory(dir))).toThrow("Ownership record is not a regular file");
    expect(lstatSync(join(dir, ".desktop-lease"), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("treats a FIFO desktop owner marker as a foreign owner", () => {
    const dir = dataDir();
    const marker = join(dir, ".desktop-owner.json");
    fifo(marker);
    expect(admitWithinBound(marker, () => rustOwnedCopy(dir))).toEqual({ kind: "foreign" });
  });

  it("treats a FIFO lease owner record as a foreign owner", () => {
    const dir = dataDir();
    const owner = join(dir, ".desktop-lease", "owner.json");
    fifo(owner);
    expect(admitWithinBound(owner, () => rustOwnedCopy(dir))).toEqual({ kind: "foreign" });
  });

  it("does not treat a FIFO lease owner record as a parent reservation", () => {
    const dir = dataDir();
    const owner = join(dir, ".desktop-lease", "owner.json");
    fifo(owner);
    expect(admitWithinBound(owner, () => parentReservedCopy(dir))).toBe(false);
  });

  it("requires the core lock without opening a FIFO legacy marker during desktop setup", () => {
    const dir = dataDir();
    const marker = join(dir, ".desktop-owner.json");
    fifo(marker);
    const setup = {
      version: 1, data_dir: dir, socket_path: join(dir, "pp.sock"), generation: "ab".repeat(16),
      key: "cd".repeat(32), parent_pid: process.ppid, port: 1,
    };
    expect(() => admitWithinBound(marker, () => installDesktopContext(setup))).toThrow("Core storage lock required");
  });

  it("removes its private socket without opening a FIFO legacy marker during orphaned shutdown", () => {
    const dir = dataDir();
    const marker = join(dir, ".desktop-owner.json");
    fifo(marker);
    mkdirSync(join(dir, "run"));
    const socket = join(dir, "run", "pp.sock");
    writeFileSync(socket, "");
    admitWithinBound(marker, () => releaseOrphanedDesktopOwner({ data_dir: dir, socket_path: socket, parent_pid: process.ppid }));
    expect(existsSync(socket)).toBe(false);
    expect(existsSync(join(dir, "run"))).toBe(false);
  });
});
