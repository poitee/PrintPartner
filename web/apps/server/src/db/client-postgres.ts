import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as schema from "./schema-pg.js";
import type {
  RequiredUnitBackfillCommandResult,
  RequiredUnitBackfillDependencies,
} from "./required-units.js";
import { removeLegacyPrintPlansAndStampPostgres } from "./legacy-print-plan-removal.js";
import {
  POSTGRES_SYNC_MAX_RESULT_BYTES,
  POSTGRES_SYNC_MAX_RESULT_ROWS,
  registerPostgresSyncQuery,
  unregisterPostgresSyncQuery,
  type PostgresSyncQuery,
  type PostgresSyncResult,
} from "./sync-db-bridge.js";
import {
  repairSourceRevisionTenantOwnershipPostgres,
} from "./source-revision-tenant-repair.js";

export type PostgresDrizzleDb = NodePgDatabase<typeof schema>;

const require = createRequire(import.meta.url);
const PG_MODULE_PATH = require.resolve("pg");
const SYNC_QUERY_SCRIPT = `
const { Client } = require(process.argv[1]);
const MAX_RESULT_ROWS = ${POSTGRES_SYNC_MAX_RESULT_ROWS};
const MAX_RESULT_BYTES = ${POSTGRES_SYNC_MAX_RESULT_BYTES};
let client;
(async () => {
  try {
    const input = JSON.parse(await new Promise((resolve, reject) => {
      let body = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { body += chunk; });
      process.stdin.on("end", () => resolve(body));
      process.stdin.on("error", reject);
    }));
    client = new Client({ connectionString: input.databaseUrl });
    await client.connect();
    const result = await client.query(
      input.arrayMode ? { text: input.sql, rowMode: "array" } : input.sql,
      input.params,
    );
    if (result.rows.length > MAX_RESULT_ROWS) {
      throw new Error(
        \`result row limit of \${MAX_RESULT_ROWS.toLocaleString("en-US")} exceeded (received \${result.rows.length.toLocaleString("en-US")})\`,
      );
    }
    const payload = JSON.stringify({
      ok: true,
      rows: result.rows,
      rowCount: result.rowCount ?? 0,
    });
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (payloadBytes > MAX_RESULT_BYTES) {
      throw new Error(
        \`result byte limit of 8 MiB exceeded (received \${payloadBytes.toLocaleString("en-US")} bytes)\`,
      );
    }
    process.stdout.write(payload);
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  } finally {
    if (client) await client.end().catch(() => {});
  }
})();
`;

function runPostgresSyncQuery(
  databaseUrl: string,
  query: PostgresSyncQuery,
): PostgresSyncResult {
  const result = spawnSync(process.execPath, ["-e", SYNC_QUERY_SCRIPT, PG_MODULE_PATH], {
    cwd: process.cwd(),
    input: JSON.stringify({ databaseUrl, ...query }),
    encoding: "utf8",
    // The worker checks the 8 MiB payload before writing. Headroom carries the
    // protocol envelope and a useful error if a future worker violates that contract.
    maxBuffer: POSTGRES_SYNC_MAX_RESULT_BYTES + 64 * 1024,
    timeout: 30_000,
  });
  let payload: {
    ok?: boolean;
    rows?: unknown[];
    rowCount?: number;
    error?: string;
  } = {};
  try {
    payload = JSON.parse(result.stdout || "{}") as typeof payload;
  } catch {
    // The detailed process error below is more useful than a secondary JSON error.
  }
  if (result.status !== 0 || !payload.ok) {
    const spawnErrorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const detail =
      payload.error ||
      (spawnErrorCode === "ENOBUFS"
        ? "query worker output exceeded the configured 8 MiB result ceiling"
        : undefined) ||
      result.error?.message ||
      result.stderr.trim() ||
      `query worker exited with status ${String(result.status)}`;
    throw new Error(`Postgres synchronous query failed: ${detail}`);
  }
  return {
    rows: payload.rows ?? [],
    rowCount: payload.rowCount ?? 0,
  };
}

const MIGRATION_SQL = join(
  dirname(fileURLToPath(import.meta.url)),
  "../data/postgres/0000_init.sql",
);

/**
 * DDL applied after data/postgres/0000_init.sql, in order.
 *
 * Everything here must be idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
 * because it is re-run on every process start. Postgres, unlike SQLite, does
 * support ADD COLUMN IF NOT EXISTS, so no error swallowing is needed.
 *
 * Exported so schema-parity tests can assert that every table/column declared
 * in schema-pg.ts is actually created here — the Postgres deploy previously
 * stamped schema_version ahead of DDL while never creating the v9+ tables
 * (print_jobs, printer_telemetry, app_events, the slicer profile tables), so
 * saas installs reported a high schema version against a v8 database.
 */
export const postgresPostInitMigrations: string[] = [
  "ALTER TABLE parts ADD COLUMN IF NOT EXISTS spoolman_spool_id TEXT",
  "ALTER TABLE projects ADD COLUMN IF NOT EXISTS tag TEXT",
  "ALTER TABLE projects ADD COLUMN IF NOT EXISTS legacy_manifest_cutover BOOLEAN NOT NULL DEFAULT FALSE",
  "ALTER TABLE build_profiles ADD COLUMN IF NOT EXISTS config_modified_at TEXT",
  "ALTER TABLE build_profiles ADD COLUMN IF NOT EXISTS last_recomputed_at TEXT",
  "ALTER TABLE build_profiles ADD COLUMN IF NOT EXISTS archived_at TEXT",
  "ALTER TABLE build_profiles ADD COLUMN IF NOT EXISTS last_used_at TEXT",
  "ALTER TABLE build_profiles ADD COLUMN IF NOT EXISTS special_request TEXT",
  // Assembly tracking: printed-but-not-yet-installed state per print_progress unit.
  // Mirrors the guarded ADD COLUMN in client.ts (SQLite) — defaults every existing
  // and new row to false/not-assembled.
  "ALTER TABLE print_progress ADD COLUMN IF NOT EXISTS assembled BOOLEAN NOT NULL DEFAULT FALSE",
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS auth_identities (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_identity_provider
    ON auth_identities (provider, provider_user_id)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS plan_shares (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    from_user_id TEXT NOT NULL REFERENCES users(id),
    plan_id INTEGER NOT NULL,
    plan_name TEXT NOT NULL,
    recipient_email TEXT,
    bundle_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS source_docs (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT,
    extract_status TEXT NOT NULL DEFAULT 'pending',
    extract_error TEXT,
    page_count INTEGER,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_source_docs_project_path
    ON source_docs (project_id, path)`,
  `CREATE TABLE IF NOT EXISTS source_notes (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    profile_id INTEGER REFERENCES build_profiles(id) ON DELETE SET NULL,
    title TEXT NOT NULL DEFAULT '',
    body_markdown TEXT NOT NULL DEFAULT '',
    author_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS plan_decisions (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'assistant',
    kind TEXT NOT NULL,
    action_type TEXT,
    params_json TEXT NOT NULL DEFAULT '{}',
    label TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    rationale TEXT,
    result_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plan_decisions_profile
    ON plan_decisions (profile_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS plan_snapshots (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'user',
    payload_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plan_snapshots_profile
    ON plan_snapshots (profile_id, created_at)`,
  // v9 — slicer profile tables. Mirrors the v9 block of schemaMigrations in schema.ts.
  `CREATE TABLE IF NOT EXISTS printer_profiles (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    name TEXT NOT NULL,
    slicer_format TEXT NOT NULL,
    slicer_version_at_import TEXT,
    printable_area TEXT,
    printable_height_mm TEXT,
    bed_exclude_area TEXT,
    nozzle_diameter_mm TEXT,
    extruder_count INTEGER NOT NULL DEFAULT 1,
    raw_json TEXT,
    raw_ini TEXT,
    resolved_flat_config TEXT,
    imported_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_printer_profiles_tenant_name
    ON printer_profiles (tenant_id, name)`,
  `CREATE TABLE IF NOT EXISTS process_profiles (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    name TEXT NOT NULL,
    slicer_format TEXT NOT NULL,
    compatible_printers TEXT,
    resolved_flat_config TEXT,
    imported_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_process_profiles_tenant_name
    ON process_profiles (tenant_id, name)`,
  `CREATE TABLE IF NOT EXISTS filament_profiles (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    name TEXT NOT NULL,
    material_type TEXT NOT NULL,
    material_tier INTEGER NOT NULL DEFAULT 1,
    nozzle_temp_c INTEGER,
    bed_temp_c INTEGER,
    fan_pct INTEGER,
    extrusion_multiplier TEXT,
    pressure_advance TEXT,
    retraction TEXT,
    raw_json TEXT,
    raw_ini TEXT,
    resolved_flat_config TEXT,
    imported_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_filament_profiles_tenant_name
    ON filament_profiles (tenant_id, name)`,
  `CREATE TABLE IF NOT EXISTS printer_name_map (
    id SERIAL PRIMARY KEY,
    slicer_name TEXT NOT NULL,
    pp_fleet_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_printer_name_map_slicer_name
    ON printer_name_map (slicer_name)`,
  // v11 — print_jobs, print_job_parts, printer_telemetry, app_events.
  // (v10 is the print_progress.assembled column, applied above.)
  // CREATE matches the historical v11 shape; the ALTER statements below add
  // v12 columns for saas databases that already have a v11-shaped print_jobs table.
  `CREATE TABLE IF NOT EXISTS print_jobs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    host_integration_id TEXT,
    filename TEXT,
    at TEXT NOT NULL,
    link_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_print_jobs_tenant_profile
    ON print_jobs (tenant_id, profile_id, at)`,
  `CREATE TABLE IF NOT EXISTS print_job_parts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    job_id TEXT REFERENCES print_jobs(id) ON DELETE SET NULL,
    at TEXT NOT NULL,
    profile_id INTEGER NOT NULL,
    part_id INTEGER NOT NULL,
    unit_index INTEGER NOT NULL DEFAULT 0,
    result TEXT NOT NULL,
    reason TEXT,
    note TEXT,
    host_integration_id TEXT,
    filename TEXT,
    match_key TEXT,
    role TEXT,
    filament_display TEXT,
    link_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_print_job_parts_profile
    ON print_job_parts (profile_id, at)`,
  `CREATE TABLE IF NOT EXISTS printer_telemetry (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    at TEXT NOT NULL,
    printer_id TEXT,
    host_integration_id TEXT,
    event_type TEXT NOT NULL,
    payload_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_printer_telemetry_at
    ON printer_telemetry (tenant_id, at)`,
  `CREATE TABLE IF NOT EXISTS app_events (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    actor_type TEXT,
    actor_id TEXT,
    payload_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_app_events_kind_at
    ON app_events (tenant_id, kind, at)`,
  // v12 — printer_id / material / status / filament_consumed_g / completed_at on print_jobs.
  // These are the columns get_farm_status and get_print_stats read; a saas
  // database created before v12 has a print_jobs table without them.
  "ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printer_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS material TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'sent'",
  "ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS filament_consumed_g INTEGER",
  "ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS completed_at TEXT",
  `CREATE INDEX IF NOT EXISTS idx_print_jobs_tenant_status
    ON print_jobs (tenant_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_print_jobs_printer
    ON print_jobs (tenant_id, printer_id)`,
  // v13 — profile-sync provenance columns on the three slicer profile tables.
  // Mirrors schemaMigrations v13 in schema.ts (SQLite).
  "ALTER TABLE printer_profiles ADD COLUMN IF NOT EXISTS source_path TEXT",
  "ALTER TABLE printer_profiles ADD COLUMN IF NOT EXISTS synced_from_slicer_version TEXT",
  "ALTER TABLE printer_profiles ADD COLUMN IF NOT EXISTS last_synced_at TEXT",
  "ALTER TABLE process_profiles ADD COLUMN IF NOT EXISTS source_path TEXT",
  "ALTER TABLE process_profiles ADD COLUMN IF NOT EXISTS synced_from_slicer_version TEXT",
  "ALTER TABLE process_profiles ADD COLUMN IF NOT EXISTS last_synced_at TEXT",
  "ALTER TABLE filament_profiles ADD COLUMN IF NOT EXISTS source_path TEXT",
  "ALTER TABLE filament_profiles ADD COLUMN IF NOT EXISTS synced_from_slicer_version TEXT",
  "ALTER TABLE filament_profiles ADD COLUMN IF NOT EXISTS last_synced_at TEXT",
  `CREATE INDEX IF NOT EXISTS idx_printer_profiles_source_path
    ON printer_profiles (source_path)`,
  `CREATE INDEX IF NOT EXISTS idx_process_profiles_source_path
    ON process_profiles (source_path)`,
  `CREATE INDEX IF NOT EXISTS idx_filament_profiles_source_path
    ON filament_profiles (source_path)`,
  // v14 — per-printer machine profile and per-slot filament assignments.
  `CREATE TABLE IF NOT EXISTS printer_profile_assignments (
    printer_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    machine_profile_id INTEGER,
    profile_source TEXT NOT NULL DEFAULT 'auto_match',
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS printer_filament_slot_assignments (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    printer_id TEXT NOT NULL,
    slot_index INTEGER NOT NULL,
    filament_profile_id INTEGER
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_printer_filament_slot
    ON printer_filament_slot_assignments (tenant_id, printer_id, slot_index)`,
  // v15 — registered slicer GUI / sync targets (Slicer Hub). Docker columns reserved for Plan 3.
  `CREATE TABLE IF NOT EXISTS slicer_instances (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    dialect TEXT NOT NULL,
    gui_url TEXT NOT NULL DEFAULT '',
    watch_path TEXT NOT NULL DEFAULT '',
    docker_target TEXT NOT NULL DEFAULT 'local',
    docker_host TEXT,
    compose_service TEXT,
    image TEXT,
    container_name TEXT,
    ports_json TEXT NOT NULL DEFAULT '[]',
    volumes_json TEXT NOT NULL DEFAULT '[]',
    env_json TEXT NOT NULL DEFAULT '{}',
    status_cache TEXT NOT NULL DEFAULT 'unknown',
    status_message TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  // v16 — immutable Source revision identities and atomically published Plan inputs.
  `CREATE TABLE IF NOT EXISTS source_revisions (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    upstream_revision_key TEXT NOT NULL,
    manifest_digest TEXT NOT NULL,
    snapshot_locator TEXT NOT NULL,
    synced_at TEXT NOT NULL,
    completeness TEXT NOT NULL DEFAULT 'complete' CHECK (completeness = 'complete')
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_source_revisions_tenant_source_upstream
    ON source_revisions (tenant_id, project_id, upstream_revision_key)`,
  `CREATE INDEX IF NOT EXISTS idx_source_revisions_tenant_source_synced
    ON source_revisions (tenant_id, project_id, synced_at)`,
  // v17 — active Source pointer to one registered immutable revision.
  `ALTER TABLE projects ADD COLUMN IF NOT EXISTS current_source_revision_id INTEGER
    REFERENCES source_revisions(id) ON DELETE RESTRICT`,
  `CREATE TABLE IF NOT EXISTS plan_revision_input_sets (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    input_set_digest TEXT NOT NULL,
    expected_input_count INTEGER NOT NULL,
    recorded_at TEXT NOT NULL,
    published_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_revision_input_sets_tenant_plan_digest
    ON plan_revision_input_sets (tenant_id, profile_id, input_set_digest)`,
  `CREATE INDEX IF NOT EXISTS idx_plan_revision_input_sets_tenant_plan_published
    ON plan_revision_input_sets (tenant_id, profile_id, published_at)`,
  `CREATE TABLE IF NOT EXISTS plan_revision_inputs (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    input_set_id INTEGER NOT NULL REFERENCES plan_revision_input_sets(id) ON DELETE CASCADE,
    source_revision_id INTEGER NOT NULL REFERENCES source_revisions(id) ON DELETE RESTRICT,
    manifest_digest TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plan_revision_inputs_tenant_set
    ON plan_revision_inputs (tenant_id, input_set_id)`,
  // v18 — explicit accepted Plan input identity and effective naming inputs.
  `ALTER TABLE plan_revision_input_sets ADD COLUMN IF NOT EXISTS format_version INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE plan_revision_inputs ADD COLUMN IF NOT EXISTS source_id INTEGER REFERENCES projects(id) ON DELETE RESTRICT`,
  `ALTER TABLE plan_revision_inputs ADD COLUMN IF NOT EXISTS source_layer TEXT`,
  `ALTER TABLE plan_revision_inputs ADD COLUMN IF NOT EXISTS layer_order INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE plan_revision_inputs ADD COLUMN IF NOT EXISTS tracking_kind TEXT NOT NULL DEFAULT 'revision'`,
  `ALTER TABLE plan_revision_inputs ADD COLUMN IF NOT EXISTS effective_naming_digest TEXT`,
  `ALTER TABLE plan_revision_inputs ALTER COLUMN source_revision_id DROP NOT NULL`,
  `ALTER TABLE plan_revision_inputs ALTER COLUMN manifest_digest DROP NOT NULL`,
  `UPDATE plan_revision_inputs
     SET source_id = source_revisions.project_id,
         source_layer = 'legacy:' || source_revisions.project_id
    FROM source_revisions
   WHERE plan_revision_inputs.source_revision_id = source_revisions.id
     AND (plan_revision_inputs.source_id IS NULL OR plan_revision_inputs.source_layer IS NULL)`,
  `ALTER TABLE plan_revision_inputs ALTER COLUMN source_id SET NOT NULL`,
  `ALTER TABLE plan_revision_inputs ALTER COLUMN source_layer SET NOT NULL`,
  `ALTER TABLE plan_revision_inputs DROP CONSTRAINT IF EXISTS chk_plan_revision_inputs_tracking_kind`,
  `ALTER TABLE plan_revision_inputs ADD CONSTRAINT chk_plan_revision_inputs_tracking_kind
    CHECK (tracking_kind IN ('revision', 'untracked'))`,
  `ALTER TABLE plan_revision_inputs DROP CONSTRAINT IF EXISTS chk_plan_revision_inputs_revision_identity`,
  `ALTER TABLE plan_revision_inputs ADD CONSTRAINT chk_plan_revision_inputs_revision_identity
    CHECK (
      (tracking_kind = 'revision' AND source_revision_id IS NOT NULL AND manifest_digest IS NOT NULL)
      OR
      (tracking_kind = 'untracked' AND source_revision_id IS NULL AND manifest_digest IS NULL)
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_revision_inputs_v2_set_source
    ON plan_revision_inputs (input_set_id, source_id)
    WHERE effective_naming_digest IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS plan_accepted_input_sets (
    tenant_id TEXT NOT NULL DEFAULT 'default',
    profile_id INTEGER PRIMARY KEY REFERENCES build_profiles(id) ON DELETE CASCADE,
    input_set_id INTEGER NOT NULL REFERENCES plan_revision_input_sets(id) ON DELETE RESTRICT,
    accepted_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS plan_revisions (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    revision_number INTEGER NOT NULL,
    parent_revision_id INTEGER REFERENCES plan_revisions(id) ON DELETE RESTRICT,
    input_set_id INTEGER REFERENCES plan_revision_input_sets(id) ON DELETE RESTRICT,
    provenance_kind TEXT NOT NULL,
    digest_format TEXT NOT NULL,
    snapshot_digest TEXT NOT NULL,
    created_by TEXT NOT NULL,
    accepted_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    CONSTRAINT chk_plan_revisions_provenance CHECK (
      (provenance_kind = 'tracked' AND input_set_id IS NOT NULL)
      OR (provenance_kind = 'legacy' AND input_set_id IS NULL)
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_revisions_tenant_plan_number
    ON plan_revisions (tenant_id, profile_id, revision_number)`,
  `CREATE INDEX IF NOT EXISTS idx_plan_revisions_tenant_plan
    ON plan_revisions (tenant_id, profile_id, accepted_at)`,
  `CREATE TABLE IF NOT EXISTS plan_revision_parts (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    revision_id INTEGER NOT NULL REFERENCES plan_revisions(id) ON DELETE CASCADE,
    projection_part_id INTEGER,
    part_key TEXT NOT NULL,
    relative_path TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL DEFAULT '',
    source_layer TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'base',
    role_inferred TEXT NOT NULL DEFAULT 'primary',
    role_override TEXT,
    filament_color_id TEXT,
    filament_custom_hex TEXT,
    spoolman_spool_id TEXT,
    quantity_inferred INTEGER NOT NULL DEFAULT 1,
    quantity_override INTEGER,
    quantity_effective INTEGER NOT NULL DEFAULT 1,
    included BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT NOT NULL DEFAULT '',
    github_blob_url TEXT,
    geometry_same BOOLEAN,
    requirement TEXT,
    option_group_id TEXT,
    manifest_source TEXT,
    artifact_digest TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plan_revision_parts_tenant_revision
    ON plan_revision_parts (tenant_id, revision_id)`,
  `ALTER TABLE build_profiles ADD COLUMN IF NOT EXISTS accepted_plan_revision_id INTEGER
    REFERENCES plan_revisions(id) ON DELETE SET NULL`,
  `ALTER TABLE build_profiles ADD COLUMN IF NOT EXISTS accepted_plan_version INTEGER NOT NULL DEFAULT 0`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_build_profiles_tenant_id
    ON build_profiles (tenant_id, id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_revision_input_sets_owner_id
    ON plan_revision_input_sets (tenant_id, profile_id, id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_revisions_owner_id
    ON plan_revisions (tenant_id, profile_id, id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_revisions_tenant_id
    ON plan_revisions (tenant_id, id)`,
  `DO $block$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_plan_revisions_profile_owner') THEN
        ALTER TABLE plan_revisions ADD CONSTRAINT fk_plan_revisions_profile_owner
          FOREIGN KEY (tenant_id, profile_id)
          REFERENCES build_profiles (tenant_id, id) ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_plan_revisions_parent_owner') THEN
        ALTER TABLE plan_revisions ADD CONSTRAINT fk_plan_revisions_parent_owner
          FOREIGN KEY (tenant_id, profile_id, parent_revision_id)
          REFERENCES plan_revisions (tenant_id, profile_id, id) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_plan_revisions_input_owner') THEN
        ALTER TABLE plan_revisions ADD CONSTRAINT fk_plan_revisions_input_owner
          FOREIGN KEY (tenant_id, profile_id, input_set_id)
          REFERENCES plan_revision_input_sets (tenant_id, profile_id, id) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_plan_revision_parts_revision_owner') THEN
        ALTER TABLE plan_revision_parts ADD CONSTRAINT fk_plan_revision_parts_revision_owner
          FOREIGN KEY (tenant_id, revision_id)
          REFERENCES plan_revisions (tenant_id, id) ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_build_profiles_revision_owner') THEN
        ALTER TABLE build_profiles ADD CONSTRAINT fk_build_profiles_revision_owner
          FOREIGN KEY (tenant_id, id, accepted_plan_revision_id)
          REFERENCES plan_revisions (tenant_id, profile_id, id) ON DELETE NO ACTION
          DEFERRABLE INITIALLY DEFERRED;
      END IF;
    END
  $block$`,
  `CREATE OR REPLACE FUNCTION protect_plan_revisions_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF TG_OP = 'UPDATE' OR EXISTS (
        SELECT 1 FROM build_profiles profile
         WHERE profile.id = OLD.profile_id AND profile.tenant_id = OLD.tenant_id
      ) THEN
        RAISE EXCEPTION 'Accepted Plan revisions are immutable' USING ERRCODE = '55000';
      END IF;
      RETURN OLD;
    END
  $function$`,
  `CREATE OR REPLACE FUNCTION protect_plan_revision_parts_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF TG_OP = 'UPDATE' OR EXISTS (
        SELECT 1
          FROM plan_revisions revision
          JOIN build_profiles profile
            ON profile.id = revision.profile_id
           AND profile.tenant_id = revision.tenant_id
         WHERE revision.id = OLD.revision_id
           AND revision.tenant_id = OLD.tenant_id
      ) THEN
        RAISE EXCEPTION 'Accepted Plan revision Parts are immutable' USING ERRCODE = '55000';
      END IF;
      RETURN OLD;
    END
  $function$`,
  `CREATE OR REPLACE FUNCTION enforce_plan_revision_part_projection_owner()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.projection_part_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
          FROM parts part
          JOIN plan_revisions revision ON revision.id = NEW.revision_id
         WHERE part.id = NEW.projection_part_id
           AND part.tenant_id = NEW.tenant_id
           AND part.profile_id = revision.profile_id
           AND revision.tenant_id = NEW.tenant_id
      ) THEN
        RAISE EXCEPTION 'Plan revision Part projection ownership violation'
          USING ERRCODE = '23503';
      END IF;
      RETURN NEW;
    END
  $function$`,
  `CREATE OR REPLACE FUNCTION invalidate_accepted_plan_revision()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        UPDATE build_profiles
           SET accepted_plan_revision_id = NULL
         WHERE id = OLD.profile_id AND tenant_id = OLD.tenant_id;
        RETURN OLD;
      END IF;
      IF TG_OP = 'UPDATE' THEN
        IF OLD.id IS NOT DISTINCT FROM NEW.id
           AND OLD.tenant_id IS NOT DISTINCT FROM NEW.tenant_id
           AND OLD.profile_id IS NOT DISTINCT FROM NEW.profile_id
           AND OLD.match_key IS NOT DISTINCT FROM NEW.match_key
           AND OLD.relative_path IS NOT DISTINCT FROM NEW.relative_path
           AND OLD.filename IS NOT DISTINCT FROM NEW.filename
           AND OLD.source_layer IS NOT DISTINCT FROM NEW.source_layer
           AND OLD.status IS NOT DISTINCT FROM NEW.status
           AND OLD.role IS NOT DISTINCT FROM NEW.role
           AND OLD.quantity_auto IS NOT DISTINCT FROM NEW.quantity_auto
           AND OLD.quantity_override IS NOT DISTINCT FROM NEW.quantity_override
           AND OLD.quantity_effective IS NOT DISTINCT FROM NEW.quantity_effective
           AND OLD.included IS NOT DISTINCT FROM NEW.included
           AND OLD.notes IS NOT DISTINCT FROM NEW.notes
           AND OLD.github_blob_url IS NOT DISTINCT FROM NEW.github_blob_url
           AND OLD.geometry_same IS NOT DISTINCT FROM NEW.geometry_same
           AND OLD.requirement IS NOT DISTINCT FROM NEW.requirement
           AND OLD.option_group_id IS NOT DISTINCT FROM NEW.option_group_id
           AND OLD.manifest_source IS NOT DISTINCT FROM NEW.manifest_source
        THEN
          RETURN NEW;
        END IF;
        UPDATE build_profiles
           SET accepted_plan_revision_id = NULL
         WHERE id = OLD.profile_id AND tenant_id = OLD.tenant_id;
      END IF;
      UPDATE build_profiles
         SET accepted_plan_revision_id = NULL
       WHERE id = NEW.profile_id AND tenant_id = NEW.tenant_id;
      RETURN NEW;
    END
  $function$`,
  `DO $block$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plan_revisions_immutable') THEN
        CREATE TRIGGER trg_plan_revisions_immutable
          BEFORE UPDATE OR DELETE ON plan_revisions
          FOR EACH ROW EXECUTE FUNCTION protect_plan_revisions_immutable();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plan_revision_parts_immutable') THEN
        CREATE TRIGGER trg_plan_revision_parts_immutable
          BEFORE UPDATE OR DELETE ON plan_revision_parts
          FOR EACH ROW EXECUTE FUNCTION protect_plan_revision_parts_immutable();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plan_revision_part_projection_owner') THEN
        CREATE TRIGGER trg_plan_revision_part_projection_owner
          BEFORE INSERT ON plan_revision_parts
          FOR EACH ROW EXECUTE FUNCTION enforce_plan_revision_part_projection_owner();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_parts_invalidate_accepted_revision') THEN
        CREATE TRIGGER trg_parts_invalidate_accepted_revision
          AFTER INSERT OR UPDATE OR DELETE ON parts
          FOR EACH ROW EXECUTE FUNCTION invalidate_accepted_plan_revision();
      END IF;
      DROP TRIGGER IF EXISTS trg_profile_layers_invalidate_accepted_revision ON profile_layers;
    END
  $block$`,
  `CREATE TABLE IF NOT EXISTS plan_drafts (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    base_revision_id INTEGER REFERENCES plan_revisions(id) ON DELETE RESTRICT,
    base_plan_version INTEGER NOT NULL,
    state TEXT NOT NULL CONSTRAINT chk_plan_drafts_state
      CHECK (state IN ('open', 'abandoned', 'consumed')),
    lifecycle_version INTEGER NOT NULL DEFAULT 0
      CONSTRAINT chk_plan_drafts_lifecycle_version
      CHECK (lifecycle_version >= 0 AND lifecycle_version <= 2147483647),
    rebased_from_draft_id INTEGER REFERENCES plan_drafts(id) ON DELETE CASCADE,
    rebased_from_lifecycle_version INTEGER,
    rebased_from_snapshot_digest TEXT,
    digest_format TEXT NOT NULL,
    snapshot_digest TEXT NOT NULL,
    created_by TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CONSTRAINT chk_plan_drafts_base CHECK (
      (base_revision_id IS NULL AND base_plan_version = 0)
      OR (base_revision_id IS NOT NULL AND base_plan_version > 0)
    ),
    CONSTRAINT chk_plan_drafts_rebase_origin CHECK (
      (rebased_from_draft_id IS NULL
        AND rebased_from_lifecycle_version IS NULL
        AND rebased_from_snapshot_digest IS NULL)
      OR (rebased_from_draft_id IS NOT NULL
        AND rebased_from_lifecycle_version IS NOT NULL
        AND rebased_from_snapshot_digest IS NOT NULL
        AND rebased_from_lifecycle_version >= 0
        AND rebased_from_lifecycle_version <= 2147483647)
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_drafts_tenant_actor_profile_key
    ON plan_drafts (tenant_id, created_by, profile_id, idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS idx_plan_drafts_tenant_profile_created
    ON plan_drafts (tenant_id, profile_id, created_at, id)`,
  `ALTER TABLE plan_drafts ADD COLUMN IF NOT EXISTS lifecycle_version INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE plan_drafts ADD COLUMN IF NOT EXISTS rebased_from_draft_id INTEGER
    REFERENCES plan_drafts(id) ON DELETE CASCADE`,
  `ALTER TABLE plan_drafts ADD COLUMN IF NOT EXISTS rebased_from_lifecycle_version INTEGER`,
  `ALTER TABLE plan_drafts ADD COLUMN IF NOT EXISTS rebased_from_snapshot_digest TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_drafts_tenant_profile_rebase_source_generation
    ON plan_drafts (
      tenant_id, profile_id, rebased_from_draft_id, rebased_from_lifecycle_version
    ) WHERE rebased_from_draft_id IS NOT NULL`,
  `DO $block$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_plan_drafts_lifecycle_version'
      ) THEN
        ALTER TABLE plan_drafts ADD CONSTRAINT chk_plan_drafts_lifecycle_version
          CHECK (lifecycle_version >= 0 AND lifecycle_version <= 2147483647);
      END IF;
    END
  $block$`,
  `DO $block$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_plan_drafts_rebase_origin'
      ) THEN
        ALTER TABLE plan_drafts ADD CONSTRAINT chk_plan_drafts_rebase_origin CHECK (
          (rebased_from_draft_id IS NULL
            AND rebased_from_lifecycle_version IS NULL
            AND rebased_from_snapshot_digest IS NULL)
          OR (rebased_from_draft_id IS NOT NULL
            AND rebased_from_lifecycle_version IS NOT NULL
            AND rebased_from_snapshot_digest IS NOT NULL
            AND rebased_from_lifecycle_version >= 0
            AND rebased_from_lifecycle_version <= 2147483647)
        );
      END IF;
    END
  $block$`,
  `CREATE TABLE IF NOT EXISTS plan_draft_inputs (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    draft_id INTEGER NOT NULL REFERENCES plan_drafts(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    source_layer TEXT NOT NULL,
    layer_order INTEGER NOT NULL,
    tracking_kind TEXT NOT NULL CHECK (tracking_kind IN ('revision', 'untracked')),
    source_revision_id INTEGER REFERENCES source_revisions(id) ON DELETE RESTRICT,
    manifest_digest TEXT,
    effective_naming_digest TEXT NOT NULL,
    CONSTRAINT chk_plan_draft_inputs_identity CHECK (
      (tracking_kind = 'revision' AND source_revision_id IS NOT NULL AND manifest_digest IS NOT NULL)
      OR (tracking_kind = 'untracked' AND source_revision_id IS NULL AND manifest_digest IS NULL)
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_draft_inputs_tenant_draft_source
    ON plan_draft_inputs (tenant_id, draft_id, source_id)`,
  `CREATE TABLE IF NOT EXISTS plan_draft_parts (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    draft_id INTEGER NOT NULL REFERENCES plan_drafts(id) ON DELETE CASCADE,
    base_revision_part_id INTEGER REFERENCES plan_revision_parts(id) ON DELETE RESTRICT,
    part_key TEXT NOT NULL,
    relative_path TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL DEFAULT '',
    source_layer TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'base',
    role_inferred TEXT NOT NULL DEFAULT 'primary',
    role_override TEXT,
    filament_color_id TEXT,
    filament_custom_hex TEXT,
    spoolman_spool_id TEXT,
    quantity_inferred INTEGER NOT NULL DEFAULT 1,
    quantity_override INTEGER,
    quantity_effective INTEGER NOT NULL DEFAULT 1,
    included BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT NOT NULL DEFAULT '',
    github_blob_url TEXT,
    geometry_same BOOLEAN,
    requirement TEXT,
    option_group_id TEXT,
    manifest_source TEXT,
    artifact_digest TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plan_draft_parts_tenant_draft
    ON plan_draft_parts (tenant_id, draft_id, id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_draft_parts_tenant_draft_predecessor
    ON plan_draft_parts (tenant_id, draft_id, base_revision_part_id)`,
  `CREATE OR REPLACE FUNCTION validate_plan_draft_ownership() RETURNS trigger AS $function$
    BEGIN
      IF TG_OP = 'INSERT' OR EXISTS (
        SELECT 1 FROM build_profiles old_profile
         WHERE old_profile.id = OLD.profile_id AND old_profile.tenant_id = OLD.tenant_id
      ) THEN
        IF NOT EXISTS (
          SELECT 1 FROM build_profiles profile
           WHERE profile.id = NEW.profile_id AND profile.tenant_id = NEW.tenant_id
        ) OR (
          NEW.base_revision_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM plan_revisions revision
             WHERE revision.id = NEW.base_revision_id
               AND revision.profile_id = NEW.profile_id
               AND revision.tenant_id = NEW.tenant_id
          )
        ) THEN
          RAISE EXCEPTION 'Plan draft ownership violation';
        END IF;
      END IF;
      IF TG_OP = 'INSERT' AND NEW.rebased_from_draft_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM plan_drafts source
         WHERE source.id = NEW.rebased_from_draft_id
           AND source.id <> NEW.id
           AND source.tenant_id = NEW.tenant_id
           AND source.profile_id = NEW.profile_id
           AND source.state = 'abandoned'
           AND source.lifecycle_version = NEW.rebased_from_lifecycle_version
           AND source.snapshot_digest = NEW.rebased_from_snapshot_digest
      ) THEN
        RAISE EXCEPTION 'Plan draft rebase lineage violation';
      END IF;
      RETURN NEW;
    END
  $function$ LANGUAGE plpgsql`,
  `DO $block$
    BEGIN
      DROP TRIGGER IF EXISTS trg_plan_drafts_ownership_insert ON plan_drafts;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plan_drafts_ownership_write') THEN
        CREATE TRIGGER trg_plan_drafts_ownership_write
          BEFORE INSERT OR UPDATE ON plan_drafts
          FOR EACH ROW EXECUTE FUNCTION validate_plan_draft_ownership();
      END IF;
    END
  $block$`,
  `CREATE OR REPLACE FUNCTION enforce_plan_draft_state_transition() RETURNS trigger AS $function$
    BEGIN
      IF NEW.state = OLD.state THEN
        IF NEW.lifecycle_version <> OLD.lifecycle_version THEN
          RAISE EXCEPTION 'Invalid Plan draft lifecycle version';
        END IF;
      ELSIF NOT (
        NEW.lifecycle_version = OLD.lifecycle_version + 1
        AND (
          (OLD.state = 'open' AND NEW.state IN ('abandoned', 'consumed'))
          OR (OLD.state = 'abandoned' AND NEW.state = 'open')
        )
      ) THEN
        RAISE EXCEPTION 'Invalid Plan draft state transition';
      END IF;
      RETURN NEW;
    END
  $function$ LANGUAGE plpgsql`,
  `DO $block$
    BEGIN
      DROP TRIGGER IF EXISTS trg_plan_drafts_state_transition ON plan_drafts;
      CREATE TRIGGER trg_plan_drafts_state_transition
        BEFORE UPDATE OF state, lifecycle_version ON plan_drafts
        FOR EACH ROW EXECUTE FUNCTION enforce_plan_draft_state_transition();
    END
  $block$`,
  `CREATE OR REPLACE FUNCTION enforce_plan_draft_identity_immutable() RETURNS trigger AS $function$
    BEGIN
      IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
        OR NEW.base_revision_id IS DISTINCT FROM OLD.base_revision_id
        OR NEW.base_plan_version IS DISTINCT FROM OLD.base_plan_version
        OR NEW.rebased_from_draft_id IS DISTINCT FROM OLD.rebased_from_draft_id
        OR NEW.rebased_from_lifecycle_version IS DISTINCT FROM OLD.rebased_from_lifecycle_version
        OR NEW.rebased_from_snapshot_digest IS DISTINCT FROM OLD.rebased_from_snapshot_digest THEN
        RAISE EXCEPTION 'Plan draft identity is immutable';
      END IF;
      RETURN NEW;
    END
  $function$ LANGUAGE plpgsql`,
  `DO $block$
    BEGIN
      DROP TRIGGER IF EXISTS trg_plan_drafts_identity_immutable ON plan_drafts;
      CREATE TRIGGER trg_plan_drafts_identity_immutable
        BEFORE UPDATE OF tenant_id, profile_id, base_revision_id, base_plan_version,
          rebased_from_draft_id, rebased_from_lifecycle_version,
          rebased_from_snapshot_digest
        ON plan_drafts
        FOR EACH ROW EXECUTE FUNCTION enforce_plan_draft_identity_immutable();
    END
  $block$`,
  `CREATE OR REPLACE FUNCTION validate_plan_draft_input_ownership() RETURNS trigger AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM plan_drafts draft
         WHERE draft.id = NEW.draft_id
           AND draft.tenant_id = NEW.tenant_id
           AND draft.state = 'open'
      ) OR NOT EXISTS (
        SELECT 1 FROM projects source
         WHERE source.id = NEW.source_id AND source.tenant_id = NEW.tenant_id
      ) OR (
        NEW.source_revision_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM source_revisions revision
           WHERE revision.id = NEW.source_revision_id
             AND revision.project_id = NEW.source_id
             AND revision.tenant_id = NEW.tenant_id
        )
      ) THEN
        RAISE EXCEPTION 'Plan draft input ownership requires an open parent';
      END IF;
      RETURN NEW;
    END
  $function$ LANGUAGE plpgsql`,
  `DO $block$
    BEGIN
      DROP TRIGGER IF EXISTS trg_plan_draft_inputs_ownership_insert ON plan_draft_inputs;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plan_draft_inputs_ownership_write') THEN
        CREATE TRIGGER trg_plan_draft_inputs_ownership_write
          BEFORE INSERT OR UPDATE ON plan_draft_inputs
          FOR EACH ROW EXECUTE FUNCTION validate_plan_draft_input_ownership();
      END IF;
    END
  $block$`,
  `CREATE OR REPLACE FUNCTION validate_plan_draft_part_ownership() RETURNS trigger AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM plan_drafts draft
         WHERE draft.id = NEW.draft_id
           AND draft.tenant_id = NEW.tenant_id
           AND draft.state = 'open'
      ) OR (
        NEW.base_revision_part_id IS NOT NULL AND NOT EXISTS (
          SELECT 1
            FROM plan_revision_parts part
            JOIN plan_drafts draft ON draft.id = NEW.draft_id
           WHERE part.id = NEW.base_revision_part_id
             AND part.revision_id = draft.base_revision_id
             AND part.tenant_id = NEW.tenant_id
             AND draft.tenant_id = NEW.tenant_id
        )
      ) THEN
        RAISE EXCEPTION 'Plan draft Part ownership requires an open parent';
      END IF;
      RETURN NEW;
    END
  $function$ LANGUAGE plpgsql`,
  `DO $block$
    BEGIN
      DROP TRIGGER IF EXISTS trg_plan_draft_parts_ownership_insert ON plan_draft_parts;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plan_draft_parts_ownership_write') THEN
        CREATE TRIGGER trg_plan_draft_parts_ownership_write
          BEFORE INSERT OR UPDATE ON plan_draft_parts
          FOR EACH ROW EXECUTE FUNCTION validate_plan_draft_part_ownership();
      END IF;
    END
  $block$`,
  `CREATE TABLE IF NOT EXISTS required_units (
    token TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    created_in_revision_id INTEGER NOT NULL REFERENCES plan_revisions(id) ON DELETE CASCADE,
    object_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CONSTRAINT chk_required_units_token CHECK (token ~ '^ppu_[0-9a-f]{32}$'),
    CONSTRAINT chk_required_units_object_name CHECK (
      length(object_name) BETWEEN 1 AND 200
      AND right(object_name, length(token) + 2) = '__' || token
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_required_units_object_name_ci
    ON required_units (lower(object_name))`,
  `CREATE TABLE IF NOT EXISTS plan_revision_required_unit_sets (
    revision_id INTEGER PRIMARY KEY REFERENCES plan_revisions(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    format TEXT NOT NULL CONSTRAINT chk_plan_revision_required_unit_sets_format
      CHECK (format = 'required-unit-map-v1'),
    expected_unit_count INTEGER NOT NULL CONSTRAINT chk_plan_revision_required_unit_sets_count
      CHECK (expected_unit_count >= 0),
    mapping_digest TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS plan_revision_required_units (
    tenant_id TEXT NOT NULL,
    revision_id INTEGER NOT NULL REFERENCES plan_revisions(id) ON DELETE CASCADE,
    revision_part_id INTEGER NOT NULL REFERENCES plan_revision_parts(id) ON DELETE CASCADE,
    unit_index INTEGER NOT NULL CONSTRAINT chk_plan_revision_required_units_index
      CHECK (unit_index BETWEEN 0 AND 9999),
    required_unit_token TEXT NOT NULL REFERENCES required_units(token) ON DELETE CASCADE,
    CONSTRAINT pk_plan_revision_required_units
      PRIMARY KEY (tenant_id, revision_id, revision_part_id, unit_index),
    CONSTRAINT uq_plan_revision_required_units_token
      UNIQUE (tenant_id, revision_id, required_unit_token)
  )`,
  `CREATE OR REPLACE FUNCTION validate_required_unit_ownership() RETURNS trigger AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM build_profiles profile
          JOIN plan_revisions revision
            ON revision.id = NEW.created_in_revision_id
           AND revision.profile_id = profile.id
           AND revision.tenant_id = profile.tenant_id
         WHERE profile.id = NEW.profile_id
           AND profile.tenant_id = NEW.tenant_id
      ) THEN
        RAISE EXCEPTION 'Required unit ownership violation';
      END IF;
      RETURN NEW;
    END
  $function$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION validate_plan_revision_required_unit_ownership()
    RETURNS trigger AS $function$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM plan_revision_required_unit_sets set_header
         WHERE set_header.revision_id = NEW.revision_id
      ) OR NOT EXISTS (
        SELECT 1
          FROM plan_revisions revision
          JOIN plan_revision_parts part
            ON part.id = NEW.revision_part_id
           AND part.revision_id = revision.id
           AND part.tenant_id = revision.tenant_id
          JOIN required_units unit
            ON unit.token = NEW.required_unit_token
           AND unit.profile_id = revision.profile_id
           AND unit.tenant_id = revision.tenant_id
         WHERE revision.id = NEW.revision_id
           AND revision.tenant_id = NEW.tenant_id
      ) THEN
        RAISE EXCEPTION 'Required-unit mapping ownership violation';
      END IF;
      RETURN NEW;
    END
  $function$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION validate_plan_revision_required_unit_set()
    RETURNS trigger AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM plan_revisions revision
         WHERE revision.id = NEW.revision_id
           AND revision.profile_id = NEW.profile_id
           AND revision.tenant_id = NEW.tenant_id
      ) OR NEW.expected_unit_count <> (
        SELECT count(*) FROM plan_revision_required_units mapping
         WHERE mapping.tenant_id = NEW.tenant_id
           AND mapping.revision_id = NEW.revision_id
      ) THEN
        RAISE EXCEPTION 'Required-unit set ownership or count violation';
      END IF;
      RETURN NEW;
    END
  $function$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION enforce_required_unit_immutable() RETURNS trigger AS $function$
    BEGIN
      IF TG_OP = 'UPDATE' OR EXISTS (
        SELECT 1 FROM build_profiles profile
         WHERE profile.id = OLD.profile_id AND profile.tenant_id = OLD.tenant_id
      ) THEN
        RAISE EXCEPTION 'Required unit is immutable';
      END IF;
      RETURN OLD;
    END
  $function$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION enforce_plan_revision_required_unit_immutable()
    RETURNS trigger AS $function$
    BEGIN
      IF TG_OP = 'UPDATE' OR EXISTS (
        SELECT 1
          FROM plan_revisions revision
          JOIN build_profiles profile
            ON profile.id = revision.profile_id
           AND profile.tenant_id = revision.tenant_id
         WHERE revision.id = OLD.revision_id
           AND revision.tenant_id = OLD.tenant_id
      ) THEN
        RAISE EXCEPTION 'Required-unit mapping is immutable';
      END IF;
      RETURN OLD;
    END
  $function$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION enforce_plan_revision_required_unit_set_immutable()
    RETURNS trigger AS $function$
    BEGIN
      IF TG_OP = 'UPDATE' OR EXISTS (
        SELECT 1
          FROM plan_revisions revision
          JOIN build_profiles profile
            ON profile.id = revision.profile_id
           AND profile.tenant_id = revision.tenant_id
         WHERE revision.id = OLD.revision_id
           AND revision.tenant_id = OLD.tenant_id
      ) THEN
        RAISE EXCEPTION 'Required-unit set is immutable';
      END IF;
      RETURN OLD;
    END
  $function$ LANGUAGE plpgsql`,
  `DO $block$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_required_units_ownership_insert') THEN
        CREATE TRIGGER trg_required_units_ownership_insert
          BEFORE INSERT ON required_units
          FOR EACH ROW EXECUTE FUNCTION validate_required_unit_ownership();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_required_units_immutable_write') THEN
        CREATE TRIGGER trg_required_units_immutable_write
          BEFORE UPDATE OR DELETE ON required_units
          FOR EACH ROW EXECUTE FUNCTION enforce_required_unit_immutable();
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_plan_revision_required_units_ownership_insert'
      ) THEN
        CREATE TRIGGER trg_plan_revision_required_units_ownership_insert
          BEFORE INSERT ON plan_revision_required_units
          FOR EACH ROW EXECUTE FUNCTION validate_plan_revision_required_unit_ownership();
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_plan_revision_required_units_immutable_write'
      ) THEN
        CREATE TRIGGER trg_plan_revision_required_units_immutable_write
          BEFORE UPDATE OR DELETE ON plan_revision_required_units
          FOR EACH ROW EXECUTE FUNCTION enforce_plan_revision_required_unit_immutable();
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_plan_revision_required_unit_sets_ownership_insert'
      ) THEN
        CREATE TRIGGER trg_plan_revision_required_unit_sets_ownership_insert
          BEFORE INSERT ON plan_revision_required_unit_sets
          FOR EACH ROW EXECUTE FUNCTION validate_plan_revision_required_unit_set();
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_plan_revision_required_unit_sets_immutable_write'
      ) THEN
        CREATE TRIGGER trg_plan_revision_required_unit_sets_immutable_write
          BEFORE UPDATE OR DELETE ON plan_revision_required_unit_sets
          FOR EACH ROW EXECUTE FUNCTION enforce_plan_revision_required_unit_set_immutable();
      END IF;
    END
  $block$`,
  `CREATE TABLE IF NOT EXISTS plan_draft_required_unit_reconciliations (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    draft_id INTEGER NOT NULL REFERENCES plan_drafts(id) ON DELETE CASCADE,
    format TEXT NOT NULL CONSTRAINT chk_plan_draft_required_unit_reconciliations_format
      CHECK (format = 'required-unit-reconciliation-v1'),
    planning_digest TEXT NOT NULL,
    base_revision_id INTEGER REFERENCES plan_revisions(id) ON DELETE RESTRICT,
    base_mapping_digest TEXT,
    selection_basis_digest TEXT NOT NULL,
    selection_basis_json TEXT NOT NULL CONSTRAINT chk_plan_draft_required_unit_reconciliations_basis_json
      CHECK (jsonb_typeof(selection_basis_json::jsonb) = 'array'),
    decision_digest TEXT NOT NULL,
    result_kind TEXT NOT NULL CONSTRAINT chk_plan_draft_required_unit_reconciliations_result
      CHECK (result_kind IN ('unresolved', 'ready')),
    result_digest TEXT NOT NULL,
    result_json TEXT NOT NULL CONSTRAINT chk_plan_draft_required_unit_reconciliations_result_json
      CHECK (jsonb_typeof(result_json::jsonb) = 'object'),
    reconciliation_digest TEXT NOT NULL,
    expected_assignment_count INTEGER NOT NULL
      CONSTRAINT chk_plan_draft_required_unit_reconciliations_count
      CHECK (expected_assignment_count >= 0),
    actor_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finalized_at TEXT,
    CONSTRAINT uq_plan_draft_required_unit_reconciliations_key
      UNIQUE (tenant_id, actor_id, draft_id, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS plan_draft_required_unit_decisions (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    reconciliation_id INTEGER NOT NULL
      REFERENCES plan_draft_required_unit_reconciliations(id) ON DELETE CASCADE,
    target_draft_part_id INTEGER NOT NULL REFERENCES plan_draft_parts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    predecessor_revision_part_id INTEGER REFERENCES plan_revision_parts(id) ON DELETE RESTRICT,
    CONSTRAINT uq_plan_draft_required_unit_decisions_target
      UNIQUE (tenant_id, reconciliation_id, target_draft_part_id),
    CONSTRAINT chk_plan_draft_required_unit_decisions_kind CHECK (
      (kind = 'replace' AND predecessor_revision_part_id IS NULL)
      OR (kind IN ('select_exact_predecessor', 'accept_prior_completion')
        AND predecessor_revision_part_id IS NOT NULL)
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_draft_required_unit_decisions_predecessor
    ON plan_draft_required_unit_decisions (
      tenant_id, reconciliation_id, predecessor_revision_part_id
    ) WHERE predecessor_revision_part_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS plan_draft_required_unit_assignments (
    tenant_id TEXT NOT NULL,
    reconciliation_id INTEGER NOT NULL
      REFERENCES plan_draft_required_unit_reconciliations(id) ON DELETE CASCADE,
    target_draft_part_id INTEGER NOT NULL REFERENCES plan_draft_parts(id) ON DELETE CASCADE,
    unit_index INTEGER NOT NULL CONSTRAINT chk_plan_draft_required_unit_assignments_index
      CHECK (unit_index BETWEEN 0 AND 9999),
    kind TEXT NOT NULL,
    required_unit_token TEXT REFERENCES required_units(token) ON DELETE RESTRICT,
    CONSTRAINT pk_plan_draft_required_unit_assignments
      PRIMARY KEY (tenant_id, reconciliation_id, target_draft_part_id, unit_index),
    CONSTRAINT chk_plan_draft_required_unit_assignments_kind CHECK (
      (kind = 'reuse' AND required_unit_token IS NOT NULL)
      OR (kind = 'create' AND required_unit_token IS NULL)
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_draft_required_unit_assignments_token
    ON plan_draft_required_unit_assignments (
      tenant_id, reconciliation_id, required_unit_token
    ) WHERE required_unit_token IS NOT NULL`,
  `ALTER TABLE plan_drafts
    ADD COLUMN IF NOT EXISTS current_required_unit_reconciliation_id INTEGER
      REFERENCES plan_draft_required_unit_reconciliations(id) ON DELETE SET NULL`,
  `CREATE OR REPLACE FUNCTION validate_plan_draft_required_unit_reconciliation_insert()
    RETURNS trigger AS $function$
    BEGIN
      IF NEW.finalized_at IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM plan_drafts draft
         WHERE draft.id = NEW.draft_id
           AND draft.tenant_id = NEW.tenant_id
           AND draft.profile_id = NEW.profile_id
           AND draft.state = 'open'
           AND draft.base_revision_id IS NOT DISTINCT FROM NEW.base_revision_id
      ) THEN
        RAISE EXCEPTION 'Required-unit reconciliation ownership violation';
      END IF;
      RETURN NEW;
    END
  $function$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION enforce_plan_draft_required_unit_reconciliation_update()
    RETURNS trigger AS $function$
    DECLARE assignment_count INTEGER;
    BEGIN
      IF OLD.finalized_at IS NOT NULL OR NEW.finalized_at IS NULL
        OR ROW(NEW.id, NEW.tenant_id, NEW.profile_id, NEW.draft_id, NEW.format,
          NEW.planning_digest, NEW.base_revision_id, NEW.base_mapping_digest,
          NEW.selection_basis_digest, NEW.selection_basis_json, NEW.decision_digest,
          NEW.result_kind, NEW.result_digest, NEW.result_json, NEW.reconciliation_digest,
          NEW.expected_assignment_count,
          NEW.actor_id, NEW.idempotency_key, NEW.payload_digest, NEW.created_at)
          IS DISTINCT FROM
          ROW(OLD.id, OLD.tenant_id, OLD.profile_id, OLD.draft_id, OLD.format,
          OLD.planning_digest, OLD.base_revision_id, OLD.base_mapping_digest,
          OLD.selection_basis_digest, OLD.selection_basis_json, OLD.decision_digest,
          OLD.result_kind, OLD.result_digest, OLD.result_json, OLD.reconciliation_digest,
          OLD.expected_assignment_count,
          OLD.actor_id, OLD.idempotency_key, OLD.payload_digest, OLD.created_at)
      THEN
        RAISE EXCEPTION 'Required-unit reconciliation finalization violation';
      END IF;
      SELECT count(*) INTO assignment_count
        FROM plan_draft_required_unit_assignments assignment
       WHERE assignment.reconciliation_id = NEW.id
         AND assignment.tenant_id = NEW.tenant_id;
      IF (NEW.result_kind = 'unresolved' AND (
          assignment_count <> 0
          OR NEW.result_json::jsonb->>'kind' <> 'unresolved'
          OR jsonb_typeof(NEW.result_json::jsonb->'conflicts') <> 'array'
        ))
        OR (NEW.result_kind = 'ready' AND (
          assignment_count <> NEW.expected_assignment_count
          OR NEW.result_json::jsonb->>'kind' <> 'ready'
          OR jsonb_typeof(NEW.result_json::jsonb->'assignments') <> 'array'
          OR jsonb_typeof(NEW.result_json::jsonb->'surplus') <> 'array'
          OR jsonb_array_length(NEW.result_json::jsonb->'assignments')
            <> NEW.expected_assignment_count
          OR EXISTS (
            SELECT 1
              FROM jsonb_array_elements(NEW.result_json::jsonb->'assignments') expected
             WHERE NOT EXISTS (
               SELECT 1 FROM plan_draft_required_unit_assignments assignment
                WHERE assignment.reconciliation_id = NEW.id
                  AND assignment.tenant_id = NEW.tenant_id
                  AND assignment.target_draft_part_id = (expected->>'draftPartId')::INTEGER
                  AND assignment.unit_index = (expected->>'unitIndex')::INTEGER
                  AND assignment.kind = expected->>'kind'
                  AND (
                    (assignment.kind = 'create' AND assignment.required_unit_token IS NULL)
                    OR (assignment.kind = 'reuse'
                      AND assignment.required_unit_token = expected->>'token')
                  )
             )
          )
        ))
      THEN
        RAISE EXCEPTION 'Required-unit reconciliation finalization violation';
      END IF;
      IF NEW.result_kind = 'ready' AND EXISTS (
        SELECT 1 FROM plan_draft_parts part
         WHERE part.draft_id = NEW.draft_id
           AND part.tenant_id = NEW.tenant_id
           AND (
             part.quantity_effective <> (
               SELECT count(*) FROM plan_draft_required_unit_assignments assignment
                WHERE assignment.reconciliation_id = NEW.id
                  AND assignment.tenant_id = NEW.tenant_id
                  AND assignment.target_draft_part_id = part.id
             )
             OR part.quantity_effective - 1 <> (
               SELECT max(assignment.unit_index)
                 FROM plan_draft_required_unit_assignments assignment
                WHERE assignment.reconciliation_id = NEW.id
                  AND assignment.tenant_id = NEW.tenant_id
                  AND assignment.target_draft_part_id = part.id
             )
           )
      ) THEN
        RAISE EXCEPTION 'Required-unit reconciliation finalization violation';
      END IF;
      RETURN NEW;
    END
  $function$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION validate_plan_draft_required_unit_decision_insert()
    RETURNS trigger AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM plan_draft_required_unit_reconciliations reconciliation
          JOIN plan_draft_parts target
            ON target.id = NEW.target_draft_part_id
           AND target.draft_id = reconciliation.draft_id
           AND target.tenant_id = reconciliation.tenant_id
         WHERE reconciliation.id = NEW.reconciliation_id
           AND reconciliation.tenant_id = NEW.tenant_id
           AND reconciliation.finalized_at IS NULL
           AND (
             NEW.predecessor_revision_part_id IS NULL
             OR EXISTS (
               SELECT 1 FROM plan_revision_parts predecessor
                WHERE predecessor.id = NEW.predecessor_revision_part_id
                  AND predecessor.revision_id = reconciliation.base_revision_id
                  AND predecessor.tenant_id = reconciliation.tenant_id
             )
           )
      ) THEN
        RAISE EXCEPTION 'Required-unit reconciliation decision ownership violation';
      END IF;
      RETURN NEW;
    END
  $function$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION validate_plan_draft_required_unit_assignment_insert()
    RETURNS trigger AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM plan_draft_required_unit_reconciliations reconciliation
          JOIN plan_draft_parts target
            ON target.id = NEW.target_draft_part_id
           AND target.draft_id = reconciliation.draft_id
           AND target.tenant_id = reconciliation.tenant_id
         WHERE reconciliation.id = NEW.reconciliation_id
           AND reconciliation.tenant_id = NEW.tenant_id
           AND reconciliation.finalized_at IS NULL
           AND (
             (NEW.kind = 'create' AND NEW.required_unit_token IS NULL)
             OR (NEW.kind = 'reuse' AND EXISTS (
               SELECT 1 FROM required_units unit
                WHERE unit.token = NEW.required_unit_token
                  AND unit.tenant_id = reconciliation.tenant_id
                  AND unit.profile_id = reconciliation.profile_id
             ))
           )
      ) THEN
        RAISE EXCEPTION 'Required-unit reconciliation assignment ownership violation';
      END IF;
      RETURN NEW;
    END
  $function$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION validate_plan_draft_required_unit_selection()
    RETURNS trigger AS $function$
    BEGIN
      IF NEW.current_required_unit_reconciliation_id IS DISTINCT FROM
          OLD.current_required_unit_reconciliation_id
        AND EXISTS (
          SELECT 1 FROM build_profiles profile
           WHERE profile.id = OLD.profile_id AND profile.tenant_id = OLD.tenant_id
        )
        AND (
          NEW.state <> 'open'
          OR (NEW.current_required_unit_reconciliation_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM plan_draft_required_unit_reconciliations reconciliation
             WHERE reconciliation.id = NEW.current_required_unit_reconciliation_id
               AND reconciliation.tenant_id = NEW.tenant_id
               AND reconciliation.profile_id = NEW.profile_id
               AND reconciliation.draft_id = NEW.id
               AND reconciliation.finalized_at IS NOT NULL
          ))
        )
      THEN
        RAISE EXCEPTION 'Plan draft Required-unit selection violation';
      END IF;
      RETURN NEW;
    END
  $function$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION enforce_plan_draft_required_unit_child_immutable()
    RETURNS trigger AS $function$
    BEGIN
      IF TG_OP = 'UPDATE' OR EXISTS (
        SELECT 1 FROM plan_draft_required_unit_reconciliations reconciliation
        JOIN plan_drafts draft ON draft.id = reconciliation.draft_id
        JOIN build_profiles profile
          ON profile.id = draft.profile_id AND profile.tenant_id = draft.tenant_id
        WHERE reconciliation.id = OLD.reconciliation_id
          AND reconciliation.tenant_id = OLD.tenant_id
      ) THEN
        RAISE EXCEPTION 'Required-unit reconciliation child is immutable';
      END IF;
      RETURN OLD;
    END
  $function$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION enforce_plan_draft_required_unit_header_delete()
    RETURNS trigger AS $function$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM plan_drafts draft
        JOIN build_profiles profile
          ON profile.id = draft.profile_id AND profile.tenant_id = draft.tenant_id
        WHERE draft.id = OLD.draft_id AND draft.tenant_id = OLD.tenant_id
      ) THEN
        RAISE EXCEPTION 'Required-unit reconciliation is immutable';
      END IF;
      RETURN OLD;
    END
  $function$ LANGUAGE plpgsql`,
  `DO $block$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plan_draft_required_unit_reconciliations_ownership_insert') THEN
        CREATE TRIGGER trg_plan_draft_required_unit_reconciliations_ownership_insert
          BEFORE INSERT ON plan_draft_required_unit_reconciliations
          FOR EACH ROW EXECUTE FUNCTION validate_plan_draft_required_unit_reconciliation_insert();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plan_draft_required_unit_reconciliations_finalize') THEN
        CREATE TRIGGER trg_plan_draft_required_unit_reconciliations_finalize
          BEFORE UPDATE ON plan_draft_required_unit_reconciliations
          FOR EACH ROW EXECUTE FUNCTION enforce_plan_draft_required_unit_reconciliation_update();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plan_draft_required_unit_reconciliations_immutable_delete') THEN
        CREATE TRIGGER trg_plan_draft_required_unit_reconciliations_immutable_delete
          BEFORE DELETE ON plan_draft_required_unit_reconciliations
          FOR EACH ROW EXECUTE FUNCTION enforce_plan_draft_required_unit_header_delete();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plan_draft_required_unit_decisions_ownership_insert') THEN
        CREATE TRIGGER trg_plan_draft_required_unit_decisions_ownership_insert
          BEFORE INSERT ON plan_draft_required_unit_decisions
          FOR EACH ROW EXECUTE FUNCTION validate_plan_draft_required_unit_decision_insert();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plan_draft_required_unit_decisions_immutable_write') THEN
        CREATE TRIGGER trg_plan_draft_required_unit_decisions_immutable_write
          BEFORE UPDATE OR DELETE ON plan_draft_required_unit_decisions
          FOR EACH ROW EXECUTE FUNCTION enforce_plan_draft_required_unit_child_immutable();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plan_draft_required_unit_assignments_ownership_insert') THEN
        CREATE TRIGGER trg_plan_draft_required_unit_assignments_ownership_insert
          BEFORE INSERT ON plan_draft_required_unit_assignments
          FOR EACH ROW EXECUTE FUNCTION validate_plan_draft_required_unit_assignment_insert();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plan_draft_required_unit_assignments_immutable_write') THEN
        CREATE TRIGGER trg_plan_draft_required_unit_assignments_immutable_write
          BEFORE UPDATE OR DELETE ON plan_draft_required_unit_assignments
          FOR EACH ROW EXECUTE FUNCTION enforce_plan_draft_required_unit_child_immutable();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plan_drafts_required_unit_selection_update') THEN
        CREATE TRIGGER trg_plan_drafts_required_unit_selection_update
          BEFORE UPDATE OF current_required_unit_reconciliation_id ON plan_drafts
          FOR EACH ROW EXECUTE FUNCTION validate_plan_draft_required_unit_selection();
      END IF;
    END
  $block$`,
  `ALTER TABLE plan_drafts ADD COLUMN IF NOT EXISTS consumed_revision_id INTEGER
    REFERENCES plan_revisions(id) ON DELETE CASCADE`,
  `ALTER TABLE plan_drafts ADD COLUMN IF NOT EXISTS consumed_at TEXT`,
  `CREATE TABLE IF NOT EXISTS plan_apply_requests (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    draft_id INTEGER NOT NULL REFERENCES plan_drafts(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_format TEXT NOT NULL CONSTRAINT chk_plan_apply_requests_format
      CHECK (request_format = 'plan-apply-request-v1'),
    request_digest TEXT NOT NULL,
    expected_snapshot_digest TEXT NOT NULL,
    expected_lifecycle_version INTEGER NOT NULL,
    expected_base_revision_id INTEGER REFERENCES plan_revisions(id) ON DELETE CASCADE,
    expected_base_plan_version INTEGER NOT NULL,
    reconciliation_id INTEGER NOT NULL
      REFERENCES plan_draft_required_unit_reconciliations(id) ON DELETE CASCADE,
    reconciliation_digest TEXT NOT NULL,
    revision_id INTEGER NOT NULL REFERENCES plan_revisions(id) ON DELETE CASCADE,
    plan_version INTEGER NOT NULL,
    revision_digest TEXT NOT NULL,
    required_unit_mapping_digest TEXT NOT NULL,
    draft_lifecycle_version INTEGER NOT NULL,
    applied_at TEXT NOT NULL,
    CONSTRAINT chk_plan_apply_requests_base CHECK (
      (expected_base_revision_id IS NULL AND expected_base_plan_version = 0)
      OR (expected_base_revision_id IS NOT NULL AND expected_base_plan_version > 0)
    ),
    CONSTRAINT chk_plan_apply_requests_versions CHECK (
      expected_lifecycle_version BETWEEN 0 AND 2147483646
      AND draft_lifecycle_version = expected_lifecycle_version + 1
      AND plan_version = expected_base_plan_version + 1
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_apply_requests_tenant_actor_profile_key
    ON plan_apply_requests (tenant_id, actor_id, profile_id, idempotency_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_apply_requests_tenant_profile_draft
    ON plan_apply_requests (tenant_id, profile_id, draft_id)`,
  `CREATE OR REPLACE FUNCTION validate_plan_draft_consumption() RETURNS trigger AS $function$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF (NEW.state = 'consumed' AND (
          NEW.consumed_revision_id IS NULL OR NEW.consumed_at IS NULL
        )) OR (NEW.state <> 'consumed' AND (
          NEW.consumed_revision_id IS NOT NULL OR NEW.consumed_at IS NOT NULL
        )) THEN
          RAISE EXCEPTION 'Plan draft consumption violation';
        END IF;
        RETURN NEW;
      END IF;
      IF (NEW.consumed_revision_id IS NULL) <> (NEW.consumed_at IS NULL)
        OR (NEW.state <> 'consumed' AND (
          NEW.consumed_revision_id IS NOT NULL OR NEW.consumed_at IS NOT NULL
        ))
        OR (OLD.state = 'consumed' AND (
          OLD.consumed_revision_id IS DISTINCT FROM NEW.consumed_revision_id
          OR OLD.consumed_at IS DISTINCT FROM NEW.consumed_at
        ))
        OR (OLD.state <> 'consumed' AND NEW.state = 'consumed' AND (
          NEW.consumed_revision_id IS NULL
          OR NEW.consumed_at IS NULL
          OR NOT EXISTS (
            SELECT 1
              FROM plan_revisions revision
              JOIN build_profiles profile
                ON profile.id = NEW.profile_id AND profile.tenant_id = NEW.tenant_id
             WHERE revision.id = NEW.consumed_revision_id
               AND revision.tenant_id = NEW.tenant_id
               AND revision.profile_id = NEW.profile_id
               AND revision.parent_revision_id IS NOT DISTINCT FROM NEW.base_revision_id
               AND profile.accepted_plan_revision_id = revision.id
               AND profile.accepted_plan_version = NEW.base_plan_version + 1
          )
        )) THEN
        RAISE EXCEPTION 'Plan draft consumption violation';
      END IF;
      RETURN NEW;
    END
  $function$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION validate_plan_apply_request_insert() RETURNS trigger AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM plan_drafts draft
          JOIN plan_draft_required_unit_reconciliations reconciliation
            ON reconciliation.id = NEW.reconciliation_id
           AND reconciliation.tenant_id = NEW.tenant_id
           AND reconciliation.profile_id = NEW.profile_id
           AND reconciliation.draft_id = NEW.draft_id
           AND reconciliation.finalized_at IS NOT NULL
          JOIN plan_revisions revision
            ON revision.id = NEW.revision_id
           AND revision.tenant_id = NEW.tenant_id
           AND revision.profile_id = NEW.profile_id
          JOIN build_profiles profile
            ON profile.id = NEW.profile_id AND profile.tenant_id = NEW.tenant_id
         WHERE draft.id = NEW.draft_id
           AND draft.tenant_id = NEW.tenant_id
           AND draft.profile_id = NEW.profile_id
           AND draft.state = 'consumed'
           AND draft.consumed_revision_id = NEW.revision_id
           AND draft.lifecycle_version = NEW.draft_lifecycle_version
           AND draft.base_revision_id IS NOT DISTINCT FROM NEW.expected_base_revision_id
           AND draft.base_plan_version = NEW.expected_base_plan_version
           AND reconciliation.reconciliation_digest = NEW.reconciliation_digest
           AND revision.parent_revision_id IS NOT DISTINCT FROM NEW.expected_base_revision_id
           AND revision.snapshot_digest = NEW.revision_digest
           AND profile.accepted_plan_revision_id = NEW.revision_id
           AND profile.accepted_plan_version = NEW.plan_version
      ) THEN
        RAISE EXCEPTION 'Plan Apply request ownership violation';
      END IF;
      RETURN NEW;
    END
  $function$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION enforce_plan_apply_request_immutable() RETURNS trigger AS $function$
    BEGIN
      IF TG_OP = 'UPDATE' OR EXISTS (
        SELECT 1 FROM build_profiles profile
         WHERE profile.id = OLD.profile_id AND profile.tenant_id = OLD.tenant_id
      ) THEN
        RAISE EXCEPTION 'Plan Apply request is immutable';
      END IF;
      RETURN OLD;
    END
  $function$ LANGUAGE plpgsql`,
  `DO $block$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plan_drafts_consumption_write') THEN
        CREATE TRIGGER trg_plan_drafts_consumption_write
          BEFORE INSERT OR UPDATE OF state, lifecycle_version, consumed_revision_id, consumed_at
          ON plan_drafts FOR EACH ROW EXECUTE FUNCTION validate_plan_draft_consumption();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plan_apply_requests_ownership_insert') THEN
        CREATE TRIGGER trg_plan_apply_requests_ownership_insert
          BEFORE INSERT ON plan_apply_requests
          FOR EACH ROW EXECUTE FUNCTION validate_plan_apply_request_insert();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plan_apply_requests_immutable_write') THEN
        CREATE TRIGGER trg_plan_apply_requests_immutable_write
          BEFORE UPDATE OR DELETE ON plan_apply_requests
          FOR EACH ROW EXECUTE FUNCTION enforce_plan_apply_request_immutable();
      END IF;
    END
  $block$`,
  `CREATE TABLE IF NOT EXISTS accepted_plate_revisions (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    profile_id INTEGER NOT NULL REFERENCES build_profiles(id) ON DELETE CASCADE,
    plan_revision_id INTEGER NOT NULL REFERENCES plan_revisions(id) ON DELETE CASCADE,
    plan_version INTEGER NOT NULL CONSTRAINT chk_accepted_plate_revisions_plan_version
      CHECK (plan_version > 0),
    plan_revision_digest TEXT NOT NULL,
    required_unit_mapping_digest TEXT NOT NULL,
    layout_digest TEXT NOT NULL,
    expected_plate_count INTEGER NOT NULL CONSTRAINT chk_accepted_plate_revisions_plate_count
      CHECK (expected_plate_count > 0),
    expected_unit_count INTEGER NOT NULL CONSTRAINT chk_accepted_plate_revisions_unit_count
      CHECK (expected_unit_count > 0),
    revision_number INTEGER NOT NULL CONSTRAINT chk_accepted_plate_revisions_number
      CHECK (revision_number > 0),
    created_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_accepted_plate_revisions_tenant_profile_number
    ON accepted_plate_revisions (tenant_id, profile_id, revision_number)`,
  `CREATE TABLE IF NOT EXISTS accepted_plate_heads (
    tenant_id TEXT NOT NULL,
    profile_id INTEGER PRIMARY KEY REFERENCES build_profiles(id) ON DELETE CASCADE,
    current_revision_id INTEGER NOT NULL REFERENCES accepted_plate_revisions(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS accepted_plates (
    tenant_id TEXT NOT NULL,
    revision_id INTEGER NOT NULL REFERENCES accepted_plate_revisions(id) ON DELETE CASCADE,
    plate_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CONSTRAINT chk_accepted_plates_ordinal CHECK (ordinal > 0),
    printer_id TEXT NOT NULL,
    printer_name TEXT NOT NULL,
    printer_model TEXT NOT NULL,
    bed_width_um INTEGER NOT NULL CONSTRAINT chk_accepted_plates_bed_width
      CHECK (bed_width_um BETWEEN 1 AND 2147483647),
    bed_depth_um INTEGER NOT NULL CONSTRAINT chk_accepted_plates_bed_depth
      CHECK (bed_depth_um BETWEEN 1 AND 2147483647),
    bed_height_um INTEGER NOT NULL CONSTRAINT chk_accepted_plates_bed_height
      CHECK (bed_height_um BETWEEN 1 AND 2147483647),
    margin_um INTEGER NOT NULL CONSTRAINT chk_accepted_plates_margin
      CHECK (margin_um BETWEEN 0 AND 2147483647),
    CONSTRAINT pk_accepted_plates PRIMARY KEY (tenant_id, revision_id, plate_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_accepted_plates_tenant_revision_ordinal
    ON accepted_plates (tenant_id, revision_id, ordinal)`,
  `CREATE TABLE IF NOT EXISTS accepted_plate_units (
    tenant_id TEXT NOT NULL,
    revision_id INTEGER NOT NULL REFERENCES accepted_plate_revisions(id) ON DELETE CASCADE,
    plate_id TEXT NOT NULL,
    required_unit_token TEXT NOT NULL REFERENCES required_units(token) ON DELETE CASCADE,
    x_um INTEGER NOT NULL CONSTRAINT chk_accepted_plate_units_x
      CHECK (x_um BETWEEN 0 AND 2147483647),
    y_um INTEGER NOT NULL CONSTRAINT chk_accepted_plate_units_y
      CHECK (y_um BETWEEN 0 AND 2147483647),
    width_um INTEGER NOT NULL CONSTRAINT chk_accepted_plate_units_width
      CHECK (width_um BETWEEN 1 AND 2147483647),
    depth_um INTEGER NOT NULL CONSTRAINT chk_accepted_plate_units_depth
      CHECK (depth_um BETWEEN 1 AND 2147483647),
    height_um INTEGER NOT NULL CONSTRAINT chk_accepted_plate_units_height
      CHECK (height_um BETWEEN 1 AND 2147483647),
    CONSTRAINT pk_accepted_plate_units
      PRIMARY KEY (tenant_id, revision_id, required_unit_token)
  )`,
  `CREATE OR REPLACE FUNCTION validate_accepted_plate_revision_insert()
  RETURNS trigger AS $function$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
        FROM build_profiles profile
        JOIN plan_revisions revision
          ON revision.id = NEW.plan_revision_id
         AND revision.tenant_id = profile.tenant_id
         AND revision.profile_id = profile.id
        JOIN plan_revision_required_unit_sets unit_set
          ON unit_set.revision_id = revision.id
         AND unit_set.tenant_id = revision.tenant_id
         AND unit_set.profile_id = revision.profile_id
       WHERE profile.id = NEW.profile_id
         AND profile.tenant_id = NEW.tenant_id
         AND profile.accepted_plan_revision_id = NEW.plan_revision_id
         AND profile.accepted_plan_version = NEW.plan_version
         AND revision.snapshot_digest = NEW.plan_revision_digest
         AND unit_set.mapping_digest = NEW.required_unit_mapping_digest
    ) THEN
      RAISE EXCEPTION 'Accepted Plate revision ownership violation';
    END IF;
    RETURN NEW;
  END
  $function$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION validate_accepted_plate_head_write()
  RETURNS trigger AS $function$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM accepted_plate_revisions revision
       WHERE revision.id = NEW.current_revision_id
         AND revision.tenant_id = NEW.tenant_id
         AND revision.profile_id = NEW.profile_id
    ) THEN
      RAISE EXCEPTION 'Accepted Plate head ownership violation';
    END IF;
    RETURN NEW;
  END
  $function$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION validate_accepted_plate_insert()
  RETURNS trigger AS $function$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM accepted_plate_revisions revision
       WHERE revision.id = NEW.revision_id
         AND revision.tenant_id = NEW.tenant_id
         AND NOT EXISTS (
           SELECT 1 FROM accepted_plate_heads head
            WHERE head.current_revision_id = revision.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM accepted_plate_revisions newer
            WHERE newer.tenant_id = revision.tenant_id
              AND newer.profile_id = revision.profile_id
              AND newer.revision_number > revision.revision_number
         )
    ) THEN
      RAISE EXCEPTION 'Accepted Plate ownership violation';
    END IF;
    RETURN NEW;
  END
  $function$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION validate_accepted_plate_unit_insert()
  RETURNS trigger AS $function$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
        FROM accepted_plates plate
        JOIN accepted_plate_revisions plate_revision
          ON plate_revision.id = plate.revision_id
         AND plate_revision.tenant_id = plate.tenant_id
        JOIN plan_revision_required_units mapping
          ON mapping.revision_id = plate_revision.plan_revision_id
         AND mapping.tenant_id = plate_revision.tenant_id
         AND mapping.required_unit_token = NEW.required_unit_token
        JOIN plan_revision_parts part
          ON part.id = mapping.revision_part_id
         AND part.revision_id = mapping.revision_id
         AND part.tenant_id = mapping.tenant_id
       WHERE plate.tenant_id = NEW.tenant_id
         AND plate.revision_id = NEW.revision_id
         AND plate.plate_id = NEW.plate_id
         AND part.included = TRUE
         AND NOT EXISTS (
           SELECT 1 FROM accepted_plate_heads head
            WHERE head.current_revision_id = plate_revision.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM accepted_plate_revisions newer
            WHERE newer.tenant_id = plate_revision.tenant_id
              AND newer.profile_id = plate_revision.profile_id
              AND newer.revision_number > plate_revision.revision_number
         )
    ) THEN
      RAISE EXCEPTION 'Accepted Plate unit ownership violation';
    END IF;
    RETURN NEW;
  END
  $function$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION enforce_accepted_plate_revision_immutable()
  RETURNS trigger AS $function$
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      IF OLD.undo_from_revision_id IS NOT NULL
        AND NEW.undo_from_revision_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM accepted_plate_revisions predecessor
           WHERE predecessor.id = OLD.undo_from_revision_id
        )
        AND to_jsonb(NEW) - 'undo_from_revision_id' = to_jsonb(OLD) - 'undo_from_revision_id'
      THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'Accepted Plate revision is immutable';
    END IF;
    IF EXISTS (
      SELECT 1 FROM build_profiles profile
       WHERE profile.id = OLD.profile_id AND profile.tenant_id = OLD.tenant_id
    ) THEN
      RAISE EXCEPTION 'Accepted Plate revision is immutable';
    END IF;
    RETURN OLD;
  END
  $function$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION enforce_accepted_plate_immutable()
  RETURNS trigger AS $function$
  BEGIN
    IF TG_OP = 'UPDATE' OR EXISTS (
      SELECT 1
        FROM accepted_plate_revisions revision
        JOIN build_profiles profile
          ON profile.id = revision.profile_id AND profile.tenant_id = revision.tenant_id
       WHERE revision.id = OLD.revision_id AND revision.tenant_id = OLD.tenant_id
    ) THEN
      RAISE EXCEPTION 'Accepted Plate is immutable';
    END IF;
    RETURN OLD;
  END
  $function$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION enforce_accepted_plate_unit_immutable()
  RETURNS trigger AS $function$
  BEGIN
    IF TG_OP = 'UPDATE' OR EXISTS (
      SELECT 1
        FROM accepted_plate_revisions revision
        JOIN build_profiles profile
          ON profile.id = revision.profile_id AND profile.tenant_id = revision.tenant_id
       WHERE revision.id = OLD.revision_id AND revision.tenant_id = OLD.tenant_id
    ) THEN
      RAISE EXCEPTION 'Accepted Plate unit is immutable';
    END IF;
    RETURN OLD;
  END
  $function$ LANGUAGE plpgsql`,
  `DO $block$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_accepted_plate_revisions_ownership_insert') THEN
        CREATE TRIGGER trg_accepted_plate_revisions_ownership_insert
          BEFORE INSERT ON accepted_plate_revisions
          FOR EACH ROW EXECUTE FUNCTION validate_accepted_plate_revision_insert();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_accepted_plate_heads_ownership_write') THEN
        CREATE TRIGGER trg_accepted_plate_heads_ownership_write
          BEFORE INSERT OR UPDATE ON accepted_plate_heads
          FOR EACH ROW EXECUTE FUNCTION validate_accepted_plate_head_write();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_accepted_plates_ownership_insert') THEN
        CREATE TRIGGER trg_accepted_plates_ownership_insert
          BEFORE INSERT ON accepted_plates
          FOR EACH ROW EXECUTE FUNCTION validate_accepted_plate_insert();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_accepted_plate_units_ownership_insert') THEN
        CREATE TRIGGER trg_accepted_plate_units_ownership_insert
          BEFORE INSERT ON accepted_plate_units
          FOR EACH ROW EXECUTE FUNCTION validate_accepted_plate_unit_insert();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_accepted_plate_revisions_immutable_write') THEN
        CREATE TRIGGER trg_accepted_plate_revisions_immutable_write
          BEFORE UPDATE OR DELETE ON accepted_plate_revisions
          FOR EACH ROW EXECUTE FUNCTION enforce_accepted_plate_revision_immutable();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_accepted_plates_immutable_write') THEN
        CREATE TRIGGER trg_accepted_plates_immutable_write
          BEFORE UPDATE OR DELETE ON accepted_plates
          FOR EACH ROW EXECUTE FUNCTION enforce_accepted_plate_immutable();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_accepted_plate_units_immutable_write') THEN
        CREATE TRIGGER trg_accepted_plate_units_immutable_write
          BEFORE UPDATE OR DELETE ON accepted_plate_units
          FOR EACH ROW EXECUTE FUNCTION enforce_accepted_plate_unit_immutable();
      END IF;
    END
  $block$`,
  "ALTER TABLE accepted_plate_revisions ADD COLUMN IF NOT EXISTS undo_from_revision_id INTEGER REFERENCES accepted_plate_revisions(id) ON DELETE SET NULL",
  "ALTER TABLE accepted_plate_units ADD COLUMN IF NOT EXISTS placement TEXT NOT NULL DEFAULT 'auto' CHECK (placement IN ('auto', 'manual', 'unplaced'))",
  "ALTER TABLE accepted_plate_units ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE",
];

export class PostgresDatabase {
  private pool: pg.Pool | null = null;
  drizzle: PostgresDrizzleDb | null = null;
  readonly dataDir: string;
  readonly reposDir: string;
  readonly sourcesDir: string;

  constructor(
    readonly databaseUrl: string,
    dataDir: string,
  ) {
    this.dataDir = dataDir;
    this.reposDir = join(dataDir, "repos");
    this.sourcesDir = join(dataDir, "sources");
  }

  async connect(): Promise<void> {
    this.pool = new pg.Pool({ connectionString: this.databaseUrl, max: 10 });
    this.drizzle = drizzle(this.pool, { schema });
    registerPostgresSyncQuery(this.drizzle, (query) =>
      runPostgresSyncQuery(this.databaseUrl, query),
    );
    await this.runMigrations();
  }

  private async runMigrations(): Promise<void> {
    if (!this.pool) throw new Error("Database not connected");
    const sql = readFileSync(MIGRATION_SQL, "utf8");
    for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
      await this.pool.query(stmt);
    }
    for (const stmt of postgresPostInitMigrations) {
      await this.pool.query(stmt);
    }
    const client = await this.pool.connect();
    try {
      await repairSourceRevisionTenantOwnershipPostgres(client);
      await removeLegacyPrintPlansAndStampPostgres(client);
      await client.query(
        `INSERT INTO app_settings (tenant_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
        ["default", schema.schemaVersionKey, String(schema.currentSchemaVersion)],
      );
    } finally {
      client.release();
    }
  }

  async ping(): Promise<boolean> {
    if (!this.pool) return false;
    await this.pool.query("SELECT 1");
    return true;
  }

  backfillCurrentRequiredUnitSets(
    _dependencies: RequiredUnitBackfillDependencies = {},
  ): RequiredUnitBackfillCommandResult {
    return { kind: "transaction_unavailable" };
  }

  async close(): Promise<void> {
    if (this.drizzle) unregisterPostgresSyncQuery(this.drizzle);
    await this.pool?.end();
    this.pool = null;
    this.drizzle = null;
  }
}

export function getPgDb(db: PostgresDatabase): PostgresDrizzleDb {
  if (!db.drizzle) throw new Error("Database not connected");
  return db.drizzle;
}
