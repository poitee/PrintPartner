import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "./schema-pg.js";
import {
  asSyncDb,
  registerPostgresSyncQuery,
  runSerializedSettingsMutation,
  type AppDrizzleDb,
} from "./sync-db-bridge.js";

describe("runSerializedSettingsMutation", () => {
  it("runs the callback and returns its value without Promise/syncAwait", () => {
    expect(runSerializedSettingsMutation(() => 42)).toBe(42);
  });

  it("allows nested calls on the same stack", () => {
    const result = runSerializedSettingsMutation(() =>
      runSerializedSettingsMutation(() => "nested"),
    );
    expect(result).toBe("nested");
  });

  it("releases the lock so a later call can run", () => {
    runSerializedSettingsMutation(() => "first");
    expect(runSerializedSettingsMutation(() => "second")).toBe("second");
  });
});

describe("asSyncDb", () => {
  it("executes Postgres builders through a synchronous query bridge", () => {
    const builder = {
      toSQL: () => ({ sql: "select $1::text as value", params: ["ready"] }),
      then: () => undefined,
    };
    const postgres = {
      select: () => builder,
    } as unknown as AppDrizzleDb;
    registerPostgresSyncQuery(postgres, ({ sql, params }) => {
      expect(sql).toBe("select $1::text as value");
      expect(params).toEqual(["ready"]);
      return { rows: [{ value: "ready" }], rowCount: 1 };
    });

    const query = asSyncDb(postgres).select() as unknown as {
      all: () => Array<{ value: string }>;
    };
    expect(query.all()).toEqual([{ value: "ready" }]);
  });

  it("maps array rows using the current Drizzle prepared-field metadata", () => {
    const postgres = drizzle({} as Pool, { schema });
    registerPostgresSyncQuery(postgres, ({ sql, arrayMode }) => {
      expect(sql).toContain('select "id", "name", "archived_at"');
      expect(arrayMode).toBe(true);
      return { rows: [[7, "Voron", null]], rowCount: 1 };
    });

    // The compatibility adapter deliberately exposes the SQLite-shaped repository
    // type; retain the real Postgres builder type here to exercise Drizzle internals.
    const syncPostgres = asSyncDb(postgres) as unknown as typeof postgres;
    const query = syncPostgres
      .select({
        id: schema.buildProfiles.id,
        name: schema.buildProfiles.name,
        archivedAt: schema.buildProfiles.archivedAt,
      })
      .from(schema.buildProfiles) as unknown as {
      all: () => Array<{ id: number; name: string; archivedAt: string | null }>;
    };

    expect(query.all()).toEqual([
      { id: 7, name: "Voron", archivedAt: null },
    ]);
  });

  it("rejects query results above the explicit row ceiling", () => {
    const builder = {
      toSQL: () => ({ sql: "select value from oversized", params: [] }),
      then: () => undefined,
    };
    const postgres = {
      select: () => builder,
    } as unknown as AppDrizzleDb;
    registerPostgresSyncQuery(postgres, () => ({
      rows: Array.from({ length: 10_001 }, (_, value) => ({ value })),
      rowCount: 10_001,
    }));

    const query = asSyncDb(postgres).select() as unknown as {
      all: () => unknown[];
    };
    expect(() => query.all()).toThrow(/result row limit.*10,000/i);
  });

  it("rejects serialized query results above the explicit byte ceiling", () => {
    const builder = {
      toSQL: () => ({ sql: "select value from oversized", params: [] }),
      then: () => undefined,
    };
    const postgres = {
      select: () => builder,
    } as unknown as AppDrizzleDb;
    registerPostgresSyncQuery(postgres, () => ({
      rows: [{ value: "x".repeat(8 * 1024 * 1024) }],
      rowCount: 1,
    }));

    const query = asSyncDb(postgres).select() as unknown as {
      all: () => unknown[];
    };
    expect(() => query.all()).toThrow(/result byte limit.*8 MiB/i);
  });
});
