import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import {
  beginSourceSyncAdmission,
  packagedSourceSyncManifestPath,
} from "../ownership/source-sync-admission.js";
import { startSourceWatcher } from "./source-watcher.js";

describe("Source watcher runtime admission", () => {
  it.each([
    { phase: "startup", advanceBefore: 0, advanceAfter: 7_000 },
    { phase: "periodic", advanceBefore: 7_000, advanceAfter: 3_600_000 },
    { phase: "startup batch", advanceBefore: 5_000, advanceAfter: 2_000 },
  ])("refuses a changed manifest during $phase work", async ({ advanceBefore, advanceAfter }) => {
    const dir = mkdtempSync(join(tmpdir(), "pp-watcher-admission-"));
    const sqlite = new SqliteDatabase(dir);
    const priorManifest = process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST;
    let watcher: ReturnType<typeof startSourceWatcher> | undefined;
    try {
      sqlite.connect();
      const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
      const first = repo.createSource({ name: "A unsynced", source_kind: "github", url: "invalid" });
      const second = repo.createSource({ name: "B unsynced", source_kind: "github", url: "invalid" });
      repo.setSetting("source_update_check_hours", "1");
      const manifest = join(dir, "manifest.json");
      const original = readFileSync(packagedSourceSyncManifestPath(), "utf8");
      writeFileSync(manifest, original);
      process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST = manifest;
      beginSourceSyncAdmission(dir);
      vi.useFakeTimers();
      watcher = startSourceWatcher({
        repo,
        reposDir: sqlite.reposDir,
        listTenantIds: () => ["default"],
        getSettings: () => ({
          discordWebhookUrl: null, notifyOnUpdate: false, notifyOnSync: false, autoSyncUpdates: true,
        }),
      });
      await vi.advanceTimersByTimeAsync(0);
      if (advanceBefore > 0) {
        await vi.advanceTimersByTimeAsync(advanceBefore);
        expect(repo.getProjectRow(first.id)?.metadataJson).toContain("sync_error");
      }
      const before = [repo.getProjectRow(first.id), repo.getProjectRow(second.id)];
      const beforeEvents = repo.listAppEvents({ kinds: ["source.updated", "source.update_available"] });
      writeFileSync(manifest, `${original}\n`);
      await vi.advanceTimersByTimeAsync(advanceAfter);
      expect([repo.getProjectRow(first.id), repo.getProjectRow(second.id)]).toEqual(before);
      expect(repo.listAppEvents({ kinds: ["source.updated", "source.update_available"] })).toEqual(beforeEvents);
      expect(repo.getSetting("source_update_check_last_run_at")).toBeNull();
    } finally {
      watcher?.stop();
      vi.useRealTimers();
      if (priorManifest === undefined) delete process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST;
      else process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST = priorManifest;
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
