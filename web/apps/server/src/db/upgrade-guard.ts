import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createBackup, validateBackup, type BackupDatabase } from "../services/backup-restore.js";
import { currentSchemaVersion, schemaVersionKey } from "./schema.js";

export type UpgradePreparation =
  | Readonly<{ kind: "fresh-install" }>
  | Readonly<{
      kind: "backup-created" | "backup-reused";
      backupPath: string;
      fromVersion: number;
      toVersion: number;
    }>;

type PrepareSqliteUpgradeOptions = Readonly<{
  dataDir: string;
  appVersion: string;
  targetVersion?: number;
}>;

function readSchemaVersion(sqlite: Database.Database): number {
  const hasSettings = sqlite
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'")
    .get();
  if (!hasSettings) return 0;
  const row = sqlite
    .prepare("SELECT value FROM app_settings WHERE tenant_id = ? AND key = ?")
    .get("default", schemaVersionKey);
  if (typeof row !== "object" || row === null || !("value" in row)) return 0;
  const value = row.value;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`Invalid database schema version: ${String(value)}`);
  }
  return Number(value);
}

function safeVersionToken(version: string): string {
  const token = version.trim().replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  return token || "unknown";
}

export async function prepareSqliteUpgrade(
  options: PrepareSqliteUpgradeOptions,
): Promise<UpgradePreparation> {
  const targetVersion = options.targetVersion ?? currentSchemaVersion;
  const dbPath = join(options.dataDir, "print-partner.db");
  if (!existsSync(dbPath) || statSync(dbPath).size === 0) return { kind: "fresh-install" };

  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = sqlite.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") {
      throw new Error(`Cannot upgrade database: SQLite integrity_check returned ${String(integrity)}`);
    }

    const fromVersion = readSchemaVersion(sqlite);
    if (fromVersion > targetVersion) {
      throw new Error(
        `Cannot start Print Partner schema ${targetVersion} with newer schema version ${fromVersion}. ` +
          "Deploy the same or a newer application version, or restore a compatible backup.",
      );
    }
    const backupsDir = join(options.dataDir, "backups");
    mkdirSync(backupsDir, { recursive: true });
    const backupPath = join(
      backupsDir,
      `print-partner-pre-update-to-${safeVersionToken(options.appVersion)}-schema-${fromVersion}-to-${targetVersion}.tar.gz`,
    );
    const source: BackupDatabase = {
      dbPath,
      ping: () => sqlite.prepare("SELECT 1").get() !== undefined,
      backupToFile: (destinationPath) => sqlite.backup(destinationPath).then(() => undefined),
    };
    if (existsSync(backupPath)) {
      try {
        await validateBackup(backupPath);
        return { kind: "backup-reused", backupPath, fromVersion, toVersion: targetVersion };
      } catch {
        // createBackup publishes with an atomic rename, so the invalid archive
        // remains in place unless a complete replacement succeeds.
      }
    }
    await createBackup(source, options.dataDir, options.appVersion, backupPath, {
      includeDataDirectories: false,
    });
    await validateBackup(backupPath);
    return { kind: "backup-created", backupPath, fromVersion, toVersion: targetVersion };
  } finally {
    sqlite.close();
  }
}
