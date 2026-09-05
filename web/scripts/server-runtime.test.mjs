import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import pg from "pg";
import { PostgresDatabase } from "../apps/server/dist/current/db/client-postgres.js";

test("published server reads its PostgreSQL migration before opening a database connection", async (t) => {
  const reachedDatabase = new Error("migration reached database boundary");
  const query = t.mock.method(pg.Pool.prototype, "query", async (sql) => {
    assert.match(sql, /^CREATE TABLE IF NOT EXISTS projects\s*\(/);
    throw reachedDatabase;
  });
  const database = new PostgresDatabase("postgresql://unused", tmpdir());
  try {
    await assert.rejects(database.connect(), (error) => error === reachedDatabase);
    assert.equal(query.mock.callCount(), 1);
  } finally {
    await database.close();
  }
});
