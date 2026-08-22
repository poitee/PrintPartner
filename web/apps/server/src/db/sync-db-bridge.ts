import type { DrizzleDb } from "./client.js";
import type { PostgresDrizzleDb } from "./client-postgres.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
type SelectedField = { path: string[]; field: unknown };
// This private Drizzle API is intentionally isolated here. The focused bridge test must
// pass before upgrading drizzle-orm because `_prepare` and this utility are not stable APIs.
const { mapResultRow } = require("drizzle-orm/utils") as {
  mapResultRow: (
    fields: SelectedField[],
    row: unknown[],
    joinsNotNullableMap?: Record<string, boolean>,
  ) => unknown;
};

export type AppDrizzleDb = DrizzleDb | PostgresDrizzleDb;

export type PostgresSyncQuery = {
  sql: string;
  params: unknown[];
  arrayMode?: boolean;
};

export type PostgresSyncResult = {
  rows: unknown[];
  rowCount: number;
};

export type PostgresSyncQueryFn = (query: PostgresSyncQuery) => PostgresSyncResult;

export const POSTGRES_SYNC_MAX_RESULT_ROWS = 10_000;
export const POSTGRES_SYNC_MAX_RESULT_BYTES = 8 * 1024 * 1024;

const postgresSyncQueries = new WeakMap<object, PostgresSyncQueryFn>();

export function registerPostgresSyncQuery(
  db: AppDrizzleDb,
  query: PostgresSyncQueryFn,
): void {
  postgresSyncQueries.set(db, query);
}

export function unregisterPostgresSyncQuery(db: AppDrizzleDb): void {
  postgresSyncQueries.delete(db);
}

/** True when Drizzle exposes sync SQLite-style builders (`.all` / sync `.transaction`). */
export function isSyncSqliteDrizzle(db: AppDrizzleDb): boolean {
  const candidate = db as DrizzleDb;
  return (
    typeof candidate.run === "function" &&
    typeof candidate.all === "function" &&
    typeof candidate.get === "function"
  );
}

/** In-process serialization for settings RMW when sync DB transactions are unavailable (Postgres). */
let settingsMutationLocked = false;

export function runSerializedSettingsMutation<T>(fn: () => T): T {
  if (settingsMutationLocked) {
    // Nested call on the same stack (e.g. helper → transaction → helper → transaction).
    return fn();
  }
  settingsMutationLocked = true;
  try {
    return fn();
  } finally {
    settingsMutationLocked = false;
  }
}

function assertPostgresSyncResultWithinLimits(result: PostgresSyncResult): void {
  if (result.rows.length > POSTGRES_SYNC_MAX_RESULT_ROWS) {
    throw new Error(
      `Postgres sync query result row limit of ${POSTGRES_SYNC_MAX_RESULT_ROWS.toLocaleString("en-US")} exceeded (received ${result.rows.length.toLocaleString("en-US")})`,
    );
  }
  const resultBytes = Buffer.byteLength(
    JSON.stringify({ rows: result.rows, rowCount: result.rowCount }),
    "utf8",
  );
  if (resultBytes > POSTGRES_SYNC_MAX_RESULT_BYTES) {
    throw new Error(
      `Postgres sync query result byte limit of 8 MiB exceeded (received ${resultBytes.toLocaleString("en-US")} bytes)`,
    );
  }
}

function runPostgresBuilder(
  builder: object,
  query: PostgresSyncQueryFn,
  mode: "all" | "get" | "run",
): unknown {
  const toSQL = Reflect.get(builder, "toSQL");
  if (typeof toSQL !== "function") {
    throw new Error("Postgres query builder does not expose toSQL()");
  }
  const prepare = Reflect.get(builder, "_prepare");
  const prepared =
    typeof prepare === "function"
      ? (prepare.call(builder) as {
          fields?: SelectedField[];
          joinsNotNullableMap?: Record<string, boolean>;
          customResultMapper?: (rows: unknown[][]) => unknown[];
        })
      : null;
  const compiled = toSQL.call(builder) as PostgresSyncQuery;
  const needsArrayRows = Boolean(prepared?.fields || prepared?.customResultMapper);
  const result = query({ ...compiled, arrayMode: needsArrayRows });
  assertPostgresSyncResultWithinLimits(result);
  const rows = prepared?.customResultMapper
    ? prepared.customResultMapper(result.rows as unknown[][])
    : prepared?.fields
      ? (result.rows as unknown[][]).map((row) =>
          mapResultRow(prepared.fields!, row, prepared.joinsNotNullableMap),
        )
      : result.rows;
  if (mode === "all") return rows;
  if (mode === "get") return rows[0];
  return { changes: result.rowCount };
}

function wrapBuilder(builder: unknown, postgresQuery?: PostgresSyncQueryFn): unknown {
  if (!builder || (typeof builder !== "object" && typeof builder !== "function")) {
    return builder;
  }

  return new Proxy(builder as object, {
    get(target, prop, receiver) {
      if (prop === "all") {
        return () => {
          const native = Reflect.get(target, "all", receiver);
          if (typeof native === "function") return native.call(target);
          if (postgresQuery) return runPostgresBuilder(target, postgresQuery, "all");
          throw new Error("Query builder is not awaitable");
        };
      }
      if (prop === "get") {
        return () => {
          const native = Reflect.get(target, "get", receiver);
          if (typeof native === "function") return native.call(target);
          if (postgresQuery) return runPostgresBuilder(target, postgresQuery, "get");
          throw new Error("Query builder is not awaitable");
        };
      }
      if (prop === "run") {
        return () => {
          const native = Reflect.get(target, "run", receiver);
          if (typeof native === "function") return native.call(target);
          if (postgresQuery) return runPostgresBuilder(target, postgresQuery, "run");
          throw new Error("Query builder is not runnable");
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return (...args: unknown[]) =>
          wrapBuilder(value.apply(target, args), postgresQuery);
      }
      return value;
    },
  });
}

/** Expose sync Drizzle API (.all/.get/.run) for both SQLite and Postgres drivers. */
export function asSyncDb(db: AppDrizzleDb): DrizzleDb {
  if (!db || (typeof db !== "object" && typeof db !== "function")) {
    throw new Error("Database not connected");
  }
  if (isSyncSqliteDrizzle(db)) {
    return db as DrizzleDb;
  }
  const postgresQuery = postgresSyncQueries.get(db as object);
  if (!postgresQuery) {
    throw new Error("Postgres synchronous query bridge is not registered");
  }
  return new Proxy(db as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop);
      if (typeof value === "function") {
        return (...args: unknown[]) =>
          wrapBuilder(value.apply(target, args), postgresQuery);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as DrizzleDb;
}
