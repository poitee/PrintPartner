/**
 * The golden Node HTTP route inventory must record /api/v1/mcp auth per mode:
 * open on single-user loopback, 401/403 once multi-user, SaaS or an API key is
 * in play, and 503 fail-closed when exposed on a non-loopback host without a key.
 * CI re-generates the inventory from the live app and diffs it against this file;
 * this test pins the MCP expectations so a golden regeneration cannot quietly
 * change them.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type ModeProbe = { status: number; authRequired: boolean } | null;
type InventoryRoute = {
  method: string;
  path: string;
  authRequired: boolean | "mode-dependent";
  authByMode?: Record<string, ModeProbe>;
};

const inventory = JSON.parse(
  readFileSync(new URL("../../../../../fixtures/http/routes-inventory.json", import.meta.url), "utf8"),
) as { routes: InventoryRoute[] };

const mcpRoute = (method: string) => {
  const route = inventory.routes.find(
    (candidate) => candidate.path === "/api/v1/mcp" && candidate.method === method,
  );
  if (!route) throw new Error(`Missing inventory entry: ${method} /api/v1/mcp`);
  return route;
};

const gated = (status: number) => ({ status, authRequired: true });
const open = (status: number) => ({ status, authRequired: false });

const expectedByMode = {
  "self-host/single-user": open(404),
  "self-host/multi-user": gated(401),
  "saas/multi-user": gated(403),
  "self-host/api-key": gated(401),
  "self-host/non-loopback": gated(503),
};

describe("golden route inventory: /api/v1/mcp auth per mode", () => {
  for (const method of ["GET", "DELETE"]) {
    it(`${method} records each auth mode's observed status`, () => {
      const route = mcpRoute(method);
      expect(route.authRequired).toBe("mode-dependent");
      expect(route.authByMode).toEqual(expectedByMode);
    });
  }

  it("POST records each auth mode's observed status", () => {
    const route = mcpRoute("POST");
    expect(route.authRequired).toBe("mode-dependent");
    expect(route.authByMode).toEqual({
      ...expectedByMode,
      "self-host/single-user": open(400),
    });
  });

  it("every mode-dependent route records all auth modes, including routes first seen in a later mode", () => {
    const modes = Object.keys(expectedByMode);
    const sparse = inventory.routes
      .filter((route) => route.authRequired === "mode-dependent")
      .filter((route) => modes.some((mode) => !(mode in (route.authByMode ?? {}))))
      .map((route) => `${route.method} ${route.path}`);
    expect(sparse).toEqual([]);
  });

  it("HEAD is session-gated in every mode (MCP transport does not serve HEAD)", () => {
    const route = mcpRoute("HEAD");
    expect(route.authRequired).toBe(true);
    expect(route.authByMode).toBeUndefined();
  });
});
