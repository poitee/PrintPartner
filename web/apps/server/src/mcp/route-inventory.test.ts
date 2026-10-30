/**
 * The golden Node HTTP route inventory must record /api/v1/mcp as auth-required in
 * every mode: T-16 (GRE-348) removed the keyless loopback exemption, so a probe with
 * no key is refused on loopback, LAN, multi-user and SaaS alike.
 * CI re-generates the inventory from the live app and diffs it against
 * fixtures/http/routes-inventory.json;
 * this test pins the MCP expectations so a golden regeneration cannot quietly
 * change them. The desktop shell (socket-authenticated, no auth store) is not
 * probed by the inventory, so these modes say nothing about desktop auth.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type ModeProbe = { status: number; authRequired: boolean } | null;
type ModeRegistration = { registered: boolean; status: number };
type InventoryRoute = {
  method: string;
  path: string;
  authRequired: boolean | "mode-dependent";
  authByMode?: Record<string, ModeProbe>;
  registeredByMode?: Record<string, ModeRegistration | null>;
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

const allModes = [
  "self-host/single-user-auth",
  "self-host/multi-user",
  "saas/multi-user",
  "self-host/api-key",
  "self-host/non-loopback",
];

// A mode counts as observed only when it has a probe: an absent key and a null probe both
// mean the inventory never recorded that mode.
const missingModes = (route: InventoryRoute): string[] =>
  allModes.filter((mode) => !route.authByMode?.[mode]);

const incompleteRoutes = (routes: InventoryRoute[]) =>
  routes
    .filter((route) => route.authRequired === "mode-dependent" || route.authByMode !== undefined)
    .map((route) => ({ route: `${route.method} ${route.path}`, modes: missingModes(route) }))
    .filter((entry) => entry.modes.length > 0);

const inventoryRoute = (method: string, path: string) => {
  const route = inventory.routes.find((candidate) => candidate.method === method && candidate.path === path);
  if (!route) throw new Error(`Missing inventory entry: ${method} ${path}`);
  return route;
};

const registrationGaps = (route: InventoryRoute): string[] =>
  allModes.filter((mode) => {
    const entry = route.registeredByMode?.[mode];
    return !entry || typeof entry.registered !== "boolean" || typeof entry.status !== "number";
  });

const incompleteRegistration = (routes: InventoryRoute[]) =>
  routes
    .filter((route) => route.registeredByMode !== undefined)
    .map((route) => ({ route: `${route.method} ${route.path}`, modes: registrationGaps(route) }))
    .filter((entry) => entry.modes.length > 0);

describe("golden route inventory: /api/v1/mcp auth per mode", () => {
  for (const method of ["GET", "POST", "DELETE"]) {
    it(`${method} requires auth in every mode`, () => {
      const route = mcpRoute(method);
      expect(route.authRequired).toBe(true);
      expect(route.authByMode).toBeUndefined();
    });
  }

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

  it("GET /board/posts records SaaS registration separately from the 401 fallback", () => {
    const route = inventoryRoute("GET", "/board/posts");
    expect(route.authRequired).toBe(true);
    expect(route.authByMode).toBeUndefined();
    expect(route.registeredByMode).toEqual({
      "self-host/single-user-auth": { registered: false, status: 401 },
      "self-host/multi-user": { registered: false, status: 401 },
      "saas/multi-user": { registered: true, status: 401 },
      "self-host/api-key": { registered: false, status: 401 },
      "self-host/non-loopback": { registered: false, status: 401 },
    });
  });

  it("GET /shares/incoming records registration and the status each mode returned", () => {
    const route = inventoryRoute("GET", "/shares/incoming");
    expect(route.authRequired).toBe(true);
    expect(route.authByMode).toBeUndefined();
    expect(route.registeredByMode).toEqual({
      "self-host/single-user-auth": { registered: false, status: 401 },
      "self-host/multi-user": { registered: true, status: 401 },
      "saas/multi-user": { registered: true, status: 403 },
      "self-host/api-key": { registered: false, status: 401 },
      "self-host/non-loopback": { registered: false, status: 401 },
    });
  });

  it("GET /ws/profile-sync records single-user registration and multi-user absence", () => {
    const route = inventoryRoute("GET", "/ws/profile-sync");
    expect(route.authRequired).toBe(true);
    expect(route.authByMode).toBeUndefined();
    expect(route.registeredByMode).toEqual({
      "self-host/single-user-auth": { registered: true, status: 401 },
      "self-host/multi-user": { registered: false, status: 401 },
      "saas/multi-user": { registered: false, status: 401 },
      "self-host/api-key": { registered: true, status: 401 },
      "self-host/non-loopback": { registered: true, status: 401 },
    });
  });

  it("GET /printers stays uniform without a registration map", () => {
    const route = inventoryRoute("GET", "/printers");
    expect(route.authRequired).toBe(true);
    expect(route.authByMode).toBeUndefined();
    expect(route.registeredByMode).toBeUndefined();
  });

  it("OPTIONS * stays registered in every mode", () => {
    const route = inventoryRoute("OPTIONS", "*");
    expect(route.authRequired).toBe(true);
    expect(route.registeredByMode).toBeUndefined();
  });

  it("records a complete registration map for every route absent from a mode", () => {
    const mapped = inventory.routes.filter((route) => route.registeredByMode !== undefined);
    const artificial = mapped
      .filter((route) => allModes.every((mode) => route.registeredByMode?.[mode]?.registered === true))
      .map((route) => `${route.method} ${route.path}`);
    expect(mapped).toHaveLength(28);
    expect(artificial).toEqual([]);
    expect(incompleteRegistration(inventory.routes)).toEqual([]);
  });

  for (const path of ["/board/posts", "/printers"]) {
    it.each(["absent", "null"])(`rejects %s registration observations on GET ${path}`, (mutation) => {
      const route = inventoryRoute("GET", path);
      const registeredByMode: Record<string, ModeRegistration | null> = route.registeredByMode
        ? { ...route.registeredByMode }
        : Object.fromEntries(allModes.map((mode) => [mode, { registered: true, status: 401 }]));
      const planted = inventory.routes.map((candidate) =>
        candidate === route ? { ...route, registeredByMode } : candidate,
      );
      expect(incompleteRegistration(planted)).toEqual([]);
      if (mutation === "absent") delete registeredByMode["self-host/api-key"];
      else registeredByMode["self-host/api-key"] = null;
      expect(incompleteRegistration(planted)).toEqual([
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
