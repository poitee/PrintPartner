import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createSelfHostPorts } from "./adapters/self-host/index.js";
import { createIntegrationPort } from "./integrations/store.js";
import { spoolmanAdapter } from "./integrations/adapters/spoolman.js";

describe("GET /api/v1/integrations/:id/spoolman/spools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PRINT_PARTNER_DATA_DIR;
    delete process.env.PRINT_PARTNER_API_KEY;
  });

  it("returns spools for a Spoolman integration", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const path = String(url);
        if (path.includes("/api/v1/spool")) {
          return {
            ok: true,
            json: async () => [
              {
                id: 3,
                filament_id: 7,
                remaining_weight: 412.5,
                location: "Shelf A",
              },
            ],
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    const dir = mkdtempSync(join(tmpdir(), "pp-spoolman-spools-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    delete process.env.PRINT_PARTNER_API_KEY;

    const config = loadConfig();
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const integrations = createIntegrationPort({
      repo: ports.repository,
      getAdapter: (type) => (type === "spoolman" ? spoolmanAdapter : undefined),
    });
    const created = integrations.create({
      type: "spoolman",
      name: "Workshop",
      config: { base_url: "http://192.168.1.50:7912", enabled: true },
    });

    const app = await buildApp(config, ports);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/${created.id}/spoolman/spools`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      spools: Array<{ id: number; filament_id: number; remaining_weight: number; location: string }>;
    };
    expect(body.spools).toHaveLength(1);
    expect(body.spools[0]!.id).toBe(3);
    expect(body.spools[0]!.filament_id).toBe(7);
    expect(body.spools[0]!.remaining_weight).toBe(412.5);
    expect(body.spools[0]!.location).toBe("Shelf A");

    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns JSON (not HTML) for flat /integrations path (not registered)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-spoolman-flat-404-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    delete process.env.PRINT_PARTNER_API_KEY;

    const config = loadConfig();
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();

    const app = await buildApp(config, ports);

    const res = await app.inject({
      method: "GET",
      url: "/integrations/missing/spoolman/spools",
      headers: { accept: "*/*" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body).not.toMatch(/<!doctype/i);

    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
