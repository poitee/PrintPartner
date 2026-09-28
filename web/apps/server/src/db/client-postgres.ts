import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as schema from "./schema-pg.js";
import { currentSchemaVersion } from "./schema.js";
import { postgresPostInitMigrations } from "./migrations-pg.js";
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
import { assertUpgradableSchemaVersion } from "./upgrade-guard.js";

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
    assertUpgradableSchemaVersion(await this.readSchemaVersion());
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
      await client.query(
        `INSERT INTO app_settings (tenant_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
        ["default", schema.schemaVersionKey, String(currentSchemaVersion)],
      );
    } finally {
      client.release();
    }
  }

  private async readSchemaVersion(): Promise<number> {
    if (!this.pool) throw new Error("Database not connected");
    const table = await this.pool.query("SELECT to_regclass('app_settings') AS name");
    if (table.rows[0]?.name == null) return 0;
    const row = await this.pool.query(
      "SELECT value FROM app_settings WHERE tenant_id = $1 AND key = $2",
      ["default", schema.schemaVersionKey],
    );
    const value: unknown = row.rows[0]?.value;
    if (value == null) return 0;
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
      throw new Error(`Invalid database schema version: ${String(value)}`);
    }
    return Number(value);
  }

  async ping(): Promise<boolean> {
    if (!this.pool) return false;
    await this.pool.query("SELECT 1");
    return true;
  }

  async close(): Promise<void> {
    if (this.drizzle) unregisterPostgresSyncQuery(this.drizzle);
    await this.pool?.end();
    this.pool = null;
    this.drizzle = null;
  }
}
