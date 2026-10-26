import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

const profileSync = vi.hoisted(() => ({
  startManagedProfileSync: vi.fn(() => ({
    stop: async () => {},
    syncAll: async () => {},
    reloadTenant: async () => {},
    reconcileTenants: async () => {},
  })),
}));

vi.mock("../services/profile-sync-manager.js", () => ({
  startManagedProfileSync: profileSync.startManagedProfileSync,
}));

const PROFILE_SYNC_PARTICIPANTS = [
  "http.GET /ws/profile-sync",
  "http.HEAD /ws/profile-sync",
  "worker.startManagedProfileSync",
];

// The exact shape pp-gateway's cutover commit writes.
function record(operation: string, participants: readonly string[]): string {
  return JSON.stringify({
    schema: "pp-operation-cutover-v1",
    manifest_sha256: "0".repeat(64),
    operations: { [operation]: { parity_sha256: "1".repeat(64), fixtures: 3, participants } },
  });
}

describe("operation cutover record at Node startup", () => {
  const roots: string[] = [];

  afterEach(() => {
    profileSync.startManagedProfileSync.mockClear();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  async function start(plant?: (dataDir: string) => void) {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-operation-cutover-"));
    roots.push(dataDir);
    plant?.(dataDir);
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    try {
      return { app: await buildApp({ ...loadConfig(), dataDir }, ports), ports };
    } catch (error) {
      ports.db.close();
      throw error;
    }
  }

  async function startupError(plant: (dataDir: string) => void): Promise<string> {
    const error = await start(plant).then(
      async ({ app, ports }) => {
        await app.close();
        ports.db.close();
        return new Error("startup succeeded");
      },
      (cause: unknown) => cause,
    );
    expect(profileSync.startManagedProfileSync).not.toHaveBeenCalled();
    return error instanceof Error ? error.message : String(error);
  }

  it("starts the profile-sync worker and route while Node owns the operation", async () => {
    const { app, ports } = await start();
    try {
      expect(profileSync.startManagedProfileSync).toHaveBeenCalledOnce();
      expect(app.hasRoute({ method: "GET", url: "/ws/profile-sync" })).toBe(true);
    } finally {
      await app.close();
      ports.db.close();
    }
  });

  it("fences the worker and its route aliases after Rust takes the operation", async () => {
    const { app, ports } = await start((dataDir) => {
      writeFileSync(join(dataDir, "operation-cutover.json"), record("profile.sync", PROFILE_SYNC_PARTICIPANTS));
    });
    try {
      expect(profileSync.startManagedProfileSync).not.toHaveBeenCalled();
      expect(app.hasRoute({ method: "GET", url: "/ws/profile-sync" })).toBe(false);
      const unrelated = await app.inject({ method: "GET", url: "/slicer-instances" });
      expect(unrelated.statusCode).toBe(200);
    } finally {
      await app.close();
      ports.db.close();
    }
  });

  it("keeps the worker when Rust owns only unrelated HTTP routes", async () => {
    const { app, ports } = await start((dataDir) => {
      writeFileSync(join(dataDir, "operation-cutover.json"), record("filament.catalog", [
        "http.GET /filaments/catalog",
        "http.HEAD /filaments/catalog",
      ]));
    });
    try {
      expect(profileSync.startManagedProfileSync).toHaveBeenCalledOnce();
    } finally {
      await app.close();
      ports.db.close();
    }
  });

  it("refuses to start when Rust owns a participant Node cannot fence", async () => {
    expect(await startupError((dataDir) => {
      writeFileSync(join(dataDir, "operation-cutover.json"), record("job.printer-upload", ["job.printer-upload"]));
    })).toBe("Operation cutover assigns job.printer-upload to Rust, but Node cannot fence it");
  });

  it("refuses to start on a malformed, oversized or symlinked record", async () => {
    expect(await startupError((dataDir) => {
      writeFileSync(join(dataDir, "operation-cutover.json"), "{\"schema\":");
    })).toMatch(/^Operation cutover record is invalid: /);
    expect(await startupError((dataDir) => {
      writeFileSync(join(dataDir, "operation-cutover.json"), JSON.stringify({
        schema: "pp-operation-cutover-v2",
        manifest_sha256: "0".repeat(64),
        operations: {},
      }));
    })).toMatch(/^Operation cutover record is invalid: /);
    expect(await startupError((dataDir) => {
      writeFileSync(join(dataDir, "operation-cutover.json"), " ".repeat(256 * 1024 + 1));
    })).toBe("Operation cutover record is invalid: exceeds 262144 bytes");
    if (process.platform === "win32") return;
    expect(await startupError((dataDir) => {
      const target = join(dataDir, "elsewhere.json");
      writeFileSync(target, record("profile.sync", PROFILE_SYNC_PARTICIPANTS));
      symlinkSync(target, join(dataDir, "operation-cutover.json"));
    })).toMatch(/^Operation cutover record is invalid: /);
  });
});
