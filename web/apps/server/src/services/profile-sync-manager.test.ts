import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { getRequestTenantId, tenantStorage } from "../middleware/tenant-context.js";
import type {
  ProfileSyncEmitter,
  ProfileSyncSettings,
  ProfileSyncWatcherFactory,
} from "./profile-sync.js";
import { startManagedProfileSync } from "./profile-sync-manager.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("managed profile sync", () => {
  it("keeps one tenant-bound watcher per tenant and reloads only the changed tenant", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pp-profile-sync-manager-"));
    const sqlite = new SqliteDatabase(directory);
    sqlite.connect();
    cleanup.push(() => {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const repository = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);

    tenantStorage.run("tenant-a", () => {
      repository.upsertSlicerInstance({
        id: "slicer-a",
        name: "Tenant A Orca",
        kind: "orca",
        dialect: "orca_json",
        watchPath: "/profiles/a",
      });
    });
    tenantStorage.run("tenant-b", () => {
      repository.upsertSlicerInstance({
        id: "slicer-b",
        name: "Tenant B Prusa",
        kind: "prusa",
        dialect: "prusa_ini",
        watchPath: "/profiles/b",
      });
    });

    const starts: Array<{
      tenantId: string;
      settings: ProfileSyncSettings;
      stopped: boolean;
      emitter: ProfileSyncEmitter;
      runInContext: <T>(work: () => T) => T;
    }> = [];
    const createWatcher: ProfileSyncWatcherFactory = (
      _repo,
      settings,
      emitter,
      runInContext = (work) => work(),
    ) => {
      const record = {
        tenantId: getRequestTenantId(),
        settings,
        stopped: false,
        emitter,
        runInContext,
      };
      starts.push(record);
      return {
        stop: async () => {
          record.stopped = true;
        },
        syncAll: async () => {},
      };
    };
    const emitted: string[] = [];
    const prepared: string[] = [];
    let tenantIds = ["tenant-a", "tenant-b", "tenant-a"];
    const manager = startManagedProfileSync({
      repository,
      listTenantIds: () => tenantIds,
      createWatcher,
      emit: (tenantId) => emitted.push(tenantId),
      prepareTenant: () => prepared.push(getRequestTenantId()),
      tenantRefreshMs: 0,
    });
    cleanup.push(manager.stop);

    expect(starts.map((start) => start.tenantId)).toEqual(["tenant-a", "tenant-b"]);
    expect(prepared).toEqual(["tenant-a", "tenant-b"]);
    expect(starts.map((start) => start.settings.roots[0]?.baseDir)).toEqual([
      "/profiles/a",
      "/profiles/b",
    ]);
    expect(starts[0]?.runInContext(() => getRequestTenantId())).toBe("tenant-a");
    expect(starts[1]?.runInContext(() => getRequestTenantId())).toBe("tenant-b");

    starts[1]?.emitter({ kind: "process", slicer: "prusa", name: "Draft", version: null });
    expect(emitted).toEqual(["tenant-b"]);

    await manager.reloadTenant("tenant-a");
    expect(starts).toHaveLength(3);
    expect(starts[0]?.stopped).toBe(true);
    expect(starts[1]?.stopped).toBe(false);
    expect(starts[2]?.tenantId).toBe("tenant-a");

    tenantIds = ["tenant-a", "tenant-c"];
    await manager.reconcileTenants();
    expect(starts[1]?.stopped).toBe(true);
    expect(starts[3]?.tenantId).toBe("tenant-c");
    expect(prepared).toEqual(["tenant-a", "tenant-b", "tenant-c"]);
  });

  it("retries a tenant after watcher recreation fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pp-profile-sync-manager-"));
    const sqlite = new SqliteDatabase(directory);
    sqlite.connect();
    cleanup.push(() => {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const repository = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    let failNextStart = false;
    let successfulStarts = 0;
    let stops = 0;
    const createWatcher: ProfileSyncWatcherFactory = () => {
      if (failNextStart) throw new Error("watcher unavailable");
      successfulStarts += 1;
      return {
        stop: async () => {
          stops += 1;
        },
        syncAll: async () => {},
      };
    };
    const manager = startManagedProfileSync({
      repository,
      listTenantIds: () => ["tenant-a"],
      createWatcher,
      emit: () => {},
      tenantRefreshMs: 0,
    });
    cleanup.push(manager.stop);

    failNextStart = true;
    await expect(manager.reloadTenant("tenant-a")).rejects.toThrow("watcher unavailable");
    failNextStart = false;
    await manager.reconcileTenants();

    expect(successfulStarts).toBe(2);
    expect(stops).toBe(1);
  });

  it("waits for the previous watcher to close before starting its replacement", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pp-profile-sync-manager-"));
    const sqlite = new SqliteDatabase(directory);
    sqlite.connect();
    cleanup.push(() => {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const repository = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    let releaseClose = () => {};
    const closeCompleted = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let watcherStarts = 0;
    const createWatcher: ProfileSyncWatcherFactory = () => {
      watcherStarts += 1;
      return {
        stop: () => closeCompleted,
        syncAll: async () => {},
      };
    };
    const manager = startManagedProfileSync({
      repository,
      listTenantIds: () => ["tenant-a"],
      createWatcher,
      emit: () => {},
      tenantRefreshMs: 0,
    });

    try {
      const reloaded = manager.reloadTenant("tenant-a");

      expect(watcherStarts).toBe(1);
      releaseClose();
      await reloaded;
      expect(watcherStarts).toBe(2);
    } finally {
      releaseClose();
      await manager.stop();
    }
  });

  it("does not finish shutdown until every watcher has closed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pp-profile-sync-manager-"));
    const sqlite = new SqliteDatabase(directory);
    sqlite.connect();
    cleanup.push(() => {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const repository = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    let releaseClose = () => {};
    const closeCompleted = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const manager = startManagedProfileSync({
      repository,
      listTenantIds: () => ["tenant-a"],
      createWatcher: () => ({
        stop: () => closeCompleted,
        syncAll: async () => {},
      }),
      emit: () => {},
      tenantRefreshMs: 0,
    });
    let shutdownFinished = false;

    try {
      const shutdown = Promise.resolve(manager.stop()).then(() => {
        shutdownFinished = true;
      });
      await Promise.resolve();

      expect(shutdownFinished).toBe(false);
      releaseClose();
      await shutdown;
      expect(shutdownFinished).toBe(true);
    } finally {
      releaseClose();
    }
  });
});
