import Fastify from "fastify";
import multipart from "@fastify/multipart";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBackupRoutes } from "./backups.js";

const restoreBackup = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    version: "1",
    createdAt: "2026-08-18T09:00:00.000Z",
    appVersion: "3.1.0",
    formatVersion: 1,
  }),
);

vi.mock("../services/backup-restore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/backup-restore.js")>()),
  restoreBackup,
}));

describe("POST /backups/restore JSON contract", () => {
  const dirs: string[] = [];

  afterEach(() => {
    restoreBackup.mockClear();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("passes the canonical stored backup path to the restore service", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-backup-route-"));
    dirs.push(dataDir);
    const backupsDir = join(dataDir, "backups");
    const name = "print-partner-backup-2026-08-18.tar.gz";
    const storedName = "stored-print-partner-backup-2026-08-18.tar.gz";
    mkdirSync(backupsDir);
    writeFileSync(join(backupsDir, storedName), "archive");
    symlinkSync(storedName, join(backupsDir, name));
    const app = Fastify();
    await app.register(multipart);
    await registerBackupRoutes(app, {
      dataDir,
      sqlite: null,
      appVersion: "3.1.0",
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/backups/restore",
        payload: { backupName: name },
      });

      expect(response.statusCode).toBe(200);
      expect(restoreBackup).toHaveBeenCalledWith(
        realpathSync(join(backupsDir, storedName)),
        dataDir,
        null,
      );
    } finally {
      await app.close();
    }
  });

  it("rejects unsafe named backup paths before restore", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-backup-route-"));
    dirs.push(dataDir);
    const app = Fastify();
    await app.register(multipart);
    await registerBackupRoutes(app, {
      dataDir,
      sqlite: null,
      appVersion: "3.1.0",
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/backups/restore",
        payload: { backupName: "../outside.tar.gz" },
      });

      expect(response.statusCode).toBe(400);
      expect(restoreBackup).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
