import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../app.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { loadConfig } from "../config.js";

const originalNodeEnv = process.env.NODE_ENV;

async function makeProductionApp(dir: string) {
  const config = {
    ...loadConfig(),
    dataDir: dir,
    multiUser: true,
    authRequired: true,
    sessionSecret: "test-session-secret",
  };
  const ports = createSelfHostPorts(dir);
  await ports.db.connect();
  const app = await buildApp(config, ports);
  return { app, ports };
}

describe("production authentication routes", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("does not register the development login route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-auth-production-dev-"));
    const { app, ports } = await makeProductionApp(dir);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/auth/dev-login",
        payload: { login: "attacker" },
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks production session cookies Secure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-auth-production-cookie-"));
    const { app, ports } = await makeProductionApp(dir);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          email: "admin@example.com",
          password: "correct-horse-battery",
          display_name: "Admin",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["set-cookie"]).toContain("Secure");
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks production OAuth state cookies Secure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-auth-production-oauth-cookie-"));
    const config = {
      ...loadConfig(),
      dataDir: dir,
      multiUser: true,
      authRequired: true,
      sessionSecret: "test-session-secret",
      githubClientId: "github-client",
      githubClientSecret: "github-secret",
      githubCallbackUrl: "https://app.example.com/auth/callback",
      githubOAuthConfigured: true,
      discordClientId: "discord-client",
      discordClientSecret: "discord-secret",
      discordCallbackUrl: "https://app.example.com/auth/discord/callback",
      discordOAuthConfigured: true,
    };
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const app = await buildApp(config, ports);

    try {
      for (const url of ["/auth/github", "/auth/discord"]) {
        const response = await app.inject({ method: "GET", url });

        expect.soft(response.statusCode, url).toBe(302);
        expect.soft(response.headers["set-cookie"], url).toContain("Secure");
      }
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
