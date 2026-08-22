import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createSelfHostPorts } from "./adapters/self-host/index.js";

describe("Plan API versions", () => {
  it("serves accepted flat and v2 Plan summaries and numeric v1 summaries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-apiv1-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    delete process.env.PRINT_PARTNER_API_KEY;

    const config = loadConfig();
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    ports.repository.createProfile("Plan A");

    const app = await buildApp(config, ports);
    const flat = await app.inject({ method: "GET", url: "/plans" });
    const v1 = await app.inject({ method: "GET", url: "/api/v1/plans" });
    const v2 = await app.inject({ method: "GET", url: "/api/v2/plans" });

    expect(flat.statusCode).toBe(200);
    expect(v1.statusCode).toBe(200);
    expect(v2.statusCode).toBe(200);
    expect(v2.json()).toEqual(flat.json());
    expect(flat.json()).toEqual({
      profiles: [
        expect.objectContaining({
          name: "Plan A",
          accepted_progress: { kind: "empty" },
        }),
      ],
    });
    expect(v1.json()).toEqual({
      profiles: [
        expect.objectContaining({
          name: "Plan A",
          remaining_units: 0,
          total_units: 0,
        }),
      ],
    });
    expect(v1.json().profiles[0].accepted_progress).toBeUndefined();

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects v1 duplicate before writing and directs callers to v2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-apiv1-duplicate-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    delete process.env.PRINT_PARTNER_API_KEY;

    const config = loadConfig();
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const source = ports.repository.createSource({
      name: "Base",
      url: "https://example.com/base.git",
      source_kind: "github",
    });
    const plan = ports.repository.createProfile("Template", source.id);
    const app = await buildApp(config, ports);

    const raw = new Database(join(dir, "print-partner.db"));
    const tables = [
      "build_profiles",
      "profile_layers",
      "parts",
      "print_progress",
      "app_settings",
    ] as const;
    const snapshot = () =>
      Object.fromEntries(
        tables.map((table) => [table, raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
      );
    const before = snapshot();
    const duplicateProfile = ports.repository.duplicateProfile.bind(ports.repository);
    let duplicateCalls = 0;
    ports.repository.duplicateProfile = (...args: Parameters<typeof duplicateProfile>) => {
      duplicateCalls += 1;
      return duplicateProfile(...args);
    };
    const versioned = await app.inject({
      method: "POST",
      url: `/api/v1/plans/${plan.id}/duplicate`,
      payload: { name: "Versioned copy", clear_checkoff: true },
    });
    expect(versioned.statusCode).toBe(409);
    expect(versioned.json()).toEqual({ detail: "Duplicate this Plan through /api/v2" });
    expect(duplicateCalls).toBe(0);
    expect(snapshot()).toEqual(before);

    await app.close();
    raw.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("GET /api/v1 index and openapi redirect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-apiv1b-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    delete process.env.PRINT_PARTNER_API_KEY;

    const config = loadConfig();
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const app = await buildApp(config, ports);

    const index = await app.inject({ method: "GET", url: "/api/v1" });
    expect(index.statusCode).toBe(200);
    const body = index.json() as { version: string; openapi: string };
    expect(body.version).toBe("1");
    expect(body.openapi).toBe("/api/v1/openapi.json");

    const alias = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(alias.statusCode).toBe(302);

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects /api/v1 when API key is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-apiv1c-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    process.env.PRINT_PARTNER_API_KEY = "test-secret-key";

    const config = loadConfig();
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const app = await buildApp(config, ports);

    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/plans",
      remoteAddress: "203.0.113.10",
    });
    expect(denied.statusCode).toBe(401);

    const ok = await app.inject({
      method: "GET",
      url: "/api/v1/plans",
      headers: { authorization: "Bearer test-secret-key" },
    });
    expect(ok.statusCode).toBe(200);

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PRINT_PARTNER_API_KEY;
  });
});
