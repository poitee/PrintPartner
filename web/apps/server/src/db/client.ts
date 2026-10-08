import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as schema from "./schema.js";
import { currentSchemaVersion, schemaVersionKey } from "./schema.js";
import { schemaMigrations } from "./migrations-sqlite.js";
import { seedStarterProfiles } from "./seed-starter-profiles.js";
import { repairSourceRevisionTenantOwnershipSqlite } from "./source-revision-tenant-repair.js";
import { assertSupportedSchemaVersion, readSchemaVersion } from "./upgrade-guard.js";

export type DrizzleDb = BetterSQLite3Database<typeof schema>;

export class SqliteDatabase {
  private sqlite: Database.Database | null = null;
  readonly dbPath: string;
  readonly dataDir: string;
  readonly reposDir: string;
  readonly sourcesDir: string;

  drizzle: DrizzleDb | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.dbPath = join(dataDir, "print-partner.db");
    this.reposDir = join(dataDir, "repos");
    this.sourcesDir = join(dataDir, "sources");
  }

  connect(): void {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    const sqlite = new Database(this.dbPath);
    try {
      assertSupportedSchemaVersion(readSchemaVersion(sqlite));
    } catch (error) {
      sqlite.close();
      throw error;
    }
    mkdirSync(this.reposDir, { recursive: true });
    mkdirSync(this.sourcesDir, { recursive: true });
    mkdirSync(join(this.dataDir, "exports"), { recursive: true });
    mkdirSync(join(this.dataDir, "thumbs"), { recursive: true });
    mkdirSync(join(this.dataDir, "covers"), { recursive: true });

    this.sqlite = sqlite;
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.drizzle = drizzle(this.sqlite, { schema });
    this.runMigrations();
    seedStarterProfiles(this.sqlite);
  }

  private runMigrations(): void {
    if (!this.sqlite) throw new Error("Database not connected");
    const versionBeforeMigration = readSchemaVersion(this.sqlite);
    if (versionBeforeMigration > currentSchemaVersion) {
      throw new Error(
        `Database schema version ${versionBeforeMigration} is newer than supported version ${currentSchemaVersion}`,
      );
    }
    for (const stmt of schemaMigrations) {
      try {
        this.sqlite.exec(stmt);
      } catch (e) {
        // Several migrations are unconditional "ALTER TABLE ... ADD COLUMN"
        // statements (unlike the CREATE TABLE/INDEX IF NOT EXISTS ones) and
        // are not safe to re-run once already applied. SQLite has no
        // "ADD COLUMN IF NOT EXISTS", so tolerate re-application here rather
        // than crash the whole server on every restart after the first.
        const msg = e instanceof Error ? e.message : String(e);
        if (!/duplicate column name/i.test(msg)) throw e;
      }
    }
    repairSourceRevisionTenantOwnershipSqlite(this.sqlite);
    const partCols = this.sqlite.pragma("table_info(parts)") as { name: string }[];
    if (!partCols.some((c) => c.name === "spoolman_spool_id")) {
      this.sqlite.exec("ALTER TABLE parts ADD COLUMN spoolman_spool_id TEXT");
    }
    this.sqlite.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_build_profiles_revision_ownership_insert
      BEFORE INSERT ON build_profiles
      WHEN NEW.accepted_plan_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM plan_revisions revision
         WHERE revision.id = NEW.accepted_plan_revision_id
           AND revision.profile_id = NEW.id
           AND revision.tenant_id = NEW.tenant_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Accepted Plan revision ownership violation');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_build_profiles_revision_ownership_update
      BEFORE UPDATE OF id, tenant_id, accepted_plan_revision_id ON build_profiles
      WHEN NEW.accepted_plan_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM plan_revisions revision
         WHERE revision.id = NEW.accepted_plan_revision_id
           AND revision.profile_id = NEW.id
           AND revision.tenant_id = NEW.tenant_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Accepted Plan revision ownership violation');
      END;
    `);
    const printProgressCols = this.sqlite.pragma("table_info(print_progress)") as { name: string }[];
    if (!printProgressCols.some((c) => c.name === "assembled")) {
      this.sqlite.exec("ALTER TABLE print_progress ADD COLUMN assembled INTEGER NOT NULL DEFAULT 0");
    }

    // Performance indexes (idempotent — IF NOT EXISTS)
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_layers_tenant_profile
        ON profile_layers(tenant_id, profile_id);
      CREATE INDEX IF NOT EXISTS idx_parts_tenant_profile
        ON parts(tenant_id, profile_id);
      CREATE INDEX IF NOT EXISTS idx_parts_tenant_status
        ON parts(tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_print_progress_completed
        ON print_progress(part_id, completed);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at
        ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id
        ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_projects_last_synced
        ON projects(tenant_id, last_synced_at);
      CREATE INDEX IF NOT EXISTS idx_buildprofiles_last_used
        ON build_profiles(tenant_id, last_used_at);
    `);
    if (versionBeforeMigration < currentSchemaVersion) {
      this.sqlite
        .prepare(
          `INSERT INTO app_settings (tenant_id, key, value) VALUES (?, ?, ?)
           ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`,
        )
        .run("default", schemaVersionKey, String(currentSchemaVersion));
    }
  }

  ping(): boolean {
    if (!this.sqlite) return false;
    this.sqlite.prepare("SELECT 1").get();
    return true;
  }

  close(): void {
    this.sqlite?.close();
    this.sqlite = null;
    this.drizzle = null;
  }

  /** Create a transactionally consistent snapshot, including committed WAL data. */
  async backupToFile(destinationPath: string): Promise<void> {
    if (!this.sqlite) throw new Error("Database not connected");
    await this.sqlite.backup(destinationPath);
  }
}

export function getDb(db: SqliteDatabase): DrizzleDb {
  if (!db.drizzle) throw new Error("Database not connected");
  return db.drizzle;
}
