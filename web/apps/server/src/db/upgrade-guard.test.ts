import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { validateBackup } from "../services/backup-restore.js";
import { prepareSqliteUpgrade } from "./upgrade-guard.js";

function createVersionedDatabase(dataDir: string, schemaVersion: number): void {
  const sqlite = new Database(join(dataDir, "print-partner.db"));
  sqlite.exec(`
    CREATE TABLE app_settings (
      tenant_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (tenant_id, key)
    );
    CREATE TABLE protected_user_data (value TEXT NOT NULL);
    INSERT INTO protected_user_data (value) VALUES ('keep me');
  `);
  sqlite
    .prepare("INSERT INTO app_settings (tenant_id, key, value) VALUES (?, ?, ?)")
    .run("default", "schema_version", String(schemaVersion));
  sqlite.close();
}

describe("SQLite upgrade guard", () => {
  it("creates and validates one durable backup for a schema transition", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-upgrade-guard-"));
    createVersionedDatabase(dataDir, 29);

    const first = await prepareSqliteUpgrade({ dataDir, appVersion: "3.2.0", targetVersion: 30 });
    expect(first.kind).toBe("backup-created");
    if (first.kind !== "backup-created") throw new Error("Expected a new backup");
    expect(existsSync(first.backupPath)).toBe(true);
    await expect(validateBackup(first.backupPath)).resolves.toMatchObject({ appVersion: "3.2.0" });

    const second = await prepareSqliteUpgrade({ dataDir, appVersion: "3.2.0", targetVersion: 30 });
    expect(second).toEqual({ kind: "backup-reused", backupPath: first.backupPath, fromVersion: 29, toVersion: 30 });
  });

  it("skips a fresh install", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-upgrade-guard-fresh-"));
    await expect(
      prepareSqliteUpgrade({ dataDir, appVersion: "3.2.0", targetVersion: 30 }),
    ).resolves.toEqual({ kind: "fresh-install" });
  });

  it("protects data before an application update with no schema change", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-upgrade-guard-app-"));
    createVersionedDatabase(dataDir, 30);

    await expect(
      prepareSqliteUpgrade({ dataDir, appVersion: "3.2.1", targetVersion: 30 }),
    ).resolves.toMatchObject({ kind: "backup-created", fromVersion: 30, toVersion: 30 });
  });

  it("atomically replaces an invalid pre-update archive", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-upgrade-guard-invalid-"));
    createVersionedDatabase(dataDir, 29);
    const backupsDir = join(dataDir, "backups");
    const backupPath = join(
      backupsDir,
      "print-partner-pre-update-to-3.2.0-schema-29-to-30.tar.gz",
    );
    mkdirSync(backupsDir);
    writeFileSync(backupPath, "interrupted archive");

    await expect(
      prepareSqliteUpgrade({ dataDir, appVersion: "3.2.0", targetVersion: 30 }),
    ).resolves.toMatchObject({ kind: "backup-created", backupPath });
    await expect(validateBackup(backupPath)).resolves.toMatchObject({ appVersion: "3.2.0" });
  });

  it("refuses to open a database from a newer schema", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-upgrade-guard-newer-"));
    createVersionedDatabase(dataDir, 31);

    await expect(
      prepareSqliteUpgrade({ dataDir, appVersion: "3.2.0", targetVersion: 30 }),
    ).rejects.toThrow("newer schema version 31");
  });
});
