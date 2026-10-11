import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, RouteOptions } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { exportHttpBodyLimits } from "./__tests__/body-limits.js";

const captured = vi.hoisted(() => ({
  routes: [] as RouteOptions[],
  jsonBodyBytes: 0,
  multipart: {} as Record<string, number>,
  rateLimit: {} as {
    max: number;
    timeWindow: string;
    allowList: (request: { url: string }) => boolean;
  },
}));

// Observe the real app's registration without adding a production export or changing its behavior.
vi.mock("fastify", async (importOriginal) => {
  const original = await importOriginal<typeof import("fastify")>();
  return { ...original, default: new Proxy(original.default, {
    apply(target, thisArg, args) {
      const app: FastifyInstance = Reflect.apply(target, thisArg, args);
      captured.jsonBodyBytes = app.initialConfig.bodyLimit!;
      app.addHook("onRoute", (route) => { captured.routes.push(route); });
      return app;
    },
  }) };
});
vi.mock("@fastify/multipart", async (importOriginal) => {
  const original = await importOriginal<typeof import("@fastify/multipart")>();
  return { ...original, default: new Proxy(original.default, {
    apply(target, thisArg, args) {
      captured.multipart = args[1].limits;
      return Reflect.apply(target, thisArg, args);
    },
  }) };
});
vi.mock("@fastify/rate-limit", async (importOriginal) => {
  const original = await importOriginal<typeof import("@fastify/rate-limit")>();
  return { ...original, default: new Proxy(original.default, {
    apply(target, thisArg, args) {
      captured.rateLimit = args[1];
      return Reflect.apply(target, thisArg, args);
    },
  }) };
});

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createSelfHostPorts } from "./adapters/self-host/index.js";

// Regenerate from web/: UPDATE_BODY_LIMITS_GOLDEN=1 npm run test -w @print-partner/server -- src/body-limits-golden.test.ts
describe("HTTP body limits golden", () => {
  it("matches every registered route's TS body, multipart and rate limits", async () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const goldenPath = resolve(srcDir, "../../../../fixtures/http/body-limits.json");
    const dataDir = mkdtempSync(join(tmpdir(), "pp-body-limits-golden-"));
    const ports = createSelfHostPorts(dataDir);
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      await ports.db.connect();
      // Cover conditional auth/sharing/board routes as well as the self-host API.
      for (const deployMode of ["self-host", "saas"] as const) {
        app = await buildApp({
          ...loadConfig(), dataDir, staticDir: null, deployMode,
          multiUser: true, singleUserAuth: false, authRequired: true,
          sessionSecret: "golden-fixture-session-secret-for-tests",
          integrationApiKey: null, updateCheckEnabled: false,
          discordOAuthConfigured: true, githubOAuthConfigured: true,
        }, ports);
        await app.ready();
        await app.close();
        app = undefined;
      }
      const snapshot = exportHttpBodyLimits(captured.routes, captured, srcDir);
      const { routes } = snapshot;
      if (process.env.UPDATE_BODY_LIMITS_GOLDEN === "1") {
        writeFileSync(goldenPath, `{\n  "routes": [\n${routes.map((route) => `    ${JSON.stringify(route)}`).join(",\n")}\n  ]\n}\n`);
      }
      expect(snapshot).toEqual(JSON.parse(readFileSync(goldenPath, "utf8")));
      console.info(`HTTP body limits golden: ${routes.length} routes; ${routes.filter((route) => route.multipart).length} multipart routes`);
    } finally {
      await app?.close();
      ports.db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
