import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";

const cleanup: Array<() => Promise<void> | void> = [];
const previousDataDir = process.env.PRINT_PARTNER_DATA_DIR;

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) {
    await fn();
  }
  if (previousDataDir === undefined) delete process.env.PRINT_PARTNER_DATA_DIR;
  else process.env.PRINT_PARTNER_DATA_DIR = previousDataDir;
});

async function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), "pp-slicer-instances-route-"));
  process.env.PRINT_PARTNER_DATA_DIR = dir;
  delete process.env.PRINT_PARTNER_API_KEY;
  const config = loadConfig();
  const ports = createSelfHostPorts(dir);
  await ports.db.connect();
  const app = await buildApp(config, ports);
  cleanup.push(async () => {
    await app.close();
    await ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, repo: ports.repository! };
}

describe("slicer instance routes", () => {
  it("startup seeds three stock instances", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/slicer-instances" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { instances: Array<{ kind: string }> };
    expect(body.instances).toHaveLength(3);
    expect(body.instances.map((i) => i.kind).sort()).toEqual(["bambu", "orca", "prusa"]);
  });

  it("creates and updates an instance", async () => {
    const { app } = await makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/slicer-instances",
      payload: {
        name: "Extra Orca",
        kind: "orca",
        dialect: "orca_json",
        gui_url: "http://orca2.home",
        watch_path: "/slicer-profiles/orca2",
      },
    });
    expect(created.statusCode).toBe(201);
    const row = created.json() as { id: string; enabled: boolean };
    expect(row.enabled).toBe(true);

    const updated = await app.inject({
      method: "PUT",
      url: `/slicer-instances/${row.id}`,
      payload: { enabled: false, name: "Orca Off" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ name: "Orca Off", enabled: false });
  });

  it("rejects non-boolean enabled", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/slicer-instances",
      payload: {
        name: "Bad",
        kind: "orca",
        enabled: "yes",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects javascript: gui_url", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/slicer-instances",
      payload: {
        name: "Bad URL",
        kind: "orca",
        gui_url: "javascript:alert(1)",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects enabled custom without watch_path", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/slicer-instances",
      payload: {
        name: "Custom",
        kind: "custom",
        dialect: "orca_json",
        enabled: true,
        watch_path: "",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("seed-defaults is idempotent after startup seed", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "POST", url: "/slicer-instances/seed-defaults" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ inserted: 0 });
  });

  it("deletes an instance", async () => {
    const { app } = await makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/slicer-instances",
      payload: { name: "Temp Prusa", kind: "prusa" },
    });
    const id = (created.json() as { id: string }).id;
    const del = await app.inject({ method: "DELETE", url: `/slicer-instances/${id}` });
    expect(del.statusCode).toBe(204);
    const list = await app.inject({ method: "GET", url: "/slicer-instances" });
    const body = list.json() as { instances: Array<{ id: string }> };
    expect(body.instances.find((i) => i.id === id)).toBeUndefined();
  });

  it("seeds docker image defaults for stock orca", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/slicer-instances" });
    const body = res.json() as { instances: Array<{ kind: string; image: string | null }> };
    expect(body.instances.find((i) => i.kind === "orca")?.image).toContain("orcaslicer");
  });
});
