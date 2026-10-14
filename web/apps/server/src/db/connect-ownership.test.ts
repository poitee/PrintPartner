import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDataDirectory } from "../desktop-context.js";
import { SqliteDatabase } from "./client.js";

const clientUrl = new URL("./client.ts", import.meta.url).href;
const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pp-connect-owner-"));
  roots.push(dir);
  return dir;
}

// A separate Node process that opens the copy with a bare connect, as tests
// and dev scripts do, and optionally keeps it open.
function bareConnect(dir: string, hold: boolean, lease: "own" | "parent" = "own"): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import { SqliteDatabase } from ${JSON.stringify(clientUrl)};
     const db = new SqliteDatabase(${JSON.stringify(dir)}, ${JSON.stringify(lease)});
     try { db.connect(); } catch (error) { console.error(error.message); process.exit(3); }
     console.log("connected");
     if (${hold}) setInterval(() => {}, 1000); else db.close();`]);
  children.push(child);
  return child;
}

async function outcome(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}

async function connected(child: ChildProcessWithoutNullStreams): Promise<void> {
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() => { throw new Error("Writer exited before connecting"); }),
  ]);
}

describe("bare SqliteDatabase.connect across processes", () => {
  it("refuses a second process while this process holds an open connection", async () => {
    const dir = dataDir();
    const db = new SqliteDatabase(dir);
    db.connect();
    try {
      const denied = await outcome(bareConnect(dir, false));
      expect(denied.code).toBe(3);
      expect(denied.stderr).toContain("Node will not migrate or write");
    } finally {
      db.close();
    }
    const allowed = await outcome(bareConnect(dir, false));
    expect(allowed).toMatchObject({ code: 0, stdout: "connected\n" });
    expect(existsSync(join(dir, ".desktop-lease"))).toBe(false);
    expect(existsSync(join(dir, ".desktop-owner.json"))).toBe(false);
  }, 30_000);

  it("refuses this process while another process holds a connection, and recovers after it is killed", async () => {
    const dir = dataDir();
    const holder = bareConnect(dir, true);
    await connected(holder);
    expect(JSON.parse(readFileSync(join(dir, ".desktop-owner.json"), "utf8")).pid).toBe(holder.pid);
    expect(() => new SqliteDatabase(dir).connect()).toThrow("Node will not migrate or write");
    const exited = once(holder, "exit");
    holder.kill("SIGKILL");
    await exited;
    const db = new SqliteDatabase(dir);
    db.connect();
    try {
      expect(JSON.parse(readFileSync(join(dir, ".desktop-owner.json"), "utf8")).pid).toBe(process.pid);
    } finally {
      db.close();
    }
  }, 30_000);
});

describe("connections inside one process", () => {
  it("share the lease, which stays held until the last connection closes", async () => {
    const dir = dataDir();
    const first = new SqliteDatabase(dir);
    const second = new SqliteDatabase(dir);
    first.connect();
    second.connect();
    first.close();
    const denied = await outcome(bareConnect(dir, false));
    expect(denied.code).toBe(3);
    second.close();
    expect(existsSync(join(dir, ".desktop-lease"))).toBe(false);
  }, 30_000);

  it("keep an acquireDataDirectory reservation after the connection closes", async () => {
    const dir = dataDir();
    const releaseOwner = acquireDataDirectory(dir);
    try {
      const db = new SqliteDatabase(dir);
      db.connect();
      db.close();
      expect(() => acquireDataDirectory(dir)).toThrow("already owned");
      expect((await outcome(bareConnect(dir, false))).code).toBe(3);
    } finally {
      releaseOwner();
    }
    expect(existsSync(join(dir, ".desktop-lease"))).toBe(false);
  }, 30_000);

  it("release the reservation when connect fails", () => {
    const dir = dataDir();
    mkdirSync(join(dir, "print-partner.db"));
    expect(() => new SqliteDatabase(dir).connect()).toThrow();
    expect(existsSync(join(dir, ".desktop-lease"))).toBe(false);
    expect(existsSync(join(dir, ".desktop-owner.json"))).toBe(false);
  });
});

describe("a worker under its parent's reservation", () => {
  it("connects while the parent holds the copy", async () => {
    const dir = dataDir();
    const db = new SqliteDatabase(dir);
    db.connect();
    try {
      expect(await outcome(bareConnect(dir, false, "parent"))).toMatchObject({ code: 0, stdout: "connected\n" });
      expect(JSON.parse(readFileSync(join(dir, ".desktop-owner.json"), "utf8")).pid).toBe(process.pid);
    } finally {
      db.close();
    }
  }, 30_000);

  it("is refused when the parent does not hold the copy", async () => {
    const dir = dataDir();
    const unreserved = await outcome(bareConnect(dir, false, "parent"));
    expect(unreserved.code).toBe(3);
    expect(unreserved.stderr).toContain("The parent process does not hold this data directory");
    expect(existsSync(join(dir, "print-partner.db"))).toBe(false);

    const holder = bareConnect(dir, true);
    await connected(holder);
    const foreign = await outcome(bareConnect(dir, false, "parent"));
    expect(foreign.code).toBe(3);
    expect(foreign.stderr).toContain("The parent process does not hold this data directory");
  }, 30_000);
});
