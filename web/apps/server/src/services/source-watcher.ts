import { join, dirname } from "node:path";
import type { AppRepository } from "../db/repository.js";
import type { InProcessJobRunner } from "../routes/jobs.js";
import { checkAllSourceUpdates } from "./source-update-check.js";
import { syncProjectById } from "../routes/sources.js";
import { sendDiscordNotification } from "./discord-notify.js";
import { dispatchWebhooks } from "./webhook-store.js";
import { getLogger } from "./logger.js";

export type SourceWatcherSettings = {
  discordWebhookUrl: string | null;
  notifyOnUpdate: boolean;
  notifyOnSync: boolean;
  autoSyncUpdates: boolean;
};

const STARTUP_SYNC_DELAY_MS = 2_000; // 2s between startup-catch-up syncs to avoid rate limits

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Auto-sync any sources that have never been synced (last_synced_at = null).
 * Does them one at a time with a 2-second delay to avoid flooding GitHub.
 */
async function syncUnsyncedSources(
  repo: AppRepository,
  reposDir: string,
  getSettings: () => SourceWatcherSettings,
): Promise<void> {
  const logger = getLogger();
  const sources = repo.listSources().filter((s) => s.last_synced_at === null);
  if (sources.length === 0) return;

  logger.log("info", `[source-watcher] Auto-syncing ${sources.length} unsynced source(s) on startup`);

  const coversDir = join(dirname(reposDir), "covers");

  for (const source of sources) {
    try {
      logger.log("info", `[source-watcher] Auto-syncing new source: ${source.name} (id=${source.id})`);
      const result = await syncProjectById(repo, reposDir, source.id, coversDir);

      const settings = getSettings();
      if (settings.discordWebhookUrl && settings.notifyOnSync) {
        const row = repo.getProjectRow(source.id);
        await sendDiscordNotification(settings.discordWebhookUrl, "source.synced", {
          sourceName: source.name,
          sourceUrl: source.url,
          branch: row?.branch ?? source.branch ?? "main",
          commitSha: row?.lastCommitSha ?? null,
          stlCount: result.stl_count,
        });
      }
      void dispatchWebhooks(repo, "source.synced", {
        source_id: source.id,
        source_name: source.name,
        source_url: source.url,
        branch: repo.getProjectRow(source.id)?.branch ?? source.branch ?? "main",
        commit_sha: repo.getProjectRow(source.id)?.lastCommitSha ?? null,
        stl_count: result.stl_count,
      });
    } catch (err) {
      logger.log(
        "warn",
        `[source-watcher] Startup sync failed for ${source.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      const settings = getSettings();
      if (settings.discordWebhookUrl && settings.notifyOnSync) {
        const row = repo.getProjectRow(source.id);
        await sendDiscordNotification(settings.discordWebhookUrl, "source.sync_failed", {
          sourceName: source.name,
          sourceUrl: source.url,
          branch: row?.branch ?? source.branch ?? "main",
          error: err instanceof Error ? err.message : String(err),
        }).catch(() => {});
      }
      void dispatchWebhooks(repo, "source.sync_failed", {
        source_id: source.id,
        source_name: source.name,
        source_url: source.url,
        branch: repo.getProjectRow(source.id)?.branch ?? source.branch ?? "main",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await sleep(STARTUP_SYNC_DELAY_MS);
  }
}

/**
 * Periodic update check + auto-sync for sources with available updates.
 */
async function runPeriodicUpdateCheck(
  repo: AppRepository,
  reposDir: string,
  getSettings: () => SourceWatcherSettings,
): Promise<void> {
  const logger = getLogger();
  const settings = getSettings();

  logger.log("info", "[source-watcher] Running periodic source update check");

  let checkResult: Awaited<ReturnType<typeof checkAllSourceUpdates>>;
  try {
    checkResult = await checkAllSourceUpdates(repo);
  } catch (err) {
    logger.log(
      "warn",
      `[source-watcher] Update check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  logger.log(
    "info",
    `[source-watcher] Update check: ${checkResult.checked_count} checked, ${checkResult.updates_available} with updates`,
  );

  if (checkResult.updates_available === 0) return;

  const coversDir = join(dirname(reposDir), "covers");

  // Find sources that have updates_available
  const allSources = repo.listSources();
  const sourcesWithUpdates = allSources.filter((s) => s.update_status === "updates_available");

  for (const source of sourcesWithUpdates) {
    const row = repo.getProjectRow(source.id);
    const previousSha = row?.lastCommitSha ?? null;

    if (settings.autoSyncUpdates) {
      // Auto-sync
      try {
        logger.log("info", `[source-watcher] Auto-syncing updated source: ${source.name}`);
        const result = await syncProjectById(repo, reposDir, source.id, coversDir);

        const currentSettings = getSettings();
        if (currentSettings.discordWebhookUrl && currentSettings.notifyOnUpdate) {
          const updatedRow = repo.getProjectRow(source.id);
          await sendDiscordNotification(currentSettings.discordWebhookUrl, "source.updated", {
            sourceName: source.name,
            sourceUrl: source.url,
            branch: row?.branch ?? source.branch ?? "main",
            commitSha: updatedRow?.lastCommitSha ?? null,
            previousSha,
            stlCount: result.stl_count,
          });
        }
        void dispatchWebhooks(repo, "source.updated", {
          source_id: source.id,
          source_name: source.name,
          source_url: source.url,
          branch: row?.branch ?? source.branch ?? "main",
          commit_sha: repo.getProjectRow(source.id)?.lastCommitSha ?? null,
          previous_sha: previousSha,
          stl_count: result.stl_count,
        });
      } catch (err) {
        logger.log(
          "warn",
          `[source-watcher] Auto-sync failed for ${source.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
        const currentSettings = getSettings();
        if (currentSettings.discordWebhookUrl) {
          await sendDiscordNotification(currentSettings.discordWebhookUrl, "source.sync_failed", {
            sourceName: source.name,
            sourceUrl: source.url,
            branch: row?.branch ?? source.branch ?? "main",
            error: err instanceof Error ? err.message : String(err),
          }).catch(() => {});
        }
        void dispatchWebhooks(repo, "source.sync_failed", {
          source_id: source.id,
          source_name: source.name,
          source_url: source.url,
          branch: row?.branch ?? source.branch ?? "main",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (settings.discordWebhookUrl && settings.notifyOnUpdate) {
      // Notify but don't sync
      await sendDiscordNotification(settings.discordWebhookUrl, "source.update_available", {
        sourceName: source.name,
        sourceUrl: source.url,
        branch: row?.branch ?? source.branch ?? "main",
        commitSha: previousSha,
      });
      void dispatchWebhooks(repo, "source.update_available", {
        source_id: source.id,
        source_name: source.name,
        source_url: source.url,
        branch: row?.branch ?? source.branch ?? "main",
        commit_sha: previousSha,
      });
    } else {
      // No Discord configured — still fire webhook if registered
      void dispatchWebhooks(repo, "source.update_available", {
        source_id: source.id,
        source_name: source.name,
        source_url: source.url,
        branch: row?.branch ?? source.branch ?? "main",
        commit_sha: previousSha,
      });
    }
  }
}

/**
 * Start the background source watcher.
 * - On startup: syncs any sources that have never been synced.
 * - Periodically: checks for upstream changes and auto-syncs if configured.
 */
export function startSourceWatcher(
  repo: AppRepository,
  reposDir: string,
  _jobs: InProcessJobRunner,
  getSettings: () => SourceWatcherSettings,
): { stop: () => void } {
  const logger = getLogger();

  // Startup: sync unsynced sources after a short delay to let the server finish booting
  const startupTimer = setTimeout(() => {
    void syncUnsyncedSources(repo, reposDir, getSettings);
  }, 5_000);

  // Periodic interval - re-read the setting each tick so it reacts to user changes
  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  function scheduleInterval(): void {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    const hours = Number(repo.getSetting("source_update_check_hours", "24"));
    if (!hours || hours <= 0) {
      logger.log("info", "[source-watcher] Periodic update check disabled (interval=0)");
      return;
    }
    const ms = hours * 60 * 60 * 1000;
    logger.log("info", `[source-watcher] Scheduling periodic update check every ${hours}h`);
    intervalHandle = setInterval(() => {
      void runPeriodicUpdateCheck(repo, reposDir, getSettings);
    }, ms);
  }

  // Initial schedule
  scheduleInterval();

  // Watch for interval changes every 60s (in case the user changes the setting)
  let lastKnownInterval = repo.getSetting("source_update_check_hours", "24");
  const configPoller = setInterval(() => {
    const current = repo.getSetting("source_update_check_hours", "24");
    if (current !== lastKnownInterval) {
      lastKnownInterval = current;
      logger.log("info", `[source-watcher] Update check interval changed to ${current}h — rescheduling`);
      scheduleInterval();
    }
  }, 60_000);

  return {
    stop(): void {
      clearTimeout(startupTimer);
      if (intervalHandle) clearInterval(intervalHandle);
      clearInterval(configPoller);
      logger.log("info", "[source-watcher] Stopped");
    },
  };
}
