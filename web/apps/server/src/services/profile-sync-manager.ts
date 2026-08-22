import type { AppRepository } from "../db/repository.js";
import {
  buildProfileSyncSettings,
  buildProfileSyncSettingsFromInstances,
  startProfileSyncWatcher,
  type ProfileSyncEmitter,
} from "./profile-sync.js";

type WatcherHandle = { stop: () => void; syncAll: () => Promise<void> };

let handle: WatcherHandle | null = null;
let emit: ProfileSyncEmitter = () => {};
let repo: AppRepository | null = null;

export function startManagedProfileSync(
  repository: AppRepository,
  emitter: ProfileSyncEmitter,
): WatcherHandle {
  handle?.stop();
  repo = repository;
  emit = emitter;
  const watcher = startProfileSyncWatcher(repository, resolveSettings(repository), emitter);
  handle = watcher;
  return {
    stop: () => {
      watcher.stop();
      if (handle === watcher) handle = null;
    },
    syncAll: async () => {
      await watcher.syncAll();
    },
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

/** Stop and restart watchers from the current instance table (best-effort). */
export function reloadManagedProfileSync(): void {
  if (!repo) return;
  handle?.stop();
  const watcher = startProfileSyncWatcher(repo, resolveSettings(repo), emit);
  handle = watcher;
  void watcher.syncAll();
}
