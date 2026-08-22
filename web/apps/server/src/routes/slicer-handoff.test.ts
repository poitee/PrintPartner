import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { registerSlicerHandoffRoutes } from "./slicer-handoff.js";
import type { ServerConfig } from "../config.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function minimalConfig(exchangeDir: string): ServerConfig {
  return { exchangeDir } as ServerConfig;
}

describe("slicer handoff exchange-status", () => {
  it("reports ready when exchange dir is writable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-exchange-"));
    const app = Fastify();
    const sqliteDir = mkdtempSync(join(tmpdir(), "pp-handoff-db-"));
    const sqlite = new SqliteDatabase(sqliteDir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    await registerSlicerHandoffRoutes(app, {
      repo,
      config: minimalConfig(dir),
      exportsDir: join(dir, "exports"),
      dataDir: dir,
      reposDir: sqlite.reposDir,
    });
    cleanup.push(() => {
      void app.close();
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(sqliteDir, { recursive: true, force: true });
    });

    const res = await app.inject({ method: "GET", url: "/slicer-handoff/exchange-status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ready: true, code: "ready" });
  });

  it("reports not ready when exchange dir is missing", async () => {
    const logLines: string[] = [];
    const app = Fastify({
      logger: {
        level: "warn",
        stream: { write: (line) => logLines.push(line) },
      },
    });
    const sqliteDir = mkdtempSync(join(tmpdir(), "pp-handoff-db2-"));
    const sqlite = new SqliteDatabase(sqliteDir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    await registerSlicerHandoffRoutes(app, {
      repo,
      config: minimalConfig("/definitely/missing/exchange-pp"),
      exportsDir: join(sqliteDir, "exports"),
      dataDir: sqliteDir,
      reposDir: sqlite.reposDir,
    });
    cleanup.push(() => {
      void app.close();
      sqlite.close();
      rmSync(sqliteDir, { recursive: true, force: true });
    });

    const res = await app.inject({ method: "GET", url: "/slicer-handoff/exchange-status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ready: false, code: "unavailable" });
    expect(res.body).not.toContain("/definitely/missing/exchange-pp");
    expect(logLines.join("\n")).not.toContain("/definitely/missing/exchange-pp");
  });
});
