import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSelfHostPorts } from "./adapters/self-host/index.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const profileSync = vi.hoisted(() => {
  const reloadTenant = vi.fn().mockRejectedValue(new Error("watcher recreation failed"));
  return {
    reloadTenant,
    startManagedProfileSync: vi.fn(() => ({
      stop: async () => {},
      syncAll: async () => {},
      reloadTenant,
      reconcileTenants: async () => {},
    })),
  };
});

vi.mock("./services/profile-sync-manager.js", () => ({
  startManagedProfileSync: profileSync.startManagedProfileSync,
}));

describe("profile-sync reload failure semantics", () => {
  const roots: string[] = [];

  afterEach(() => {
    profileSync.reloadTenant.mockClear();
    profileSync.startManagedProfileSync.mockClear();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("keeps a successful slicer mutation successful when watcher reload fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-profile-reload-failure-"));
    roots.push(dataDir);
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    const app = await buildApp({ ...loadConfig(), dataDir }, ports);

    try {
      const created = await app.inject({
        method: "POST",
        url: "/slicer-instances",
        payload: {
          name: "Reload failure slicer",
          kind: "orca",
        },
      });
      const listed = await app.inject({
        method: "GET",
        url: "/slicer-instances",
      });

      expect(listed.json()).toMatchObject({
        instances: [expect.objectContaining({ name: "Reload failure slicer" })],
      });
      expect(created.statusCode).toBe(201);
      expect(profileSync.startManagedProfileSync).toHaveBeenCalledOnce();
      expect(profileSync.reloadTenant).toHaveBeenCalledOnce();
    } finally {
      await app.close();
      ports.db.close();
    }
  });

  it("does not start host filesystem profile sync for a multi-user server", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-profile-sync-multi-user-"));
    roots.push(dataDir);
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    const app = await buildApp({
      ...loadConfig(),
      dataDir,
      multiUser: true,
      authRequired: true,
      sessionSecret: "profile-sync-test-secret",
    }, ports);

    try {
      expect(profileSync.startManagedProfileSync).not.toHaveBeenCalled();
    } finally {
      await app.close();
      ports.db.close();
    }
  });
});
