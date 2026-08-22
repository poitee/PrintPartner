import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createSelfHostPorts } from "./adapters/self-host/index.js";
import { createIntegrationPort } from "./integrations/store.js";
import { spoolmanAdapter } from "./integrations/adapters/spoolman.js";

describe("GET /filaments/catalog Spoolman merge", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PRINT_PARTNER_DATA_DIR;
    delete process.env.PRINT_PARTNER_API_KEY;
  });

  it("merges spoolman_colors when Spoolman returns vendor objects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const path = String(url);
        if (path.includes("/api/v1/filament")) {
          return {
            ok: true,
            json: async () => [
              {
                id: 1,
                name: "Red",
                vendor: { id: 2, name: "Polymaker" },
                material: "PLA",
                color_hex: "#ff0000",
              },
            ],
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    const dir = mkdtempSync(join(tmpdir(), "pp-catalog-sm-"));
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
    ports.repository.setSetting("default_spoolman_integration_id", created.id);

    const app = await buildApp(config, ports);

    const res = await app.inject({ method: "GET", url: "/filaments/catalog" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      spoolman_colors?: Array<{ combo_label: string; id: string }>;
      spoolman_status?: string;
      spoolman_error?: string | null;
    };
    expect(body.spoolman_status).toBe("ok");
    expect(body.spoolman_error).toBeFalsy();
    expect(body.spoolman_colors).toHaveLength(1);
    expect(body.spoolman_colors![0]!.id).toBe(`spoolman:${created.id}:filament:1`);
    expect(body.spoolman_colors![0]!.combo_label).toContain("Polymaker");

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("surfaces spoolman_error when Spoolman filaments request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
      })),
    );

    const dir = mkdtempSync(join(tmpdir(), "pp-catalog-sm-err-"));
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
    ports.repository.setSetting("default_spoolman_integration_id", created.id);

    const app = await buildApp(config, ports);
    const res = await app.inject({ method: "GET", url: "/filaments/catalog" });
    const body = res.json() as {
      spoolman_colors?: unknown[];
      spoolman_status?: string;
      spoolman_error?: string;
    };
    expect(body.spoolman_status).toBe("error");
    expect(body.spoolman_error).toMatch(/HTTP 503/);
    expect(body.spoolman_colors).toEqual([]);

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
