import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDataDirectory, storageWorkerEnv } from "../desktop-context.js";
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
function bareConnect(
  dir: string,
  hold: boolean,
  lease: "own" | "parent" = "own",
  env: NodeJS.ProcessEnv = process.env,
): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import { SqliteDatabase } from ${JSON.stringify(clientUrl)};
     const db = new SqliteDatabase(${JSON.stringify(dir)}, ${JSON.stringify(lease)});
     try { db.connect(); } catch (error) { console.error(error.message); process.exit(3); }
     console.log("connected");
     if (${hold}) setInterval(() => {}, 1000); else db.close();`], { env });
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

describe("bare connect with malformed storage leases", () => {
  function inventory(path: string): unknown {
    const stat = lstatSync(path);
    const metadata = { ino: stat.ino, dev: stat.dev, mode: stat.mode };
    if (stat.isSymbolicLink()) return { ...metadata, target: readlinkSync(path) };
    if (stat.isDirectory()) {
      return { ...metadata, entries: readdirSync(path).sort().map((name) => [name, inventory(join(path, name))]) };
    }
    return { ...metadata, bytes: readFileSync(path).toString("base64") };
  }

  const cases = ["empty directory", "owner-less nonempty directory", "empty owner", "torn owner", "null owner",
    "incomplete owner", "zero PID", "uppercase instance", "blank identity", "whitespace identity", "file", "valid symlink", "broken symlink"];

  describe.each(["new", "existing"])("with a %s database", (database) => {
    it.each(cases)("preserves the copy and prevents creation or migration with a %s", async (scenario) => {
      const dir = dataDir();
      if (database === "existing") {
        const sqlite = new Database(join(dir, "print-partner.db"));
        sqlite.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('keep before migration');");
        sqlite.close();
      }
      const dead = spawnSync(process.execPath, ["-e", ""]);
      expect(dead.status).toBe(0);
      const lease = join(dir, ".desktop-lease");
      const validOwner = { pid: dead.pid, process_identity: "previous-boot:previous-start", instance: "ab".repeat(16) };
      if (scenario === "file") writeFileSync(lease, JSON.stringify(validOwner));
      else if (scenario.endsWith("symlink")) {
        const target = join(dir, "lease-target");
        if (scenario === "valid symlink") {
          mkdirSync(target);
          writeFileSync(join(target, "owner.json"), JSON.stringify(validOwner));
        }
        symlinkSync(target, lease);
      } else {
        mkdirSync(lease);
        if (scenario === "owner-less nonempty directory") writeFileSync(join(lease, "previous-marker.json"), "lease evidence\n");
        else if (scenario !== "empty directory") {
          const ownerBytes: Record<string, string> = {
            "empty owner": "",
            "torn owner": '{"pid":',
            "null owner": "null",
            "incomplete owner": JSON.stringify({ pid: dead.pid }),
            "zero PID": JSON.stringify({ ...validOwner, pid: 0 }),
            "uppercase instance": JSON.stringify({ ...validOwner, instance: "AB".repeat(16) }),
            "blank identity": JSON.stringify({ ...validOwner, process_identity: "" }),
            "whitespace identity": JSON.stringify({ ...validOwner, process_identity: " \t\n" }),
          };
          writeFileSync(join(lease, "owner.json"), ownerBytes[scenario]);
        }
      }
      const before = inventory(dir);
      for (let attempt = 0; attempt < 2; attempt++) {
        const refused = await outcome(bareConnect(dir, false));
        expect(refused.code).toBe(3);
        expect(refused.stdout).toBe("");
        expect(refused.stderr).toMatch(/storage_lease_marker_invalid|Node will not migrate or write/);
        if (scenario === "whitespace identity") expect(refused.stderr).toContain("storage_lease_marker_invalid");
        expect(inventory(dir)).toEqual(before);
      }
      expect(existsSync(join(dir, "print-partner.db"))).toBe(database === "existing");
    }, 30_000);
  });
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
  it("connects while the parent holds the copy and hands over its identity", async () => {
    const dir = dataDir();
    const db = new SqliteDatabase(dir);
    db.connect();
    try {
      const worker = bareConnect(dir, false, "parent", { ...process.env, ...storageWorkerEnv(dir) });
      expect(await outcome(worker)).toMatchObject({ code: 0, stdout: "connected\n" });
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

  it("does not advance profile sequences on a current schema", async () => {
    const dir = dataDir();
    const db = new SqliteDatabase(dir);
    db.connect();
    const sequences = () => {
      const raw = new Database(join(dir, "print-partner.db"), { readonly: true });
      try {
        return raw.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all();
      } finally {
        raw.close();
      }
    };
    try {
      const before = sequences();
      const worker = bareConnect(dir, false, "parent", { ...process.env, ...storageWorkerEnv(dir) });
      expect((await outcome(worker)).code).toBe(0);
      expect(sequences()).toEqual(before);
    } finally {
      db.close();
    }
  }, 30_000);

  it("is refused without the parent's identity even though the parent holds the copy", async () => {
    const dir = dataDir();
    const db = new SqliteDatabase(dir);
    db.connect();
    try {
      for (const env of [process.env, { ...process.env, PP_STORAGE_PARENT_IDENTITY: "instance:" + "ab".repeat(16) }]) {
        const worker = await outcome(bareConnect(dir, false, "parent", env));
        expect(worker.code).toBe(3);
        expect(worker.stderr).toContain("The parent process does not hold this data directory");
      }
    } finally {
      db.close();
    }
  }, 30_000);
});

describe("a close whose release fails", () => {
  it.skipIf(process.getuid?.() === 0)("is finished by the next connect, so the copy is released after one close", () => {
    const dir = dataDir();
    const db = new SqliteDatabase(dir);
    db.connect();
    chmodSync(dir, 0o500);
    try {
      expect(() => db.close()).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(existsSync(join(dir, ".desktop-owner.json"))).toBe(true);
    db.connect();
    db.close();
    expect(existsSync(join(dir, ".desktop-lease"))).toBe(false);
    expect(existsSync(join(dir, ".desktop-owner.json"))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("after the lease is detached does not let a later connection reuse it", () => {
    const dir = dataDir();
    const first = new SqliteDatabase(dir);
    first.connect();
    chmodSync(join(dir, ".desktop-lease"), 0o500);
    expect(() => first.close()).toThrow();
    const detached = readdirSync(dir).filter((name) => name.startsWith(".desktop-lease-release-"));
    expect(detached).toHaveLength(1);
    chmodSync(join(dir, detached[0]!), 0o700);
    expect(existsSync(join(dir, ".desktop-lease"))).toBe(false);

    const second = new SqliteDatabase(dir);
    second.connect();
    expect(existsSync(join(dir, ".desktop-lease"))).toBe(true);
    first.close();
    expect(JSON.parse(readFileSync(join(dir, ".desktop-owner.json"), "utf8")).pid).toBe(process.pid);
    expect(existsSync(join(dir, ".desktop-lease"))).toBe(true);
    second.close();
    expect(readdirSync(dir).filter((name) => name.startsWith(".desktop-"))).toEqual([]);
  });
});
