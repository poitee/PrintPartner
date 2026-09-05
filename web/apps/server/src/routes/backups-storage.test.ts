import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerBackupRoutes } from "./backups.js";

describe("GET /backups/storage", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories) {
      rmSync(directory, { recursive: true, force: true });
    }
    directories.length = 0;
  });

  it("returns the recursive storage breakdown and backup input size", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-backup-storage-route-"));
    directories.push(dataDir);
    mkdirSync(join(dataDir, "repos", "source", "revisions", "one"), {
      recursive: true,
    });
    writeFileSync(
      join(dataDir, "repos", "source", "revisions", "one", "part.stl"),
      "source-revision",
    );
    const app = Fastify();
    await app.register(multipart);
    await registerBackupRoutes(app, {
      dataDir,
      sqlite: null,
      appVersion: "3.1.0",
    });

    try {
      const response = await app.inject({ method: "GET", url: "/backups/storage" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        categories: expect.arrayContaining([
          {
            key: "repos",
            label: "Source revisions",
            bytes: 15,
            files: 1,
          },
        ]),
        totalBytes: 15,
        backupContentBytes: expect.any(Number),
        freeBytes: expect.any(Number),
      });
    } finally {
      await app.close();
    }
  });
});
