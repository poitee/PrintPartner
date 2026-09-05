import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import process from "node:process";
import test from "node:test";
import { URL } from "node:url";
import pg from "pg";
import { PostgresDatabase } from "../apps/server/dist/current/db/client-postgres.js";

test("published server accepts the application's Docker release identity", () => {
  const require = createRequire(import.meta.url);
  const { version } = require("../package.json");
  const configUrl = new URL("../apps/server/dist/current/config.js", import.meta.url).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { loadConfig } from ${JSON.stringify(configUrl)};
    assert.equal(loadConfig().releaseIdentity.version, ${JSON.stringify(version)});
  `], {
    env: { ...process.env, PP_VERSION: `${version}-web`, PP_TAG: `v${version}` },
    stdio: "pipe",
  });
});

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
