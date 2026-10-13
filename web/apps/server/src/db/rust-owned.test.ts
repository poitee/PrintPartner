import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { processIdentity } from "../storage-lease.js";
import { rustOwnedCopy } from "./rust-owned.js";

const roots: string[] = [];

afterEach(() => {
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
        child_process_identity: processIdentity(child.pid),
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

  it("does not treat a non-Linux instance token as this Linux process", () => {
    const dir = markerDir({
      storage_protocol_version: 1,
      pid: deadPid(),
      process_identity: "prior",
      child_pid: process.pid,
      child_process_identity: `instance:${"ab".repeat(16)}`,
    });
    expect(rustOwnedCopy(dir)).toEqual({ kind: "absent" });
  });
});
