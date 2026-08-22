import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";

async function makeApp(dir: string) {
  process.env.PRINT_PARTNER_DATA_DIR = dir;
  delete process.env.PRINT_PARTNER_API_KEY;
  const config = loadConfig();
  const ports = createSelfHostPorts(dir);
  await ports.db.connect();
  const app = await buildApp(config, ports);
  return { app, ports };
}

async function createSource(app: Awaited<ReturnType<typeof buildApp>>, name: string) {
  const res = await app.inject({
    method: "POST",
    url: "/sources",
    payload: { name, url: `https://github.com/a/${name}`, source_kind: "self" },
  });
  return (res.json() as { id: number }).id;
}

describe("POST /sources/bulk-category", () => {
  afterEach(() => {
    delete process.env.PRINT_PARTNER_DATA_DIR;
  });

  it("assigns a category to many sources in one request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-bulk-cat-"));
    const { app, ports } = await makeApp(dir);

    const ids = await Promise.all([
      createSource(app, "Voron-0"),
      createSource(app, "Voron-2"),
      createSource(app, "Voron-Trident"),
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/sources/bulk-category",
      payload: { source_ids: ids, category: "Voron Printers" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      succeeded: number;
      failed: number;
      updated: Array<{ id: number; category: string | null }>;
    };
    expect(body.succeeded).toBe(3);
    expect(body.failed).toBe(0);
    expect(body.updated.every((s) => s.category === "Voron Printers")).toBe(true);

    for (const id of ids) {
      const check = await app.inject({ method: "GET", url: `/sources/${id}` });
      expect((check.json() as { category: string | null }).category).toBe("Voron Printers");
    }

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("clearing category (null) sets sources back to Uncategorised", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-bulk-cat-clear-"));
    const { app, ports } = await makeApp(dir);

    const ids = await Promise.all([createSource(app, "Klicky-Probe"), createSource(app, "Voron-Tap")]);
    await app.inject({
      method: "POST",
      url: "/sources/bulk-category",
      payload: { source_ids: ids, category: "Probes" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/sources/bulk-category",
      payload: { source_ids: ids, category: null },
    });
    expect(res.statusCode).toBe(200);
    for (const id of ids) {
      const check = await app.inject({ method: "GET", url: `/sources/${id}` });
      expect((check.json() as { category: string | null }).category).toBe(null);
    }

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports per-id failures without aborting the whole batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-bulk-cat-partial-"));
    const { app, ports } = await makeApp(dir);

    const okId = await createSource(app, "Legacy");
    const missingId = okId + 999;

    const res = await app.inject({
      method: "POST",
      url: "/sources/bulk-category",
      payload: { source_ids: [okId, missingId], category: "Mods" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      succeeded: number;
      failed: number;
      results: Array<{ source_id: number; ok: boolean }>;
    };
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.results.find((r) => r.source_id === okId)?.ok).toBe(true);
    expect(body.results.find((r) => r.source_id === missingId)?.ok).toBe(false);

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an empty source_ids array", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-bulk-cat-empty-"));
    const { app, ports } = await makeApp(dir);

    const res = await app.inject({
      method: "POST",
      url: "/sources/bulk-category",
      payload: { source_ids: [], category: "Mods" },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
