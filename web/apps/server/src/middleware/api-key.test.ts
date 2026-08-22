import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../app.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { loadConfig } from "../config.js";

async function makeApp(dir: string) {
  const config = {
    ...loadConfig(),
    dataDir: dir,
    integrationApiKey: "bootstrap-api-key",
  };
  const ports = createSelfHostPorts(dir);
  await ports.db.connect();
  const app = await buildApp(config, ports);
  return { app, ports };
}

describe("versioned API key authentication", () => {
  it("protects v2 Plan routes while exempting only the v2 index and OpenAPI alias", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-api-key-v2-"));
    const { app, ports } = await makeApp(dir);

    try {
      const denied = await app.inject({
        method: "GET",
        url: "/api/v2/plans",
        remoteAddress: "203.0.113.10",
      });
      expect(denied.statusCode).toBe(401);

      const index = await app.inject({
        method: "GET",
        url: "/api/v2",
        remoteAddress: "203.0.113.10",
      });
      expect(index.statusCode).toBe(200);
      expect(index.json()).toEqual({
        version: "2",
        scope: "plans",
        plans: "/api/v2/plans",
        openapi: "/api/v2/openapi.json",
      });

      const openapi = await app.inject({
        method: "GET",
        url: "/api/v2/openapi.json",
        remoteAddress: "203.0.113.10",
      });
      expect(openapi.statusCode).toBe(200);
      expect(openapi.json().paths).toHaveProperty("/api/v2/plans");
      expect(openapi.json().paths).not.toHaveProperty("/api/v2/sources");

      const accepted = await app.inject({
        method: "GET",
        url: "/api/v2/plans",
        remoteAddress: "203.0.113.10",
        headers: { authorization: "Bearer bootstrap-api-key" },
      });
      expect(accepted.statusCode).toBe(200);
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not exempt dotted API paths from authentication", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-api-key-dotted-"));
    const { app, ports } = await makeApp(dir);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/not-a-static.asset",
        remoteAddress: "203.0.113.10",
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not trust a client-supplied Sec-Fetch-Site header", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-api-key-header-"));
    const { app, ports } = await makeApp(dir);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/plans",
        remoteAddress: "203.0.113.10",
        headers: { "sec-fetch-site": "same-origin" },
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows unambiguous loopback access without a bearer key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-api-key-loopback-"));
    const { app, ports } = await makeApp(dir);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/plans",
        remoteAddress: "127.0.0.1",
      });

      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not use loopback bypass when proxy trust is enabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-api-key-proxy-"));
    const config = {
      ...loadConfig(),
      dataDir: dir,
      integrationApiKey: "bootstrap-api-key",
      trustProxy: true,
    };
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const app = await buildApp(config, ports);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/plans",
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": "203.0.113.10" },
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows an authenticated non-implicit session from a non-loopback peer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-api-key-session-"));
    const config = {
      ...loadConfig(),
      dataDir: dir,
      integrationApiKey: "bootstrap-api-key",
      multiUser: true,
      authRequired: true,
      sessionSecret: "test-session-secret",
    };
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const app = await buildApp(config, ports);

    try {
      await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          email: "admin@example.com",
          password: "correct-horse-battery",
        },
      });
      const login = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          email: "member@example.com",
          password: "correct-horse-battery",
        },
      });
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/plans",
        remoteAddress: "203.0.113.10",
        headers: { cookie },
      });

      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not treat the synthetic SaaS anonymous identity as an authenticated session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-api-key-saas-anonymous-"));
    const config = {
      ...loadConfig(),
      dataDir: dir,
      deployMode: "saas" as const,
      integrationApiKey: "bootstrap-api-key",
      multiUser: false,
      authRequired: false,
      saasAllowAnonymous: true,
    };
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const app = await buildApp(config, ports);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/plans",
        remoteAddress: "203.0.113.10",
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a settings-created key until it is revoked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-api-key-revoke-"));
    const { app, ports } = await makeApp(dir);

    try {
      const created = await app.inject({
        method: "POST",
        url: "/settings/api-keys",
      });
      expect(created.statusCode).toBe(201);
      const { id, key } = created.json() as { id: string; key: string };

      const accepted = await app.inject({
        method: "GET",
        url: "/api/v1/plans",
        headers: { authorization: `Bearer ${key}` },
      });
      expect(accepted.statusCode).toBe(200);

      const revoked = await app.inject({
        method: "DELETE",
        url: `/settings/api-keys/${id}`,
      });
      expect(revoked.statusCode).toBe(200);

      const rejected = await app.inject({
        method: "GET",
        url: "/api/v1/plans",
        headers: { authorization: `Bearer ${key}` },
      });
      expect(rejected.statusCode).toBe(401);
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
