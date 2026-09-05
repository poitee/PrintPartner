import { mkdirSync } from "node:fs";
import type { AppRepository, SchemaTables } from "./repository.js";
import { getDb, SqliteDatabase } from "./client.js";
import { PostgresDatabase } from "./client-postgres.js";
import { AppRepository as Repo } from "./repository.js";
import * as pgSchema from "./schema-pg.js";
import * as sqliteSchema from "./schema.js";
import {
  ISOLATED_SOURCE_FILESYSTEM,
  TRUSTED_SINGLE_USER_SOURCE_FILESYSTEM,
  type SourceFilesystemPolicy,
} from "../services/source-filesystem-policy.js";

/** App data: SQLite (self-host) or Postgres (saas + DATABASE_URL). */
export type DatabaseBundle = {
  driver: "sqlite" | "postgres";
  sqlite: SqliteDatabase | null;
  postgres: PostgresDatabase | null;
  repository: AppRepository;
  reposDir: string;
  sourcesDir: string;
  dataDir: string;
  sourceFilesystemPolicy: SourceFilesystemPolicy;
};

export function openDatabaseBundle(
  dataDir: string,
  databaseUrl: string | null,
  deployMode: "self-host" | "saas" = "self-host",
): DatabaseBundle {
  mkdirSync(dataDir, { recursive: true });
  const usePostgres = deployMode === "saas" && Boolean(databaseUrl);
  const sourceFilesystemPolicy =
    deployMode === "saas"
      ? ISOLATED_SOURCE_FILESYSTEM
      : TRUSTED_SINGLE_USER_SOURCE_FILESYSTEM;

  if (usePostgres && databaseUrl) {
    const postgres = new PostgresDatabase(databaseUrl, dataDir);
    return {
      driver: "postgres",
      sqlite: null,
      postgres,
      // Repository is created after postgres.connect() in connectBundle().
      repository: null as unknown as AppRepository,
      reposDir: postgres.reposDir,
      sourcesDir: postgres.sourcesDir,
      dataDir,
      sourceFilesystemPolicy,
    };
  }

  const sqlite = new SqliteDatabase(dataDir);
  sqlite.connect();
  return {
    driver: "sqlite",
    sqlite,
    postgres: databaseUrl ? new PostgresDatabase(databaseUrl, dataDir) : null,
    repository: new Repo(getDb(sqlite), undefined, sqlite.reposDir, undefined, {
      sourceFilesystemPolicy,
    }),
    reposDir: sqlite.reposDir,
    sourcesDir: sqlite.sourcesDir,
    dataDir,
    sourceFilesystemPolicy,
  };
}

export function repositoryForTenant(bundle: DatabaseBundle, tenantId: string): AppRepository {
  if (bundle.driver === "postgres") {
    if (!bundle.postgres?.drizzle) {
      throw new Error("Postgres database not connected");
    }
    return new Repo(
      bundle.postgres.drizzle,
      tenantId,
      bundle.reposDir,
      pgSchema as unknown as SchemaTables,
      { sourceFilesystemPolicy: bundle.sourceFilesystemPolicy },
    );
  }
  if (!bundle.sqlite) throw new Error("SQLite bundle not connected");
  return new Repo(
    getDb(bundle.sqlite),
    tenantId,
    bundle.sqlite.reposDir,
    sqliteSchema as unknown as SchemaTables,
    { sourceFilesystemPolicy: bundle.sourceFilesystemPolicy },
  );
}

export async function connectBundle(bundle: DatabaseBundle): Promise<void> {
  if (bundle.driver === "postgres" && bundle.postgres) {
    await bundle.postgres.connect();
    bundle.repository = new Repo(
      bundle.postgres.drizzle!,
      "default",
      bundle.reposDir,
      pgSchema as unknown as SchemaTables,
      { sourceFilesystemPolicy: bundle.sourceFilesystemPolicy },
    );
    return;
  }
  if (bundle.sqlite && !bundle.sqlite.drizzle) {
    bundle.sqlite.connect();
    bundle.repository = new Repo(
      getDb(bundle.sqlite),
      undefined,
      bundle.reposDir,
      sqliteSchema as unknown as SchemaTables,
      { sourceFilesystemPolicy: bundle.sourceFilesystemPolicy },
    );
  }
  if (bundle.postgres && !bundle.postgres.drizzle) {
    await bundle.postgres.connect();
  }
}

export async function closeBundle(bundle: DatabaseBundle): Promise<void> {
  bundle.sqlite?.close();
  if (bundle.postgres) await bundle.postgres.close();
}

export async function pingBundle(bundle: DatabaseBundle): Promise<{
  app: boolean;
  postgres: boolean | null;
}> {
  let app = false;
  try {
    if (bundle.repository) {
      app = await bundle.repository.ping();
    }
  } catch {
    app = false;
  }
  const postgres = bundle.postgres ? await bundle.postgres.ping() : null;
  return { app, postgres };
}

export { pgSchema, sqliteSchema };
