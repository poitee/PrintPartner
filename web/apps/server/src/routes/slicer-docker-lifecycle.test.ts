import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import {
  createFakeDockerAdapter,
  registerSlicerInstanceRoutes,
} from "./slicer-instances.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

async function makeDockerApp(deployMode: "self-host" | "saas" = "self-host") {
  const dir = mkdtempSync(join(tmpdir(), "pp-slicer-docker-route-"));
  const sqlite = new SqliteDatabase(dir);
  sqlite.connect();
  const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
  repo.seedStockSlicerInstancesIfEmpty();
  const docker = createFakeDockerAdapter();
  const app = Fastify();
  await registerSlicerInstanceRoutes(app, { repo, deployMode, docker });
  cleanup.push(() => {
    void app.close();
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, repo };
}

describe("slicer docker lifecycle with fake adapter", () => {
  it("starts and stops a stock instance", async () => {
    const { app, repo } = await makeDockerApp();
    const orca = repo.listSlicerInstances().find((r) => r.kind === "orca")!;
    const start = await app.inject({
      method: "POST",
      url: `/slicer-instances/${orca.id}/docker-start`,
    });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ status: { state: "running" } });

    const stop = await app.inject({
      method: "POST",
      url: `/slicer-instances/${orca.id}/docker-stop`,
    });
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toMatchObject({ status: { state: "stopped" } });

    const logs = await app.inject({
      method: "GET",
      url: `/slicer-instances/${orca.id}/docker-logs`,
    });
    expect(logs.statusCode).toBe(200);
    expect((logs.json() as { lines: string[] }).lines.length).toBeGreaterThan(0);
  });

  it("returns 403 in saas mode", async () => {
    const { app, repo } = await makeDockerApp("saas");
    const orca = repo.listSlicerInstances().find((r) => r.kind === "orca")!;
    const res = await app.inject({
      method: "POST",
      url: `/slicer-instances/${orca.id}/docker-start`,
    });
    expect(res.statusCode).toBe(403);
  });
});
