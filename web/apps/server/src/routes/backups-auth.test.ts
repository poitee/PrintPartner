import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../app.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { loadConfig } from "../config.js";

describe("administrative route authentication", () => {
  it("allows unambiguous loopback administration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-admin-loopback-"));
    const config = { ...loadConfig(), dataDir: dir };
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const app = await buildApp(config, ports);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/backups",
        remoteAddress: "127.0.0.1",
      });

      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disables loopback administration when peer identity is ambiguous", async () => {
    const cases = [
      { name: "proxy trust", config: { trustProxy: true, authRequired: false } },
      { name: "required authentication", config: { trustProxy: false, authRequired: true } },
    ];

    for (const testCase of cases) {
      const dir = mkdtempSync(join(tmpdir(), "pp-admin-ambiguous-"));
      const config = {
        ...loadConfig(),
        dataDir: dir,
        multiUser: false,
        ...testCase.config,
      };
      const ports = createSelfHostPorts(dir);
      await ports.db.connect();
      const app = await buildApp(config, ports);

      try {
        const response = await app.inject({
          method: "GET",
          url: "/backups",
          remoteAddress: "127.0.0.1",
          headers:
            testCase.name === "proxy trust"
              ? { "x-forwarded-for": "203.0.113.10" }
              : undefined,
        });

        expect.soft(response.statusCode, testCase.name).toBe(401);
      } finally {
        await app.close();
        ports.db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("rejects unauthenticated non-loopback requests with one policy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-admin-auth-"));
    const config = { ...loadConfig(), dataDir: dir };
    const ports = createSelfHostPorts(dir);
    await ports.db.connect();
    const app = await buildApp(config, ports);

    try {
      const requests = [
        { method: "GET" as const, url: "/backups" },
        { method: "GET" as const, url: "/settings/api-keys" },
        { method: "GET" as const, url: "/settings/logging/config" },
        { method: "DELETE" as const, url: "/api/v1/webhooks/missing" },
        {
          method: "POST" as const,
          url: "/admin/import-kit-bundle",
          payload: {},
        },
      ];

      for (const request of requests) {
        const response = await app.inject({
          ...request,
          remoteAddress: "203.0.113.10",
        });
        expect.soft(response.statusCode, `${request.method} ${request.url}`).toBe(401);
      }
    } finally {
      await app.close();
      ports.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
