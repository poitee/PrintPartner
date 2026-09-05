import type { AppRepository } from "../db/repository.js";
import { tenantStorage } from "../middleware/tenant-context.js";
import {
  buildProfileSyncSettings,
  buildProfileSyncSettingsFromInstances,
  startProfileSyncWatcher,
  type ProfileSyncResult,
  type ProfileSyncWatcherFactory,
  type ProfileSyncWatcherHandle,
} from "./profile-sync.js";
import { getLogger } from "./logger.js";

const DEFAULT_TENANT_REFRESH_MS = 60_000;

export type ManagedProfileSyncHandle = {
  stop: () => Promise<void>;
  syncAll: () => Promise<void>;
  reloadTenant: (tenantId: string) => Promise<void>;
  reconcileTenants: () => Promise<void>;
};

type ManagedProfileSyncOptions = Readonly<{
  repository: AppRepository;
  listTenantIds: () => readonly string[];
  emit: (tenantId: string, event: ProfileSyncResult) => void;
  createWatcher?: ProfileSyncWatcherFactory;
  prepareTenant?: () => void;
  tenantRefreshMs?: number;
}>;

export function startManagedProfileSync(
  options: ManagedProfileSyncOptions,
): ManagedProfileSyncHandle {
  const createWatcher = options.createWatcher ?? startProfileSyncWatcher;
  const watchers = new Map<string, ProfileSyncWatcherHandle>();
  let lifecycle = Promise.resolve();
  let stopped = false;
  const tenantRefreshMs = options.tenantRefreshMs ?? DEFAULT_TENANT_REFRESH_MS;
  if (!Number.isSafeInteger(tenantRefreshMs) || tenantRefreshMs < 0) {
    throw new RangeError("tenantRefreshMs must be a non-negative safe integer");
  }

  function startTenant(tenantId: string, prepare: boolean): ProfileSyncWatcherHandle {
    return tenantStorage.run(tenantId, () => {
      if (prepare) options.prepareTenant?.();
      return createWatcher(
        options.repository,
        resolveSettings(options.repository),
        (event) => options.emit(tenantId, event),
        (work) => tenantStorage.run(tenantId, work),
      );
    });
  }

  function desiredTenantIds(): Set<string> {
    return new Set(
      options.listTenantIds().map((tenantId) => tenantId.trim()).filter(Boolean),
    );
  }

  function enqueueLifecycle(work: () => Promise<void>): Promise<void> {
    const run = lifecycle.catch(() => {}).then(work);
    lifecycle = run;
    return run;
  }

  function reloadTenant(tenantId: string): Promise<void> {
    const normalizedTenantId = tenantId.trim();
    if (!normalizedTenantId) return Promise.resolve();
    return enqueueLifecycle(async () => {
      if (stopped) return;
      const currentWatcher = watchers.get(normalizedTenantId);
      watchers.delete(normalizedTenantId);
      await currentWatcher?.stop();
      if (stopped) return;
      watchers.set(normalizedTenantId, startTenant(normalizedTenantId, false));
    });
  }

  function reconcileTenants(): Promise<void> {
    return enqueueLifecycle(async () => {
      if (stopped) return;
      const desired = desiredTenantIds();
      const closing: Promise<void>[] = [];
      for (const [tenantId, watcher] of watchers) {
        if (desired.has(tenantId)) continue;
        watchers.delete(tenantId);
        closing.push(watcher.stop());
      }
      await Promise.all(closing);
      if (stopped) return;
      for (const tenantId of desired) {
        if (!watchers.has(tenantId)) watchers.set(tenantId, startTenant(tenantId, true));
      }
    });
  }

  for (const tenantId of desiredTenantIds()) {
    watchers.set(tenantId, startTenant(tenantId, true));
  }
  const refreshTimer = tenantRefreshMs > 0
    ? setInterval(() => {
        void reconcileTenants().catch((error: unknown) => {
          getLogger().log(
            "error",
            `[profile-sync] tenant refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }, tenantRefreshMs)
    : null;
  refreshTimer?.unref();

  return {
    stop: () => {
      if (stopped) return lifecycle;
      stopped = true;
      if (refreshTimer) clearInterval(refreshTimer);
      return enqueueLifecycle(async () => {
        const activeWatchers = [...watchers.values()];
        watchers.clear();
        await Promise.all(activeWatchers.map((watcher) => watcher.stop()));
      });
    },
    syncAll: () =>
      enqueueLifecycle(async () => {
        if (stopped) return;
        await Promise.all([...watchers.values()].map((watcher) => watcher.syncAll()));
      }),
    reloadTenant,
    reconcileTenants,
  };
}

function resolveSettings(repository: AppRepository) {
  const instances = repository.listSlicerInstances();
  if (instances.length > 0) {
    return buildProfileSyncSettingsFromInstances(
      instances.map((row) => ({
        enabled: row.enabled,
        dialect: row.dialect,
        watch_path: row.watchPath,
      })),
    );
  }
  return buildProfileSyncSettings(process.env);
}
