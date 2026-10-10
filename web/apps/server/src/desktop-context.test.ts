import { once } from "node:events";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireDataDirectory, verifyDesktopPrincipal } from "./desktop-context.js";
import { processIdentity } from "./storage-lease.js";

const setup = { key: "ab".repeat(32), generation: "cd".repeat(16) };
const principal = { version: 1, generation: setup.generation, tenant: "default", actor: "desktop-owner",
  method: "POST", target: "/plans/1/save?expected=2", issued_at: 100_000 };
function signed(value: unknown) {
  const encoded = Buffer.from(JSON.stringify(value)).toString("hex");
  return { encoded, signature: createHmac("sha256", Buffer.from(setup.key, "hex")).update(encoded).digest("hex"),
    method: principal.method, target: principal.target, now: 100_500 };
}

describe("Rust-written storage markers", () => {
  it.each(["dead PID", "reused PID"])("recovers a marker with a %s", (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), "pp-rust-stale-owner-"));
    const dead = scenario === "dead PID" ? spawnSync(process.execPath, ["-e", ""]) : null;
    if (dead) expect(dead.status).toBe(0);
    const owner = {
      pid: dead?.pid ?? process.pid,
      process_identity: `${processIdentity(process.pid)}-prior`,
      instance: "ab".repeat(16),
    };
    const marker = JSON.stringify({ pid: owner.pid, process_identity: owner.process_identity,
      child_pid: owner.pid, child_process_identity: owner.process_identity,
      lease_hash: "cd".repeat(32), runtime_dir: join(tmpdir(), "pp-prior-runtime") });
    try {
      mkdirSync(join(directory, ".desktop-lease"));
      writeFileSync(join(directory, ".desktop-lease/owner.json"), JSON.stringify(owner));
      writeFileSync(join(directory, ".desktop-owner.json"), marker, { mode: 0o600 });
      const release = acquireDataDirectory(directory);
      try {
        expect(readFileSync(join(directory, ".desktop-lease/previous-marker.json"), "utf8")).toBe(marker);
        expect(JSON.parse(readFileSync(join(directory, ".desktop-owner.json"), "utf8")))
          .toEqual({ pid: process.pid, kind: "standalone", process_identity: processIdentity(process.pid) });
        expect(() => acquireDataDirectory(directory)).toThrow("already owned");
      } finally { release(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each([undefined, {}, { child_pid: 0, child_process_identity: "prior" },
    { child_pid: process.pid, child_process_identity: processIdentity(process.pid) }])
    ("refuses a dead core marker with missing, invalid or live child info %j", (child) => {
      const directory = mkdtempSync(join(tmpdir(), "pp-rust-child-owner-"));
      const dead = spawnSync(process.execPath, ["-e", ""]);
      expect(dead.status).toBe(0);
      const marker = JSON.stringify({ pid: dead.pid, process_identity: "prior",
        lease_hash: "cd".repeat(32), ...child });
      const path = join(directory, ".desktop-owner.json");
      try {
        writeFileSync(path, marker);
        expect(() => acquireDataDirectory(directory)).toThrow("already owned");
        expect(readFileSync(path, "utf8")).toBe(marker);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });

  it.each([true, false])("preserves a live owner's marker (identity present: %s)", (withIdentity) => {
    const directory = mkdtempSync(join(tmpdir(), "pp-rust-live-owner-"));
    const path = join(directory, ".desktop-owner.json");
    const marker = JSON.stringify({ pid: process.pid,
      ...(withIdentity ? { process_identity: processIdentity(process.pid) } : {}),
      lease_hash: "cd".repeat(32), runtime_dir: join(tmpdir(), "pp-live-runtime") });
    try {
      // No lease directory: the marker itself must protect a live legacy owner.
      writeFileSync(path, marker, { mode: 0o600 });
      expect(() => acquireDataDirectory(directory)).toThrow("already owned");
      expect(readFileSync(path, "utf8")).toBe(marker);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("desktop principal boundary", () => {
  it("accepts the exact authenticated request context", () => {
    expect(verifyDesktopPrincipal(signed(principal), setup)).toEqual(principal);
  });
  it.each([
    { version: 2 }, { generation: "ef".repeat(16) }, { tenant: "other" }, { actor: "other" },
    { method: "GET" }, { target: "/plans/2/save?expected=2" }, { target: "/plans/1/save?expected=3" },
    { issued_at: 1 }, { issued_at: 200_000 },
  ])("rejects a signed assertion with changed context %j", (changed) => {
    expect(() => verifyDesktopPrincipal(signed({ ...principal, ...changed }), setup)).toThrow();
  });
  it("rejects missing, forged and previous-generation signatures", () => {
    expect(() => verifyDesktopPrincipal({ ...signed(principal), encoded: undefined }, setup)).toThrow();
    expect(() => verifyDesktopPrincipal({ ...signed(principal), signature: "00".repeat(32) }, setup)).toThrow();
    expect(() => verifyDesktopPrincipal(signed(principal), { ...setup, key: "fe".repeat(32) })).toThrow();
  });
});

it("arbitrates standalone writers through an exclusive marker", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { acquireDataDirectory } = await import("./desktop-context.js");
  const directory = mkdtempSync(join(tmpdir(), "pp-owner-test-"));
  try {
    const release = acquireDataDirectory(directory);
    expect(() => acquireDataDirectory(directory)).toThrow("already owned");
    release();
    release();
    acquireDataDirectory(directory)();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


it("recovers a crash-left standalone marker and starts a later writer", async () => {
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { acquireDataDirectory } = await import("./desktop-context.js");
  const directory = mkdtempSync(join(tmpdir(), "pp-crashed-owner-"));
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import { acquireDataDirectory } from ${JSON.stringify(new URL("./desktop-context.ts", import.meta.url).href)};
     acquireDataDirectory(${JSON.stringify(directory)});
     console.log("owned"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(() => { throw new Error("Owner exited before acquisition"); }),
    ]);
    expect(JSON.parse(readFileSync(join(directory, ".desktop-owner.json"), "utf8")).pid).toBe(child.pid);
    expect(() => acquireDataDirectory(directory)).toThrow("already owned");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    expect(JSON.parse(readFileSync(join(directory, ".desktop-owner.json"), "utf8")).pid).toBe(child.pid);
    const release = acquireDataDirectory(directory);
    expect(() => acquireDataDirectory(directory)).toThrow("already owned");
    release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

it("preserves a live legacy standalone marker without an OS lock", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { acquireDataDirectory } = await import("./desktop-context.js");
  const directory = mkdtempSync(join(tmpdir(), "pp-live-owner-"));
  const marker = join(directory, ".desktop-owner.json");
  const contents = JSON.stringify({ pid: process.pid, kind: "standalone" });
  try {
    writeFileSync(marker, contents);
    expect(() => acquireDataDirectory(directory)).toThrow("already owned");
    expect(readFileSync(marker, "utf8")).toBe(contents);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("serializes competing stale-marker recovery across processes", async () => {
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "pp-owner-race-"));
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(dead, "exit");
  writeFileSync(join(directory, ".desktop-owner.json"), JSON.stringify({ pid: dead.pid, kind: "standalone" }));
  mkdirSync(join(directory, ".desktop-lease"));
  writeFileSync(join(directory, ".desktop-lease/owner.json"), JSON.stringify({ pid: dead.pid, process_identity: "prior-boot:prior-start", instance: "cd".repeat(16) }));
  const script = `import { acquireDataDirectory } from ${JSON.stringify(new URL("./desktop-context.ts", import.meta.url).href)};
    try { acquireDataDirectory(${JSON.stringify(directory)}); console.log("owned"); }
    catch { console.log("blocked"); }
    setInterval(() => {}, 1000);`;
  const children = [0, 1].map(() => spawn(process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] }));
  try {
    const results = await Promise.all(children.map(async (child) => {
      const [output] = await Promise.race([
        once(child.stdout, "data"),
        once(child, "exit").then(() => { throw new Error("Contender exited before reporting"); }),
      ]);
      return output.toString().trim();
    }));
    expect(results.sort()).toEqual(["blocked", "owned"]);
  } finally {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      }
    }));
    rmSync(directory, { recursive: true, force: true });
  }
});

it("recovers reused-PID markers and leases with a different process identity", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { acquireDataDirectory } = await import("./desktop-context.js");
  const { processIdentity } = await import("./storage-lease.js");
  const directory = mkdtempSync(join(tmpdir(), "pp-reused-pid-"));
  try {
    const owner = { pid: process.pid, kind: "standalone", process_identity: `${processIdentity(process.pid)}-prior`, instance: "ab".repeat(16) };
    mkdirSync(join(directory, ".desktop-lease"));
    writeFileSync(join(directory, ".desktop-lease/owner.json"), JSON.stringify(owner));
    writeFileSync(join(directory, ".desktop-owner.json"), JSON.stringify(owner));
    const release = acquireDataDirectory(directory);
    const current = JSON.parse(readFileSync(join(directory, ".desktop-owner.json"), "utf8"));
    expect(current.process_identity).toBe(processIdentity(process.pid));
    expect(() => acquireDataDirectory(directory)).toThrow("already owned");
    release();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("keeps a live matching-identity marker owned", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { acquireDataDirectory } = await import("./desktop-context.js");
  const { processIdentity } = await import("./storage-lease.js");
  const directory = mkdtempSync(join(tmpdir(), "pp-matching-pid-"));
  try {
    writeFileSync(join(directory, ".desktop-owner.json"), JSON.stringify({ pid: process.pid, kind: "standalone", process_identity: processIdentity(process.pid) }));
    expect(() => acquireDataDirectory(directory)).toThrow("already owned");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
