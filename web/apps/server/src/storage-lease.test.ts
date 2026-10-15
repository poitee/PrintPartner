import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { acquireDataDirectory } from "./desktop-context.js";
import { acquireStorageLease, processIdentity } from "./storage-lease.js";

const instance = "ab".repeat(16);
const roots: string[] = [];
const releases: (() => void)[] = [];
let deadPid: number;

beforeAll(() => {
  const dead = spawnSync(process.execPath, ["-e", ""]);
  expect(dead.status).toBe(0);
  deadPid = dead.pid;
});

afterEach(() => {
  for (const release of releases.splice(0)) release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "pp-storage-lease-"));
  roots.push(root);
  return root;
}

function owner(pid = process.pid) {
  return { pid, process_identity: processIdentity(process.pid), instance };
}

function publish(dir: string, bytes: string): void {
  mkdirSync(join(dir, ".desktop-lease"));
  writeFileSync(join(dir, ".desktop-lease", "owner.json"), bytes);
}

function inventory(path: string): unknown {
  const stat = lstatSync(path);
  const metadata = { ino: stat.ino, dev: stat.dev, mode: stat.mode };
  if (stat.isSymbolicLink()) return { ...metadata, target: readlinkSync(path) };
  if (stat.isDirectory()) {
    return { ...metadata, entries: readdirSync(path).sort().map((name) => [name, inventory(join(path, name))]) };
  }
  return { ...metadata, bytes: readFileSync(path).toString("base64") };
}

function evidence(dir: string): void {
  writeFileSync(join(dir, ".desktop-owner.json"), '{ "evidence": "retain exact marker bytes" }\n');
  const retained = join(dir, `.desktop-lease-retired-${"cd".repeat(16)}`);
  mkdirSync(retained);
  writeFileSync(join(retained, "previous-marker.json"), "retained evidence\n");
}

const acquisition = [
  { name: "direct acquisition", acquire: (dir: string) => acquireStorageLease(dir).release },
  { name: "acquireDataDirectory", acquire: acquireDataDirectory },
];

const invalidOwners = [
  { name: "empty file", bytes: () => "" },
  { name: "torn JSON", bytes: () => '{"pid":' },
  { name: "null", bytes: () => "null" },
  { name: "array", bytes: (pid: number) => JSON.stringify([owner(pid)]) },
  { name: "empty object", bytes: () => "{}" },
  { name: "missing PID", bytes: (pid: number) => JSON.stringify({ ...owner(pid), pid: undefined }) },
  { name: "null PID", bytes: (pid: number) => JSON.stringify({ ...owner(pid), pid: null }) },
  ...[0, -1, 1.5, "1", 2147483648].map((pid) => ({
    name: `invalid PID ${JSON.stringify(pid)}`, bytes: () => JSON.stringify({ ...owner(), pid }),
  })),
  ...[undefined, null, "", " \t\n", 42].map((process_identity) => ({
    name: `invalid identity ${JSON.stringify(process_identity)}`,
    bytes: (pid: number) => JSON.stringify({ ...owner(pid), process_identity }),
  })),
  ...[undefined, null, 42, "", "ab".repeat(15), "AB".repeat(16), "gh".repeat(16)].map((invalidInstance) => ({
    name: `invalid instance ${JSON.stringify(invalidInstance)}`,
    bytes: (pid: number) => JSON.stringify({ ...owner(pid), instance: invalidInstance }),
  })),
];

describe.each(acquisition)("$name rejects malformed leases", ({ acquire }) => {
  describe.each(["live", "dead"])("with a %s PID", (liveness) => {
    it.each(invalidOwners)("preserves $name and all evidence through repeated rejection", ({ bytes }) => {
      const dir = dataDir();
      publish(dir, bytes(liveness === "live" ? process.pid : deadPid));
      evidence(dir);
      const before = inventory(dir);
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(() => { releases.push(acquire(dir)); }).toThrowError(/storage_lease_marker_invalid/);
        expect(inventory(dir)).toEqual(before);
      }
    });
  });

  it.each(["empty", "nonempty"])("preserves an %s owner-less directory", (contents) => {
    const dir = dataDir();
    mkdirSync(join(dir, ".desktop-lease"));
    if (contents === "nonempty") writeFileSync(join(dir, ".desktop-lease", "previous-marker.json"), "owner missing\n");
    evidence(dir);
    const before = inventory(dir);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(() => { releases.push(acquire(dir)); }).toThrowError(/storage_lease_marker_invalid/);
      expect(inventory(dir)).toEqual(before);
    }
  });

  it.each(["file", "valid symlink", "broken symlink"])("preserves a lease that is a %s", (kind) => {
    const dir = dataDir();
    const lease = join(dir, ".desktop-lease");
    if (kind === "file") writeFileSync(lease, JSON.stringify(owner(deadPid)));
    else {
      const target = join(dir, "target");
      if (kind === "valid symlink") {
        mkdirSync(target);
        writeFileSync(join(target, "owner.json"), JSON.stringify(owner(deadPid)));
      }
      symlinkSync(target, lease);
    }
    evidence(dir);
    const before = inventory(dir);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(() => { releases.push(acquire(dir)); }).toThrowError(/storage_lease_marker_invalid/);
      expect(inventory(dir)).toEqual(before);
    }
  });
});

describe("valid lease owners", () => {
  it("publishes a complete owner, refuses a second writer and releases for reacquisition", () => {
    const dir = dataDir();
    const held = acquireStorageLease(dir);
    try {
      const recorded: unknown = JSON.parse(readFileSync(join(dir, ".desktop-lease", "owner.json"), "utf8"));
      expect(recorded).toEqual({ pid: process.pid, process_identity: processIdentity(process.pid), instance: expect.stringMatching(/^[a-f0-9]{32}$/) });
      expect(held.identity).toBe(processIdentity(process.pid));
      expect(() => acquireStorageLease(dir)).toThrow("already owned");
    } finally { held.release(); }
    expect(readdirSync(dir)).toEqual([]);
    const next = acquireStorageLease(dir);
    expect(next.identity).toBe(processIdentity(process.pid));
    next.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("accepts extra owner fields and preserves a matching live lease", () => {
    const dir = dataDir();
    publish(dir, JSON.stringify({ ...owner(), runtime: "Rust", extra: { version: 1 } }));
    const before = inventory(dir);
    expect(() => acquireStorageLease(dir)).toThrow("already owned");
    expect(inventory(dir)).toEqual(before);
  });

  it.each(["dead", "reused"])("recovers a %s owner and retains its exact identity bytes and inode", (scenario) => {
    const dir = dataDir();
    const bytes = JSON.stringify({ ...owner(scenario === "dead" ? deadPid : process.pid),
      process_identity: `  ${processIdentity(process.pid)}\n`, extra: ["compatible"] }, null, 2) + "\n";
    publish(dir, bytes);
    writeFileSync(join(dir, ".desktop-lease", "previous-marker.json"), "old marker\n");
    const before = inventory(join(dir, ".desktop-lease"));
    const held = acquireStorageLease(dir);
    try {
      expect(held.identity).toBe(processIdentity(process.pid));
      expect(inventory(join(dir, `.desktop-lease-retired-${instance}`))).toEqual(before);
      expect(readFileSync(join(dir, `.desktop-lease-retired-${instance}`, "owner.json"), "utf8")).toBe(bytes);
      expect(() => acquireStorageLease(dir)).toThrow("already owned");
    } finally { held.release(); }
    expect(readdirSync(dir)).toEqual([`.desktop-lease-retired-${instance}`]);
  });

  it("keeps a nonempty retirement destination and stale lease intact through exhaustion", () => {
    const dir = dataDir();
    publish(dir, JSON.stringify(owner(deadPid)));
    mkdirSync(join(dir, `.desktop-lease-retired-${instance}`));
    writeFileSync(join(dir, `.desktop-lease-retired-${instance}`, "owner.json"), "older evidence");
    const before = inventory(dir);
    expect(() => acquireStorageLease(dir)).toThrow("ownership changed repeatedly");
    expect(inventory(dir)).toEqual(before);
  });
});

describe("lease observation races", () => {
  it.each(["lease disappears", "only owner disappears"])("handles owner-open ENOENT when %s", (scenario) => {
    const dir = dataDir();
    publish(dir, JSON.stringify(owner(deadPid)));
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { acquireStorageLease } from ${JSON.stringify(new URL("./storage-lease.ts", import.meta.url).href)};
      const open = fs.openSync;
      let injected = false;
      fs.openSync = function(path, ...args) {
        if (!injected && path === ${JSON.stringify(join(dir, ".desktop-lease", "owner.json"))}) {
          injected = true;
          fs.rmSync(${JSON.stringify(join(dir, ".desktop-lease", scenario === "lease disappears" ? "" : "owner.json"))}, { recursive: true });
        }
        return open.call(this, path, ...args);
      };
      syncBuiltinESMExports();
      try {
        const lease = acquireStorageLease(${JSON.stringify(dir)});
        console.log(JSON.stringify({ kind: "acquired", identity: lease.identity, injected }));
        lease.release();
      } catch (error) {
        console.log(JSON.stringify({ kind: "refused", message: error.message, injected }));
      }
    `], { encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    const result: unknown = JSON.parse(child.stdout);
    if (scenario === "lease disappears") {
      expect(result).toEqual({ kind: "acquired", identity: expect.stringMatching(/^[a-f0-9-]+:\d+$/), injected: true });
      expect(readdirSync(dir)).toEqual([]);
    } else {
      expect(result).toEqual({ kind: "refused", message: expect.stringContaining("storage_lease_marker_invalid"), injected: true });
      expect(readdirSync(dir)).toEqual([".desktop-lease"]);
      expect(readdirSync(join(dir, ".desktop-lease"))).toEqual([]);
    }
  });

  it("rejects a file inserted before publication without overwriting it", () => {
    const dir = dataDir();
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { acquireStorageLease } from ${JSON.stringify(new URL("./storage-lease.ts", import.meta.url).href)};
      const rename = fs.renameSync;
      let injected = false;
      fs.renameSync = function(from, to) {
        if (!injected && to === ${JSON.stringify(join(dir, ".desktop-lease"))}) {
          injected = true;
          fs.writeFileSync(to, "inserted evidence");
        }
        return rename.call(this, from, to);
      };
      syncBuiltinESMExports();
      try { acquireStorageLease(${JSON.stringify(dir)}); process.exitCode = 4; }
      catch (error) { console.log(error.message); }
    `], { encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("storage_lease_marker_invalid");
    expect(readFileSync(join(dir, ".desktop-lease"), "utf8")).toBe("inserted evidence");
    expect(readdirSync(dir)).toEqual([".desktop-lease"]);
    expect(existsSync(join(dir, ".desktop-owner.json"))).toBe(false);
  });
});

describe.each([undefined, "0", "true", "1"])("release recovery flag %s", (flag) => {
  it("retries cleanup of an already detached lease", () => {
    const dir = dataDir();
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { acquireStorageLease } from ${JSON.stringify(new URL("./storage-lease.ts", import.meta.url).href)};
      const flag = ${JSON.stringify(flag) ?? "undefined"};
      if (flag === undefined) delete process.env.PP_STORAGE_RELEASE_RECOVERY;
      else process.env.PP_STORAGE_RELEASE_RECOVERY = flag;
      const lease = acquireStorageLease(${JSON.stringify(dir)});
      const remove = fs.rmSync;
      let failed = false;
      fs.rmSync = function(path, ...args) {
        if (!failed && String(path).includes(".desktop-lease-release-")) {
          failed = true;
          throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
        }
        return remove.call(this, path, ...args);
      };
      syncBuiltinESMExports();
      let first = null;
      try { lease.release(); } catch (error) { first = error.code; }
      lease.release();
      console.log(JSON.stringify({ first, entries: fs.readdirSync(${JSON.stringify(dir)}) }));
    `], { encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ first: "EACCES", entries: [] });
  });

  it.each([".desktop-lease-release-", ".desktop-owner-release-"])("only opts into detached checks for %s with 1", (prefix) => {
    const dir = dataDir();
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { acquireDataDirectory } from ${JSON.stringify(new URL("./desktop-context.ts", import.meta.url).href)};
      const flag = ${JSON.stringify(flag) ?? "undefined"};
      if (flag === undefined) delete process.env.PP_STORAGE_RELEASE_RECOVERY;
      else process.env.PP_STORAGE_RELEASE_RECOVERY = flag;
      const release = acquireDataDirectory(${JSON.stringify(dir)});
      process.env.PP_STORAGE_RELEASE_RECOVERY = flag === "1" ? "0" : "1";
      const open = fs.openSync;
      let rechecked = false;
      fs.openSync = function(path, ...args) {
        if (String(path).includes(${JSON.stringify(prefix)})) {
          rechecked = true;
          throw Object.assign(new Error("detached record unavailable"), { code: "ENXIO" });
        }
        return open.call(this, path, ...args);
      };
      syncBuiltinESMExports();
      let error = null;
      try { release(); } catch (caught) { error = caught.code; }
      fs.openSync = open;
      syncBuiltinESMExports();
      release();
      const entries = fs.readdirSync(${JSON.stringify(dir)});
      acquireDataDirectory(${JSON.stringify(dir)})();
      console.log(JSON.stringify({ rechecked, error, entries }));
    `], { encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ rechecked: flag === "1", error: flag === "1" ? "ENXIO" : null, entries: [] });
  });
});

describe("release after the lease is removed externally", () => {
  it.each(acquisition)("$name treats a missing lease as released and admits the next writer", ({ acquire }) => {
    const dir = dataDir();
    const release = acquire(dir);
    rmSync(join(dir, ".desktop-lease"), { recursive: true });
    release();
    expect(readdirSync(dir)).toEqual([]);
    releases.push(acquire(dir));
  });

  it("leaves a lease another writer republished in place", () => {
    const dir = dataDir();
    const held = acquireStorageLease(dir);
    rmSync(join(dir, ".desktop-lease"), { recursive: true });
    const next = acquireStorageLease(dir);
    releases.push(next.release);
    const before = inventory(dir);
    held.release();
    expect(inventory(dir)).toEqual(before);
    expect(() => acquireStorageLease(dir)).toThrow("already owned");
  });

  it("acquireDataDirectory treats a missing owner marker as released", () => {
    const dir = dataDir();
    const release = acquireDataDirectory(dir);
    rmSync(join(dir, ".desktop-owner.json"));
    release();
    expect(readdirSync(dir)).toEqual([]);
    releases.push(acquireDataDirectory(dir));
  });

  it("acquireDataDirectory leaves an owner marker another writer recorded in place", () => {
    const dir = dataDir();
    const release = acquireDataDirectory(dir);
    const foreign = JSON.stringify({ pid: process.pid, kind: "standalone", process_identity: "another-writer" });
    writeFileSync(join(dir, ".desktop-owner.json"), foreign);
    release();
    expect(readFileSync(join(dir, ".desktop-owner.json"), "utf8")).toBe(foreign);
    rmSync(join(dir, ".desktop-owner.json"));
  });

  it("acquireDataDirectory leaves the marker of a later reservation in the same process in place", () => {
    const dir = dataDir();
    const first = acquireDataDirectory(dir);
    rmSync(join(dir, ".desktop-lease"), { recursive: true });
    rmSync(join(dir, ".desktop-owner.json"));
    const second = acquireDataDirectory(dir);
    releases.push(second);
    const before = inventory(dir);
    first();
    expect(inventory(dir)).toEqual(before);
    expect(() => acquireDataDirectory(dir)).toThrow("already owned");
  });

  it.each([
    { record: "lease owner", path: (dir: string) => join(dir, ".desktop-lease", "owner.json") },
    { record: "owner marker", path: (dir: string) => join(dir, ".desktop-owner.json") },
  ])("acquireDataDirectory keeps release retryable while its $record is unreadable", { skip: process.getuid?.() === 0 }, ({ path }) => {
    const dir = dataDir();
    const release = acquireDataDirectory(dir);
    chmodSync(path(dir), 0o000);
    expect(release).toThrow(/EACCES/);
    chmodSync(path(dir), 0o600);
    release();
    expect(readdirSync(dir)).toEqual([]);
    releases.push(acquireDataDirectory(dir));
  });

  const foreign = JSON.stringify({ pid: process.pid, kind: "standalone", process_identity: "another-writer", instance });
  it.each([
    { record: "lease", path: ".desktop-lease",
      republish: `fs.mkdirSync(target); fs.writeFileSync(target + "/owner.json", ${JSON.stringify(foreign)});`,
      kept: (target: string) => readFileSync(join(target, "owner.json"), "utf8") === foreign },
    { record: "owner marker", path: ".desktop-owner.json",
      republish: `fs.writeFileSync(target, ${JSON.stringify(foreign)});`,
      kept: (target: string) => readFileSync(target, "utf8") === foreign },
    { record: "dangling symlink marker", path: ".desktop-owner.json",
      republish: `fs.symlinkSync("missing-owner.json", target);`,
      kept: (target: string) => readlinkSync(target) === "missing-owner.json" },
    { record: "directory marker", path: ".desktop-owner.json",
      republish: `fs.mkdirSync(target); fs.writeFileSync(target + "/evidence", "retain");`,
      kept: (target: string) => readFileSync(join(target, "evidence"), "utf8") === "retain" },
  ])("hands back a $record republished between the ownership check and the detach", ({ path, republish, kept }) => {
    const dir = dataDir();
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { acquireDataDirectory } from ${JSON.stringify(new URL("./desktop-context.ts", import.meta.url).href)};
      const target = ${JSON.stringify(join(dir, path))};
      const rename = fs.renameSync;
      let injected = false;
      fs.renameSync = function(from, to) {
        if (!injected && from === target) {
          injected = true;
          fs.rmSync(target, { recursive: true });
          ${republish}
        }
        return rename.call(this, from, to);
      };
      syncBuiltinESMExports();
      acquireDataDirectory(${JSON.stringify(dir)})();
      console.log(JSON.stringify({ injected }));
    `], { encoding: "utf8", env: { ...process.env, PP_STORAGE_RELEASE_RECOVERY: "1" } });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ injected: true });
    expect(kept(join(dir, path))).toBe(true);
    expect(readdirSync(dir).filter((name) => name.includes("-release-"))).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0).each([
    { record: "lease", path: ".desktop-lease", owner: "/owner.json" },
    { record: "owner marker", path: ".desktop-owner.json", owner: "" },
  ])("resumes from the detached $record when its check fails after the detach", ({ path, owner }) => {
    const dir = dataDir();
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { acquireDataDirectory } from ${JSON.stringify(new URL("./desktop-context.ts", import.meta.url).href)};
      const target = ${JSON.stringify(join(dir, path))};
      const rename = fs.renameSync;
      let detached;
      fs.renameSync = function(from, to) {
        const result = rename.call(this, from, to);
        if (!detached && from === target) { detached = to; fs.chmodSync(to + ${JSON.stringify(owner)}, 0o000); }
        return result;
      };
      syncBuiltinESMExports();
      const release = acquireDataDirectory(${JSON.stringify(dir)});
      let first;
      try { release(); first = "released"; } catch (error) { first = error.code; }
      fs.chmodSync(detached + ${JSON.stringify(owner)}, 0o600);
      release();
      console.log(JSON.stringify({ first, entries: fs.readdirSync(${JSON.stringify(dir)}) }));
    `], { encoding: "utf8", env: { ...process.env, PP_STORAGE_RELEASE_RECOVERY: "1" } });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ first: "EACCES", entries: [] });
  });

  it.each([
    { record: "lease", path: ".desktop-lease" },
    { record: "owner marker", path: ".desktop-owner.json" },
  ])("completes when someone removes the detached $record before the hand-back", ({ path }) => {
    const dir = dataDir();
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { acquireDataDirectory } from ${JSON.stringify(new URL("./desktop-context.ts", import.meta.url).href)};
      const target = ${JSON.stringify(join(dir, path))};
      const rename = fs.renameSync;
      let injected = false;
      fs.renameSync = function(from, to) {
        if (!injected && from === target) {
          injected = true;
          fs.rmSync(target, { recursive: true });
          fs.writeFileSync(target, "foreign");
          const result = rename.call(this, from, to);
          fs.rmSync(to, { recursive: true });
          return result;
        }
        return rename.call(this, from, to);
      };
      syncBuiltinESMExports();
      acquireDataDirectory(${JSON.stringify(dir)})();
      console.log(JSON.stringify({ injected, entries: fs.readdirSync(${JSON.stringify(dir)}) }));
    `], { encoding: "utf8", env: { ...process.env, PP_STORAGE_RELEASE_RECOVERY: "1" } });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ injected: true, entries: [] });
  });
});
