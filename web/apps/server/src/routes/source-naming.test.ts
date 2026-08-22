import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";

describe("Source naming routes", () => {
  afterEach(() => {
    delete process.env.PRINT_PARTNER_DATA_DIR;
  });

  it("persists a validated Source override without replacing unrelated metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-source-naming-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const repo = ports.repository!;
    const source = repo.createSource({
      name: "Named",
      source_kind: "local",
      metadata: { category: "Voron" },
    });
    const app = await buildApp(loadConfig(), ports);
    const profile = repo.getGlobalNaming();
    const override = {
      ...profile,
      quantity: { ...profile.quantity, default: 2 },
    };

    const put = await app.inject({
      method: "PUT",
      url: `/sources/${source.id}/naming`,
      payload: { use_defaults: false, override },
    });

    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      use_defaults: false,
      override,
      effective: override,
    });
    expect(repo.getSource(source.id)?.metadata).toMatchObject({ category: "Voron" });

    const get = await app.inject({ method: "GET", url: `/sources/${source.id}/naming` });
    expect(get.json()).toEqual(put.json());

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects malformed naming without changing the Source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-source-naming-invalid-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const repo = ports.repository!;
    const source = repo.createSource({ name: "Invalid", source_kind: "local" });
    const before = repo.getSource(source.id)?.metadata;
    const app = await buildApp(loadConfig(), ports);

    const put = await app.inject({
      method: "PUT",
      url: `/sources/${source.id}/naming`,
      payload: { use_defaults: false, override: { quantity: {} } },
    });

    expect(put.statusCode).toBe(400);
    expect(repo.getSource(source.id)?.metadata).toEqual(before);

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    [
      "a zero default quantity",
      { quantity: { regex: String.raw`[ _]x([0-9]+)\.stl$`, default: 0 } },
    ],
    [
      "a fractional default quantity",
      { quantity: { regex: String.raw`[ _]x([0-9]+)\.stl$`, default: 1.5 } },
    ],
    ["a blank folder path", { folder_rules: [{ path_contains: "  ", role_id: "accent" }] }],
    ["an unknown folder role", { folder_rules: [{ path_contains: "mods", role_id: "other" }] }],
  ])("rejects %s without changing Source metadata", async (_label, profileChange) => {
    const dir = mkdtempSync(join(tmpdir(), "pp-source-naming-atomic-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const repo = ports.repository!;
    const source = repo.createSource({
      name: "Atomic",
      source_kind: "local",
      metadata: { category: "Voron" },
    });
    const before = repo.getSource(source.id)?.metadata;
    const app = await buildApp(loadConfig(), ports);
    const override = { ...repo.getGlobalNaming(), ...profileChange };

    const put = await app.inject({
      method: "PUT",
      url: `/sources/${source.id}/naming`,
      payload: { use_defaults: false, override },
    });

    expect(put.statusCode).toBe(400);
    expect(put.json()).toMatchObject({ code: "invalid_source_naming" });
    expect(repo.getSource(source.id)?.metadata).toEqual(before);

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns one coded error for a missing Source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-source-naming-missing-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const app = await buildApp(loadConfig(), ports);

    const get = await app.inject({ method: "GET", url: "/sources/999999/naming" });
    const put = await app.inject({
      method: "PUT",
      url: "/sources/999999/naming",
      payload: { use_defaults: true },
    });

    expect(get.statusCode).toBe(404);
    expect(get.json()).toEqual({ code: "source_not_found", detail: "Source not found" });
    expect(put.statusCode).toBe(404);
    expect(put.json()).toEqual(get.json());

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("preserves a sparse stored override and returns a complete effective profile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-source-naming-sparse-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const repo = ports.repository!;
    const source = repo.createSource({
      name: "Sparse",
      source_kind: "local",
      metadata: {
        naming: {
          use_defaults: false,
          override: {
            roles: [{ id: "accent", markers: ["[accent]"] }],
            quantity: { default: 2 },
          },
        },
      },
    });
    const app = await buildApp(loadConfig(), ports);

    const get = await app.inject({ method: "GET", url: `/sources/${source.id}/naming` });

    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({
      use_defaults: false,
      override: {
        roles: [{ id: "accent", markers: ["[accent]"] }],
        quantity: { default: 2 },
      },
      effective: {
        roles: expect.arrayContaining([{ id: "accent", label: "Accent", markers: ["[accent]"] }]),
        quantity: { default: 2 },
      },
    });
    expect(get.json().override).toEqual({
      roles: [{ id: "accent", markers: ["[accent]"] }],
      quantity: { default: 2 },
    });

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects invalid stored naming without rewriting it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-source-naming-stored-invalid-"));
    process.env.PRINT_PARTNER_DATA_DIR = dir;
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const repo = ports.repository!;
    const source = repo.createSource({
      name: "Stored invalid",
      source_kind: "local",
      metadata: {
        naming: {
          use_defaults: false,
          override: { folder_rules: [{ path_contains: "mods", role_id: "other" }] },
        },
      },
    });
    const before = repo.getSource(source.id)?.metadata;
    const app = await buildApp(loadConfig(), ports);

    const get = await app.inject({ method: "GET", url: `/sources/${source.id}/naming` });

    expect(get.statusCode).toBe(500);
    expect(get.json()).toEqual({
      code: "invalid_source_naming_state",
      detail: "Stored Source naming settings are invalid",
    });
    expect(repo.getSource(source.id)?.metadata).toEqual(before);

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
