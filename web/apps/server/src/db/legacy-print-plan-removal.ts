import type Database from "better-sqlite3";

export const LEGACY_PRINT_PLAN_REMOVAL_SCHEMA_VERSION = 28;

export const SQLITE_LEGACY_PRINT_PLAN_REMOVAL = `DELETE FROM app_settings
 WHERE substr(key, 1, 11) = 'print_plan:'
   AND length(key) > 11
   AND substr(key, 12) NOT GLOB '*[^0-9]*'`;

export const POSTGRES_LEGACY_PRINT_PLAN_REMOVAL =
  "DELETE FROM app_settings WHERE key ~ '^print_plan:[0-9]+$'";

const POSTGRES_SCHEMA_VERSION_STAMP = `INSERT INTO app_settings (tenant_id, key, value)
 VALUES ($1, $2, $3)
 ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`;

type PostgresMigrationClient = {
  query(sql: string, params?: unknown[]): Promise<unknown>;
};

export function removeLegacyPrintPlansAndStampSqlite(
  sqlite: Database.Database,
  afterRemoval?: (sqlite: Database.Database) => void,
): void {
  const migrate = sqlite.transaction(() => {
    sqlite.exec(SQLITE_LEGACY_PRINT_PLAN_REMOVAL);
    afterRemoval?.(sqlite);
    sqlite.prepare(
      `INSERT INTO app_settings (tenant_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`,
    ).run("default", "schema_version", String(LEGACY_PRINT_PLAN_REMOVAL_SCHEMA_VERSION));
  });
  migrate.immediate();
}

export async function removeLegacyPrintPlansAndStampPostgres(
  client: PostgresMigrationClient,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(POSTGRES_LEGACY_PRINT_PLAN_REMOVAL);
    await client.query(POSTGRES_SCHEMA_VERSION_STAMP, [
      "default",
      "schema_version",
      String(LEGACY_PRINT_PLAN_REMOVAL_SCHEMA_VERSION),
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
