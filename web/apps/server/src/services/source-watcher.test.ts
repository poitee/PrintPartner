import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { getRequestTenantId, tenantStorage } from "../middleware/tenant-context.js";
import { AuthStore } from "./auth-store.js";
import { createSourceWatcherCoordinator } from "./source-watcher.js";

describe("source watcher coordinator", () => {
  it("enumerates authenticated tenants against the shared repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-source-watcher-tenants-"));
    const sqlite = new SqliteDatabase(dir);
    try {
      sqlite.connect();
      const db = getDb(sqlite);
      const auth = new AuthStore(db);
      const first = auth.createUser({ email: "first@example.com", displayName: "First" });
      const second = auth.createUser({ email: "second@example.com", displayName: "Second" });
      const repo = new AppRepository(db, "default", sqlite.reposDir);
      tenantStorage.run(first.id, () => {
        repo.createSource({ name: "First tenant source", source_kind: "local" });
      });
      tenantStorage.run(second.id, () => {
        repo.createSource({ name: "Second tenant source", source_kind: "local" });
      });

      const observed = new Map<string, string[]>();
      const coordinator = createSourceWatcherCoordinator({
        listTenantIds: () => auth.listTenantIds(),
        readIntervalHours: () => 24,
        runStartupForCurrentTenant: async () => {
          observed.set(
            getRequestTenantId(),
            repo.listSources().map((source) => source.name),
          );
        },
        runPeriodicForCurrentTenant: async () => {},
        now: () => 0,
      });

      await coordinator.runStartup();

      expect(observed).toEqual(
        new Map([
          [first.id, ["First tenant source"]],
          [second.id, ["Second tenant source"]],
        ]),
      );
    } finally {
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs startup work once per tenant in isolated, serial contexts", async () => {
    const visited: string[] = [];
    let activeRuns = 0;
    let peakActiveRuns = 0;
    const coordinator = createSourceWatcherCoordinator({
      listTenantIds: () => ["tenant-b", "tenant-a", "tenant-b"],
      readIntervalHours: () => 24,
      runStartupForCurrentTenant: async () => {
        activeRuns += 1;
        peakActiveRuns = Math.max(peakActiveRuns, activeRuns);
        visited.push(getRequestTenantId());
        await Promise.resolve();
        activeRuns -= 1;
      },
      runPeriodicForCurrentTenant: async () => {},
      now: () => 0,
    });

    await coordinator.runStartup();

    expect(visited).toEqual(["tenant-b", "tenant-a"]);
    expect(peakActiveRuns).toBe(1);
  });

  it("tracks each tenant schedule and runs due checks in tenant context", async () => {
    let now = 0;
    const intervals = new Map([
      ["tenant-hourly", 1],
      ["tenant-disabled", 0],
      ["tenant-daily", 24],
    ]);
    const checked: string[] = [];
    const coordinator = createSourceWatcherCoordinator({
      listTenantIds: () => [...intervals.keys()],
      readIntervalHours: () => intervals.get(getRequestTenantId()) ?? 0,
      runStartupForCurrentTenant: async () => {},
      runPeriodicForCurrentTenant: async () => {
        checked.push(getRequestTenantId());
      },
      now: () => now,
    });

    await coordinator.runScheduledChecks();
    now = 60 * 60 * 1_000;
    await coordinator.runScheduledChecks();
    expect(checked).toEqual(["tenant-hourly"]);

    intervals.set("tenant-hourly", 6);
    now = 2 * 60 * 60 * 1_000;
    await coordinator.runScheduledChecks();
    expect(checked).toEqual(["tenant-hourly"]);

    now = 8 * 60 * 60 * 1_000;
    await coordinator.runScheduledChecks();
    expect(checked).toEqual(["tenant-hourly", "tenant-hourly"]);
  });

  it("queues one scheduled check while startup work is active", async () => {
    let now = 0;
    let releaseStartup = () => {};
    let reportStartup = () => {};
    const startupReleased = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    const startupBegan = new Promise<void>((resolve) => {
      reportStartup = resolve;
    });
    let periodicRuns = 0;
    const coordinator = createSourceWatcherCoordinator({
      listTenantIds: () => ["tenant-a"],
      readIntervalHours: () => 1,
      runStartupForCurrentTenant: async () => {
        reportStartup();
        await startupReleased;
      },
      runPeriodicForCurrentTenant: async () => {
        periodicRuns += 1;
      },
      now: () => now,
    });

    await coordinator.runScheduledChecks();
    now = 60 * 60 * 1_000;
    const startup = coordinator.runStartup();
    await startupBegan;
    const overlappingTimer = coordinator.runScheduledChecks();
    const duplicateTimer = coordinator.runScheduledChecks();
    expect(periodicRuns).toBe(0);

    releaseStartup();
    await Promise.all([startup, overlappingTimer, duplicateTimer]);
    expect(periodicRuns).toBe(1);
  });

  it("continues with the next tenant when one scheduled check fails", async () => {
    let now = 0;
    const attempted: string[] = [];
    const coordinator = createSourceWatcherCoordinator({
      listTenantIds: () => ["tenant-failing", "tenant-healthy"],
      readIntervalHours: () => 1,
      runStartupForCurrentTenant: async () => {},
      runPeriodicForCurrentTenant: async () => {
        const tenantId = getRequestTenantId();
        attempted.push(tenantId);
        if (tenantId === "tenant-failing") throw new Error("remote unavailable");
      },
      now: () => now,
    });

    await coordinator.runScheduledChecks();
    now = 60 * 60 * 1_000;
    await coordinator.runScheduledChecks();

    expect(attempted).toEqual(["tenant-failing", "tenant-healthy"]);
  });
});
