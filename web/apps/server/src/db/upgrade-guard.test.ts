import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { validateBackup } from "../services/backup-restore.js";
import { SqliteDatabase } from "./client.js";
import { PostgresDatabase } from "./client-postgres.js";
import { currentSchemaVersion } from "./schema.js";
import { assertSupportedSchemaVersion, minimumUpgradeSchemaVersion, prepareSqliteUpgrade } from "./upgrade-guard.js";

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
  it.each([35, 40, 41, 42])("refuses schema %i before opening native part tables", (version) => {
    expect(() => assertSupportedSchemaVersion(version)).toThrow(
      `Database schema version ${version} is newer than supported version ${currentSchemaVersion}`,
    );
    const dataDir = mkdtempSync(join(tmpdir(), "pp-native-schema-guard-"));
    createVersionedDatabase(dataDir, version);
    const path = join(dataDir, "print-partner.db");
    const before = readFileSync(path);
    const database = new SqliteDatabase(dataDir);
    expect(() => database.connect()).toThrow("newer than supported version");
    expect(readFileSync(path)).toEqual(before);
    for (const name of ["repos", "sources", "exports", "thumbs", "covers", "backups"]) {
      expect(existsSync(join(dataDir, name))).toBe(false);
    }
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
  });
  it("creates and validates one durable backup for a schema transition", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-upgrade-guard-"));
    createVersionedDatabase(dataDir, 32);

    const first = await prepareSqliteUpgrade({ dataDir, appVersion: "3.2.0", targetVersion: 33 });
    expect(first.kind).toBe("backup-created");
    if (first.kind !== "backup-created") throw new Error("Expected a new backup");
    expect(existsSync(first.backupPath)).toBe(true);
    await expect(validateBackup(first.backupPath)).resolves.toMatchObject({ appVersion: "3.2.0" });

    const second = await prepareSqliteUpgrade({ dataDir, appVersion: "3.2.0", targetVersion: 33 });
    expect(second).toEqual({ kind: "backup-reused", backupPath: first.backupPath, fromVersion: 32, toVersion: 33 });
  });

  it("skips a fresh install", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-upgrade-guard-fresh-"));
    await expect(
      prepareSqliteUpgrade({ dataDir, appVersion: "3.2.0", targetVersion: 33 }),
    ).resolves.toEqual({ kind: "fresh-install" });
  });

  it("protects data before an application update with no schema change", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-upgrade-guard-app-"));
    createVersionedDatabase(dataDir, 33);

    await expect(
      prepareSqliteUpgrade({ dataDir, appVersion: "3.2.1", targetVersion: 33 }),
    ).resolves.toMatchObject({ kind: "backup-created", fromVersion: 33, toVersion: 33 });
  });

  it("atomically replaces an invalid pre-update archive", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-upgrade-guard-invalid-"));
    createVersionedDatabase(dataDir, 32);
    const backupsDir = join(dataDir, "backups");
    const backupPath = join(
      backupsDir,
      "print-partner-pre-update-to-3.2.0-schema-32-to-33.tar.gz",
    );
    mkdirSync(backupsDir);
    writeFileSync(backupPath, "interrupted archive");

    await expect(
      prepareSqliteUpgrade({ dataDir, appVersion: "3.2.0", targetVersion: 33 }),
    ).resolves.toMatchObject({ kind: "backup-created", backupPath });
    await expect(validateBackup(backupPath)).resolves.toMatchObject({ appVersion: "3.2.0" });
  });

  it("refuses to open a database from a newer schema", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-upgrade-guard-newer-"));
    createVersionedDatabase(dataDir, 34);

    await expect(
      prepareSqliteUpgrade({ dataDir, appVersion: "3.2.0", targetVersion: 33 }),
    ).rejects.toThrow("newer schema version 34");
  });
});

function readSchemaVersionValue(dataDir: string): string | undefined {
  const sqlite = new Database(join(dataDir, "print-partner.db"), { readonly: true });
  try {
    const row = sqlite
      .prepare("SELECT value FROM app_settings WHERE tenant_id = 'default' AND key = 'schema_version'")
      .get() as { value: string } | undefined;
    return row?.value;
  } finally {
    sqlite.close();
  }
}

function schemaObjectNames(dataDir: string): string[] {
  const sqlite = new Database(join(dataDir, "print-partner.db"), { readonly: true });
  try {
    return (
      sqlite.prepare("SELECT type || ':' || name AS name FROM sqlite_master ORDER BY 1").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
  } finally {
    sqlite.close();
  }
}

describe("upgrade floor", () => {
  it("refuses a database older than the v3.3.0 schema and leaves it untouched", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-upgrade-floor-old-"));
    createVersionedDatabase(dataDir, minimumUpgradeSchemaVersion - 1);
    const dbPath = join(dataDir, "print-partner.db");
    const before = readFileSync(dbPath);

    await expect(prepareSqliteUpgrade({ dataDir, appVersion: "3.4.0" })).rejects.toThrow(
      "Install Print Partner v3.3.0, start it once so it migrates the database, then install this release.",
    );
    expect(() => new SqliteDatabase(dataDir).connect()).toThrow(
      `Cannot upgrade database schema version ${minimumUpgradeSchemaVersion - 1}.`,
    );

    expect(readFileSync(dbPath).equals(before)).toBe(true);
    expect(existsSync(join(dataDir, "backups"))).toBe(false);
  });

  it("upgrades a v3.3.0 schema database to the current schema", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "pp-upgrade-floor-fresh-"));
    const fresh = new SqliteDatabase(freshDir);
    fresh.connect();
    fresh.close();

    const dataDir = mkdtempSync(join(tmpdir(), "pp-upgrade-floor-v31-"));
    const v31 = new SqliteDatabase(dataDir);
    v31.connect();
    v31.close();
    const sqlite = new Database(join(dataDir, "print-partner.db"));
    sqlite.exec(`
      DROP TABLE board_comments;
      DROP TABLE board_posts;
      ALTER TABLE projects DROP COLUMN legacy_manifest_cutover;
    `);
    sqlite
      .prepare("UPDATE app_settings SET value = ? WHERE tenant_id = 'default' AND key = 'schema_version'")
      .run(String(minimumUpgradeSchemaVersion));
    sqlite.close();

    await expect(prepareSqliteUpgrade({ dataDir, appVersion: "3.4.0" })).resolves.toMatchObject({
      kind: "backup-created",
      fromVersion: minimumUpgradeSchemaVersion,
      toVersion: currentSchemaVersion,
    });
    const upgraded = new SqliteDatabase(dataDir);
    upgraded.connect();
    upgraded.close();

    expect(readSchemaVersionValue(dataDir)).toBe(String(currentSchemaVersion));
    expect(schemaObjectNames(dataDir)).toEqual(schemaObjectNames(freshDir));
  });

  it("refuses a Postgres database older than the v3.3.0 schema before running DDL", async () => {
    const queries: string[] = [];
    const database = new PostgresDatabase("postgres://unused.invalid/printpartner", tmpdir());
    (database as unknown as { pool: unknown }).pool = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("to_regclass")) return { rows: [{ name: "app_settings" }] };
        if (sql.startsWith("SELECT value FROM app_settings")) {
          return { rows: [{ value: String(minimumUpgradeSchemaVersion - 1) }] };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    };

    await expect(
      (database as unknown as { runMigrations(): Promise<void> }).runMigrations(),
    ).rejects.toThrow("Install Print Partner v3.3.0");
    expect(queries).toHaveLength(2);
  });

  it("initializes an empty data directory at the current schema", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-upgrade-floor-empty-"));

    await expect(prepareSqliteUpgrade({ dataDir, appVersion: "3.4.0" })).resolves.toEqual({
      kind: "fresh-install",
    });
    const database = new SqliteDatabase(dataDir);
    database.connect();
    database.close();

    expect(readSchemaVersionValue(dataDir)).toBe(String(currentSchemaVersion));
  });
});
