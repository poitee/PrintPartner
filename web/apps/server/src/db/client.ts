import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as schema from "./schema.js";
import { currentSchemaVersion, schemaMigrations, schemaVersionKey } from "./schema.js";
import { seedStarterProfiles } from "./seed-starter-profiles.js";
import {
  ACCEPTED_PLAN_REVISION_SCHEMA_VERSION,
  backfillAcceptedPlanRevisions,
} from "./accepted-plan-revisions.js";
import {
  backfillCurrentRequiredUnitSets,
  REQUIRED_UNIT_SCHEMA_VERSION,
  type RequiredUnitBackfillCommandResult,
  type RequiredUnitBackfillDependencies,
} from "./required-units.js";
import {
  COMPATIBILITY_DIRTY_REPAIR_SCHEMA_VERSION,
  repairCompatibilityDirtyBuilds,
  type CompatibilityDirtyRepairDependencies,
} from "./compatibility-dirty-repair.js";
import {
  LEGACY_PRINT_PLAN_REMOVAL_SCHEMA_VERSION,
  removeLegacyPrintPlansAndStampSqlite,
} from "./legacy-print-plan-removal.js";
import {
  ACCEPTED_FILAMENT_ASSIGNMENT_SCHEMA_VERSION,
  applyAcceptedFilamentAssignmentSchema,
} from "./accepted-filament-assignment-schema.js";
import {
  ACCEPTED_PLATE_EDIT_SCHEMA_VERSION,
  applyAcceptedPlateEditSchema,
} from "./accepted-plate-edit-schema.js";

export type DrizzleDb = BetterSQLite3Database<typeof schema>;

type SqliteMigrationDependencies = RequiredUnitBackfillDependencies &
  CompatibilityDirtyRepairDependencies & {
    readonly beforeCompatibilityCutover?: () => void;
    readonly afterLegacyPrintPlanRemoval?: (sqlite: Database.Database) => void;
  };

function parseSchemaVersion(value: string | undefined): number {
  if (value == null) return 0;
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid database schema version: ${value}`);
  }
  return Number(value);
}

export class SqliteDatabase {
  private sqlite: Database.Database | null = null;
  readonly dbPath: string;
  readonly dataDir: string;
  readonly reposDir: string;
  readonly sourcesDir: string;

  drizzle: DrizzleDb | null = null;

  constructor(
    dataDir: string,
    private readonly requiredUnitBackfillDependencies: SqliteMigrationDependencies = {},
  ) {
    this.dataDir = dataDir;
    this.dbPath = join(dataDir, "print-partner.db");
    this.reposDir = join(dataDir, "repos");
    this.sourcesDir = join(dataDir, "sources");
  }

  connect(): void {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    mkdirSync(this.reposDir, { recursive: true });
    mkdirSync(this.sourcesDir, { recursive: true });
    mkdirSync(join(this.dataDir, "exports"), { recursive: true });
    mkdirSync(join(this.dataDir, "thumbs"), { recursive: true });
    mkdirSync(join(this.dataDir, "covers"), { recursive: true });

    this.sqlite = new Database(this.dbPath);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.drizzle = drizzle(this.sqlite, { schema });
    this.runMigrations();
    seedStarterProfiles(this.sqlite);
  }

  private runMigrations(): void {
    if (!this.sqlite) throw new Error("Database not connected");
    const hasSettingsTable = this.sqlite
      .prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'",
      )
      .get() as { found: number } | undefined;
    const versionBeforeMigration = hasSettingsTable
      ? parseSchemaVersion(
          (
            this.sqlite
              .prepare("SELECT value FROM app_settings WHERE tenant_id = ? AND key = ?")
              .get("default", schemaVersionKey) as { value?: string } | undefined
          )?.value,
        )
      : 0;
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
    // SQLite validates trigger bodies during RENAME, so add referenced profile columns first.
    const partCols = this.sqlite.pragma("table_info(parts)") as { name: string }[];
    if (!partCols.some((c) => c.name === "spoolman_spool_id")) {
      this.sqlite.exec("ALTER TABLE parts ADD COLUMN spoolman_spool_id TEXT");
    }
    const projectCols = this.sqlite.pragma("table_info(projects)") as { name: string }[];
    if (!projectCols.some((c) => c.name === "tag")) {
      this.sqlite.exec("ALTER TABLE projects ADD COLUMN tag TEXT");
    }
    const profileCols = this.sqlite.pragma("table_info(build_profiles)") as { name: string }[];
    if (!profileCols.some((c) => c.name === "config_modified_at")) {
      this.sqlite.exec("ALTER TABLE build_profiles ADD COLUMN config_modified_at TEXT");
    }
    if (!profileCols.some((c) => c.name === "last_recomputed_at")) {
      this.sqlite.exec("ALTER TABLE build_profiles ADD COLUMN last_recomputed_at TEXT");
    }
    if (!profileCols.some((c) => c.name === "archived_at")) {
      this.sqlite.exec("ALTER TABLE build_profiles ADD COLUMN archived_at TEXT");
    }
    if (!profileCols.some((c) => c.name === "last_used_at")) {
      this.sqlite.exec("ALTER TABLE build_profiles ADD COLUMN last_used_at TEXT");
    }
    if (!profileCols.some((c) => c.name === "special_request")) {
      this.sqlite.exec("ALTER TABLE build_profiles ADD COLUMN special_request TEXT");
    }
    if (!profileCols.some((c) => c.name === "accepted_plan_revision_id")) {
      this.sqlite.exec(
        "ALTER TABLE build_profiles ADD COLUMN accepted_plan_revision_id INTEGER REFERENCES plan_revisions(id) ON DELETE SET NULL",
      );
    }
    if (!profileCols.some((c) => c.name === "accepted_plan_version")) {
      this.sqlite.exec(
        "ALTER TABLE build_profiles ADD COLUMN accepted_plan_version INTEGER NOT NULL DEFAULT 0",
      );
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
    const planInputCols = this.sqlite.pragma("table_info(plan_revision_inputs)") as {
      name: string;
      notnull: number;
    }[];
    if (planInputCols.find((column) => column.name === "source_revision_id")?.notnull === 1) {
      const orphan = this.sqlite
        .prepare(
          `SELECT input.id
             FROM plan_revision_inputs input
             LEFT JOIN source_revisions revision ON revision.id = input.source_revision_id
            WHERE revision.id IS NULL
            LIMIT 1`,
        )
        .get() as { id: number } | undefined;
      if (orphan) {
        throw new Error(
          `Cannot migrate Plan revision input ${orphan.id}: Source revision is missing`,
        );
      }
      this.sqlite.transaction(() => {
        this.sqlite!.exec(`
        ALTER TABLE plan_revision_inputs RENAME TO plan_revision_inputs_v17;
        CREATE TABLE plan_revision_inputs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          input_set_id INTEGER NOT NULL REFERENCES plan_revision_input_sets(id) ON DELETE CASCADE,
          source_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
          source_layer TEXT NOT NULL,
          layer_order INTEGER NOT NULL DEFAULT 0,
          tracking_kind TEXT NOT NULL DEFAULT 'revision'
            CHECK (tracking_kind IN ('revision', 'untracked')),
          source_revision_id INTEGER REFERENCES source_revisions(id) ON DELETE RESTRICT,
          manifest_digest TEXT,
          effective_naming_digest TEXT,
          CHECK (
            (tracking_kind = 'revision' AND source_revision_id IS NOT NULL AND manifest_digest IS NOT NULL)
            OR
            (tracking_kind = 'untracked' AND source_revision_id IS NULL AND manifest_digest IS NULL)
          )
        );
        INSERT INTO plan_revision_inputs (
          id, tenant_id, input_set_id, source_id, source_layer, layer_order,
          tracking_kind, source_revision_id, manifest_digest, effective_naming_digest
        )
        SELECT
          id, tenant_id, input_set_id, source_id, source_layer, layer_order,
          tracking_kind, source_revision_id, manifest_digest, effective_naming_digest
        FROM plan_revision_inputs_v17;
        DROP TABLE plan_revision_inputs_v17;
        CREATE UNIQUE INDEX uq_plan_revision_inputs_v2_set_source
          ON plan_revision_inputs (input_set_id, source_id)
          WHERE effective_naming_digest IS NOT NULL;
        CREATE INDEX idx_plan_revision_inputs_tenant_set
          ON plan_revision_inputs (tenant_id, input_set_id);
        `);
      })();
    }
    if (versionBeforeMigration < ACCEPTED_PLAN_REVISION_SCHEMA_VERSION) {
      backfillAcceptedPlanRevisions(this.sqlite);
    }
    const printProgressCols = this.sqlite.pragma("table_info(print_progress)") as { name: string }[];
    if (!printProgressCols.some((c) => c.name === "assembled")) {
      this.sqlite.exec("ALTER TABLE print_progress ADD COLUMN assembled INTEGER NOT NULL DEFAULT 0");
    }
    if (versionBeforeMigration < REQUIRED_UNIT_SCHEMA_VERSION) {
      backfillCurrentRequiredUnitSets(this.sqlite, this.requiredUnitBackfillDependencies);
    }
    if (versionBeforeMigration < COMPATIBILITY_DIRTY_REPAIR_SCHEMA_VERSION) {
      repairCompatibilityDirtyBuilds(this.sqlite, this.requiredUnitBackfillDependencies);
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
    if (versionBeforeMigration < COMPATIBILITY_DIRTY_REPAIR_SCHEMA_VERSION) {
      this.requiredUnitBackfillDependencies.beforeCompatibilityCutover?.();
      const finalizeCompatibilityCutover = this.sqlite.transaction(() => {
        repairCompatibilityDirtyBuilds(this.sqlite!, this.requiredUnitBackfillDependencies);
        const dirty = this.sqlite!
          .prepare(
            `SELECT profile.id
               FROM build_profiles profile
              WHERE profile.accepted_plan_revision_id IS NULL
                AND (
                  profile.accepted_plan_version <> 0
                  OR EXISTS (
                    SELECT 1 FROM parts part
                     WHERE part.tenant_id = profile.tenant_id
                       AND part.profile_id = profile.id
                  )
                )
              LIMIT 1`,
          )
          .get() as { id: number } | undefined;
        if (dirty) {
          throw new Error(`Build ${dirty.id} remained compatibility-dirty during v26 cutover`);
        }
        this.sqlite!.exec(`
          DROP TRIGGER IF EXISTS trg_profile_layers_invalidate_accepted_revision_insert;
          DROP TRIGGER IF EXISTS trg_profile_layers_invalidate_accepted_revision_update;
          DROP TRIGGER IF EXISTS trg_profile_layers_invalidate_accepted_revision_delete;
        `);
        this.sqlite!
          .prepare(
            `INSERT INTO app_settings (tenant_id, key, value) VALUES (?, ?, ?)
             ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`,
          )
          .run(
            "default",
            schemaVersionKey,
            String(COMPATIBILITY_DIRTY_REPAIR_SCHEMA_VERSION),
          );
      });
      finalizeCompatibilityCutover.immediate();
    }
    if (versionBeforeMigration < LEGACY_PRINT_PLAN_REMOVAL_SCHEMA_VERSION) {
      removeLegacyPrintPlansAndStampSqlite(
        this.sqlite,
        this.requiredUnitBackfillDependencies.afterLegacyPrintPlanRemoval,
      );
    }
    if (versionBeforeMigration < ACCEPTED_FILAMENT_ASSIGNMENT_SCHEMA_VERSION) {
      applyAcceptedFilamentAssignmentSchema(this.sqlite);
    }
    if (versionBeforeMigration < ACCEPTED_PLATE_EDIT_SCHEMA_VERSION) {
      applyAcceptedPlateEditSchema(this.sqlite);
    }
    const row = this.sqlite
      .prepare("SELECT value FROM app_settings WHERE tenant_id = ? AND key = ?")
      .get("default", schemaVersionKey) as { value?: string } | undefined;
    const version = parseSchemaVersion(row?.value);
    if (version < currentSchemaVersion) {
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

  backfillCurrentRequiredUnitSets(
    dependencies: RequiredUnitBackfillDependencies = this.requiredUnitBackfillDependencies,
  ): RequiredUnitBackfillCommandResult {
    if (!this.sqlite) throw new Error("Database not connected");
    return {
      kind: "completed",
      summary: backfillCurrentRequiredUnitSets(this.sqlite, dependencies),
    };
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
