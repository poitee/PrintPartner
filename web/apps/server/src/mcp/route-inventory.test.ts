/**
 * The golden Node HTTP route inventory must record /api/v1/mcp auth per mode:
 * open on single-user-auth loopback, 401/403 once multi-user, SaaS or an API key is
 * in play, and 503 fail-closed when exposed on a non-loopback host without a key.
 * CI re-generates the inventory from the live app and diffs it against
 * fixtures/http/routes-inventory.json;
 * this test pins the MCP expectations so a golden regeneration cannot quietly
 * change them. The desktop shell (socket-authenticated, no auth store) is not
 * probed by the inventory, so these modes say nothing about desktop auth.
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
  "self-host/single-user-auth": open(404),
  "self-host/multi-user": gated(401),
  "saas/multi-user": gated(403),
  "self-host/api-key": gated(401),
  "self-host/non-loopback": gated(503),
};

const allModes = Object.keys(expectedByMode);

// A mode counts as observed only when it has a probe: an absent key and a null probe both
// mean the inventory never recorded that mode.
const missingModes = (route: InventoryRoute): string[] =>
  allModes.filter((mode) => !route.authByMode?.[mode]);

const incompleteRoutes = (routes: InventoryRoute[]) =>
  routes
    .filter((route) => route.authRequired === "mode-dependent" || route.authByMode !== undefined)
    .map((route) => ({ route: `${route.method} ${route.path}`, modes: missingModes(route) }))
    .filter((entry) => entry.modes.length > 0);

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
      "self-host/single-user-auth": open(400),
    });
  });

  it("every authByMode map records a real probe for every auth mode", () => {
    expect(incompleteRoutes(inventory.routes)).toEqual([]);
  });

  for (const path of ["/printers", "/api/v1/mcp"]) {
    it.each(["absent", "null"])(`rejects %s mode observations on GET ${path}`, (mutation) => {
      const route = inventory.routes.find((candidate) => candidate.method === "GET" && candidate.path === path);
      if (!route) throw new Error(`Missing inventory entry: GET ${path}`);
      const authByMode: Record<string, ModeProbe> = route.authByMode
        ? { ...route.authByMode }
        : Object.fromEntries(allModes.map((mode) => [mode, gated(401)]));
      const planted = inventory.routes.map((candidate) =>
        candidate === route ? { ...route, authByMode } : candidate,
      );
      expect(incompleteRoutes(planted)).toEqual([]);
      if (mutation === "absent") delete authByMode["self-host/api-key"];
      else authByMode["self-host/api-key"] = null;
      expect(incompleteRoutes(planted)).toEqual([
        { route: `GET ${path}`, modes: ["self-host/api-key"] },
      ]);
    });
  }

  it("HEAD is session-gated in every mode (MCP transport does not serve HEAD)", () => {
    const route = mcpRoute("HEAD");
    expect(route.authRequired).toBe(true);
    expect(route.authByMode).toBeUndefined();
  });
});
