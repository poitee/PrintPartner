import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";

/**
 * Regression coverage for server-side validation of the Discord webhook URL
 * setting. Previously PUT /settings/discord-notify accepted any string
 * (including garbage like "not-a-valid-url") with no rejection.
 */
async function makeApp(dir: string) {
  process.env.PRINT_PARTNER_DATA_DIR = dir;
  delete process.env.PRINT_PARTNER_API_KEY;
  const config = loadConfig();
  const ports = createSelfHostPorts(dir);
  await ports.db.connect();
  const app = await buildApp(config, ports);
  return { app, ports };
}

describe("PUT /settings/discord-notify webhook_url validation", () => {
  afterEach(() => {
    delete process.env.PRINT_PARTNER_DATA_DIR;
  });

  it("rejects a plainly invalid webhook_url with 400 and does not persist it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-discord-webhook-invalid-"));
    const { app, ports } = await makeApp(dir);

    const res = await app.inject({
      method: "PUT",
      url: "/settings/discord-notify",
      payload: { webhook_url: "not-a-valid-url" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("detail");

    const get = await app.inject({ method: "GET", url: "/settings/discord-notify" });
    expect(get.json().webhook_url).toBeNull();

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a non-Discord https URL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-discord-webhook-nondiscord-"));
    const { app, ports } = await makeApp(dir);

    const res = await app.inject({
      method: "PUT",
      url: "/settings/discord-notify",
      payload: { webhook_url: "https://evil.example.com/api/webhooks/123/tok" },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a Discord webhook URL with a non-numeric id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-discord-webhook-badid-"));
    const { app, ports } = await makeApp(dir);

    const res = await app.inject({
      method: "PUT",
      url: "/settings/discord-notify",
      payload: { webhook_url: "https://discord.com/api/webhooks/abc/tok" },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a well-formed Discord webhook URL and persists it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-discord-webhook-valid-"));
    const { app, ports } = await makeApp(dir);

    const url = "https://discord.com/api/webhooks/123456789012345678/aBcDeF-token_123";
    const res = await app.inject({
      method: "PUT",
      url: "/settings/discord-notify",
      payload: { webhook_url: url },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().webhook_url).toBe(url);

    const get = await app.inject({ method: "GET", url: "/settings/discord-notify" });
    expect(get.json().webhook_url).toBe(url);

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("allows clearing the webhook with null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-discord-webhook-clear-null-"));
    const { app, ports } = await makeApp(dir);

    const url = "https://discord.com/api/webhooks/123456789012345678/tok";
    await app.inject({
      method: "PUT",
      url: "/settings/discord-notify",
      payload: { webhook_url: url },
    });

    const res = await app.inject({
      method: "PUT",
      url: "/settings/discord-notify",
      payload: { webhook_url: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().webhook_url).toBeNull();

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("allows clearing the webhook with an empty string", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-discord-webhook-clear-empty-"));
    const { app, ports } = await makeApp(dir);

    const url = "https://discord.com/api/webhooks/123456789012345678/tok";
    await app.inject({
      method: "PUT",
      url: "/settings/discord-notify",
      payload: { webhook_url: url },
    });

    const res = await app.inject({
      method: "PUT",
      url: "/settings/discord-notify",
      payload: { webhook_url: "" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().webhook_url).toBeNull();

    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
