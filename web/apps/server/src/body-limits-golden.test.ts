import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, RouteOptions } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { exportHttpBodyLimits } from "./__tests__/body-limits.js";

const captured = vi.hoisted(() => ({
  routes: [] as RouteOptions[],
  rateLimitedRoutes: new WeakSet<RouteOptions>(),
  jsonBodyBytes: 0,
  multipart: {} as Record<string, number>,
  rateLimit: {} as {
    max: number;
    timeWindow: string;
    allowList: (request: { url: string }) => boolean;
    keyGenerator: (request: { url: string; ip: string }) => string;
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
      const result = Reflect.apply(target, thisArg, args);
      captured.multipart = args[1].limits;
      return result;
    },
  }) };
});
vi.mock("@fastify/rate-limit", async (importOriginal) => {
  const original = await importOriginal<typeof import("@fastify/rate-limit")>();
  return { ...original, default: new Proxy(original.default, {
    apply(target, thisArg, args) {
      captured.rateLimit = args[1];
      const app: FastifyInstance = args[0];
      const addHook = app.addHook;
      // Observe whether the plugin's own onRoute callback actually adds a limiter.
      app.addHook = new Proxy(addHook, {
        apply(hookTarget, hookThis, hookArgs) {
          if (hookArgs[0] === "onRoute") {
            hookArgs[1] = new Proxy(hookArgs[1], {
              apply(routeTarget, routeThis, routeArgs) {
                const route: RouteOptions = routeArgs[0];
                const before = new Set(Object.values(route).flat());
                const result = Reflect.apply(routeTarget, routeThis, routeArgs);
                if (Object.values(route).flat().some((value) => typeof value === "function" && !before.has(value))) {
                  captured.rateLimitedRoutes.add(route);
                }
                return result;
              },
            });
          }
          return Reflect.apply(hookTarget, hookThis, hookArgs);
        },
      });
      try { return Reflect.apply(target, thisArg, args); }
      finally { app.addHook = addHook; }
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
    const staticDir = join(dataDir, "spa");
    cpSync(resolve(srcDir, "../../web/public"), staticDir, { recursive: true });
    mkdirSync(join(staticDir, "assets"), { recursive: true });
    // Vite content hashes vary independently of server policy; exercise the shipped bundle route family.
    writeFileSync(join(staticDir, "assets", "index-Fixture1.js"), "export {};\n");
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Fixture SPA</title>");
    const ports = createSelfHostPorts(dataDir);
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      await ports.db.connect();
      // Cover conditional auth/sharing/board routes and both production/static and dev/docs surfaces.
      vi.stubEnv("OPENAPI_UI", "0");
      for (const nodeEnv of ["test", "production"]) {
        vi.stubEnv("NODE_ENV", nodeEnv);
        for (const { deployMode, multiUser } of [
          { deployMode: "self-host", multiUser: false },
          { deployMode: "self-host", multiUser: true },
          { deployMode: "saas", multiUser: true },
        ] as const) {
          app = await buildApp({
            ...loadConfig(), dataDir, staticDir: nodeEnv === "production" ? staticDir : null, deployMode,
            multiUser, singleUserAuth: false, authRequired: true,
            sessionSecret: "golden-fixture-session-secret-for-tests",
            integrationApiKey: null, updateCheckEnabled: false,
            discordOAuthConfigured: true, githubOAuthConfigured: true,
          }, ports);
          await app.ready();
          await app.close();
          app = undefined;
        }
      }
      const snapshot = exportHttpBodyLimits(captured.routes, captured, srcDir);
      const { routes } = snapshot;
      if (process.env.UPDATE_BODY_LIMITS_GOLDEN === "1") {
        writeFileSync(goldenPath, `{\n  "semantics": ${JSON.stringify(snapshot.semantics)},\n  "routes": [\n${routes.map((route) => `    ${JSON.stringify(route)}`).join(",\n")}\n  ]\n}\n`);
      }
      expect(snapshot).toEqual(JSON.parse(readFileSync(goldenPath, "utf8")));
      console.info(`HTTP body limits golden: ${routes.length} routes; ${routes.filter((route) => route.multipart).length} multipart routes`);
    } finally {
      await app?.close();
      ports.db.close();
      rmSync(dataDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  }, 60_000);
});
