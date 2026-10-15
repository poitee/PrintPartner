// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PlanReview } from "../api/endpoints/planManifests";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TENANT_FEATURE_TOGGLES_CAPABILITY,
  type PlanFeatures,
} from "@print-partner/contracts";
import type { FilamentCatalog, RoleFilamentRow } from "../api/endpoints/filaments";
import { queryKeys } from "../queries/keys";
import { useSpoolmanWorkflowAccess } from "./useSpoolmanWorkflowAccess";
import { useFilamentCatalogQuery, useSpoolmanSpoolsQuery } from "../queries/filaments";
import { usePlanReviewQuery } from "../queries/planReview";
import { useRoleFilamentsQuery } from "../queries/roleFilaments";

let client: QueryClient;
let capabilities: string[];
let planSpoolman: boolean;
let planFailure: boolean;
let planPending: boolean;
let healthFailure: boolean;
let requests: string[];

function planFeaturesData(id: number, enabled: boolean): PlanFeatures {
  return {
    profile_id: id,
    overrides: { spoolman: enabled },
    effective: {
      farm: { enabled: false, source: "default" },
      orders: { enabled: false, source: "default" },
      bambu: { enabled: false, source: "default" },
      spoolman: { enabled, source: "plan" },
    },
  };
}

const mockCatalog: FilamentCatalog = {
  synced_at: "now",
  source: "test",
  status: "ok",
  colors: [{ id: "c1", display_name: "Catalog Red", product_line: "PLA", hex: "#ff0000", combo_label: "Red", swatch_url: "" }],
  custom_colors: [],
  spoolman_colors: [{ id: "spoolman:1:2", display_name: "Spoolman Blue", product_line: "PETG", hex: "#0000ff", combo_label: "Blue", swatch_url: "" }],
  default_spoolman_integration_id: "spoolman-1",
  spoolman_status: "ok",
};

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  capabilities = [TENANT_FEATURE_TOGGLES_CAPABILITY];
  planSpoolman = false;
  planFailure = false;
  planPending = false;
  healthFailure = false;
  requests = [];

  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    const path = url.pathname;
    requests.push(`${path}${url.search}`);
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

    if (path === "/health") {
      return json(
        healthFailure ? {} : { ok: true, version: "test", data_dir: "test", deploy_mode: "self-host", capabilities },
        healthFailure ? 500 : 200,
      );
    }
    if (/^\/plans\/\d+\/features$/.test(path)) {
      if (planPending) return new Promise<Response>(() => {});
      const id = Number(path.split("/")[2]);
      return json(planFeaturesData(id, planSpoolman), planFailure ? 500 : 200);
    }
    if (path === "/filaments/catalog") {
      return json(mockCatalog);
    }
    if (path.includes("/spoolman/spools")) {
      return json({ spools: [] });
    }
    throw new Error(`Unexpected request: ${path}`);
  }));
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useSpoolmanWorkflowAccess", () => {
  it("retains legacy behavior with no feature calls when engine lacks capability", async () => {
    capabilities = [];
    const { result } = renderHook(() => useSpoolmanWorkflowAccess(1), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    await waitFor(() => expect(result.current.allowed).toBe(true));
    expect(result.current.currentAccessAllowed()).toBe(true);
    expect(requests.filter((r) => r.includes("/features"))).toEqual([]);
  });

  it.each(["pending", "error"])("hides cached inventory when a feature refetch is %s", async (state) => {
    planSpoolman = true;
    const { result } = renderHook(() => useSpoolmanWorkflowAccess(1), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    await waitFor(() => expect(result.current.allowed).toBe(true));

    planPending = state === "pending";
    planFailure = state === "error";
    act(() => {
      void client.invalidateQueries({ queryKey: queryKeys.planFeatures(1) });
    });

    await waitFor(() => expect(result.current.allowed).toBe(false));
    expect(result.current.currentAccessAllowed()).toBe(false);
    if (state === "error") await waitFor(() => expect(client.getQueryState(queryKeys.planFeatures(1))?.status).toBe("error"));
  });

  it("fails closed on profile mismatch in plan data", async () => {
    client.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
    client.setQueryData(queryKeys.planFeatures(1), planFeaturesData(2, true));

    const { result } = renderHook(() => useSpoolmanWorkflowAccess(1), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    expect(result.current.allowed).toBe(false);
    expect(result.current.currentAccessAllowed()).toBe(false);
  });

  it.each(["off/on", "invalidation"])("withholds mounted cached spools through %s until refreshed", async (transition) => {
    planSpoolman = true;
    client.setDefaultOptions({ queries: { retry: false, staleTime: 30_000, gcTime: Infinity } });
    client.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
    client.setQueryData(queryKeys.planFeatures(1), planFeaturesData(1, true));
    const oldRows = [{ id: 10, filament_id: 1, remaining_weight: 450, location: null }];
    for (const id of [undefined, 1, 2]) client.setQueryData(queryKeys.spoolmanSpools("int-1", id), oldRows);
    let finish: ((response: Response) => void) | undefined;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => String(input).includes("/spoolman/spools")
      ? new Promise<Response>((resolve) => { finish = resolve; }) : originalFetch(input)));
    const { result } = renderHook(() => {
      const access = useSpoolmanWorkflowAccess(1);
      return useSpoolmanSpoolsQuery(access.allowed ? "int-1" : null, { profileId: 1, enabled: access.allowed });
    }, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
    expect(result.current.data).toEqual(oldRows);
    act(() => {
      if (transition === "invalidation") void client.invalidateQueries({ queryKey: queryKeys.planFeatures(1) });
      else {
        client.setQueryData(queryKeys.planFeatures(1), planFeaturesData(1, false));
        client.setQueryData(queryKeys.planFeatures(1), planFeaturesData(1, true));
      }
    });
    await waitFor(() => expect(finish).toBeDefined());
    expect(result.current.data).toBeUndefined();
    expect(client.getQueryData(queryKeys.spoolmanSpools("int-1", 1))).toBeUndefined();
    expect(client.getQueryData(queryKeys.spoolmanSpools("int-1", 2))).toEqual(oldRows);
    expect(client.getQueryData(queryKeys.spoolmanSpools("int-1"))).toEqual(oldRows);
    const newRows = [{ ...oldRows[0], id: 99, remaining_weight: 500 }];
    if (!finish) throw new Error("Inventory refresh did not start");
    finish(new Response(JSON.stringify({ spools: newRows }), { headers: { "content-type": "application/json" } }));
    await waitFor(() => expect(result.current.data).toEqual(newRows));
  });

});

const enrichedReview: PlanReview = {
  profile_id: 1, accepted_basis: null, plan_name: "Proof", layers: [], issues: [], has_blockers: false,
  totals: { included_parts: 1, total_print_units: 1, by_role: {}, by_filament: {} },
  part_groups: [{ folder: "parts", source_layer: null, parts: [{
    id: 1, match_key: "a.stl", relative_path: "a.stl", filename: "a.stl", source_layer: null,
    status: "ok", role: "primary", requirement: null, option_group_id: null, included: true,
    filament_color_id: "spoolman:1:filament:2", spoolman_spool_id: "spoolman:1:spool:5",
    quantity_auto: 1, quantity_override: null, quantity_effective: 1, printed_count: 0,
    print_units: [false], missing: true, filament_display: "Blue", filament_hex: "#0000ff",
    spool_badge: "450g left", spool_summary: [{ remaining_g: 450, spool_id: 5 }],
  }] }],
};

const mockRoles: RoleFilamentRow[] = [
  { role: "r1", part_count: 1, filament_color_id: "spoolman:1:2", spoolman_spool_id: "spoolman:1:s1", filament_custom_hex: "#112233", filament_display: "Blue", filament_hex: "#0000ff" },
  { role: "r2", part_count: 1, filament_color_id: "c1", spoolman_spool_id: null, filament_custom_hex: null, filament_display: "Red", filament_hex: "#ff0000" },
  { role: "r3", part_count: 1, filament_color_id: "custom:1", spoolman_spool_id: null, filament_custom_hex: "#334455", filament_display: "Custom", filament_hex: "#334455" },
];

it.each(["refresh", "error", "revoked response"])("withholds every mounted inventory observation until refreshed: %s", async (mode) => {
  planSpoolman = true;
  client.setDefaultOptions({ queries: { retry: false, staleTime: 30_000 } });
  client.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
  client.setQueryData(queryKeys.planFeatures(1), planFeaturesData(1, true));
  for (const id of [1, 2]) {
    client.setQueryData(queryKeys.roleFilaments(id), mockRoles);
    client.setQueryData(queryKeys.filamentCatalog(id), mockCatalog);
    for (const excluded of [false, true]) client.setQueryData(queryKeys.planReview(id, excluded), { ...enrichedReview, profile_id: id });
  }
  client.setQueryData(queryKeys.filamentCatalog(), mockCatalog);
  const pending = { review: new Array<(response: Response) => void>(), roles: new Array<(response: Response) => void>(), catalog: new Array<(response: Response) => void>() };
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
    const path = String(input);
    const queue = path.includes("/review") ? pending.review : path.includes("/role-filaments") ? pending.roles
      : path.includes("/filaments/catalog") ? pending.catalog : null;
    return queue ? new Promise<Response>((resolve) => queue.push(resolve)) : originalFetch(input);
  }));
  const { result } = renderHook(() => {
    useSpoolmanWorkflowAccess(1);
    useSpoolmanWorkflowAccess(1);
    const review = usePlanReviewQuery(1);
    const roles = useRoleFilamentsQuery(1);
    const catalog = useFilamentCatalogQuery({ profileId: 1 });
    return { review, roles, catalog };
  }, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  const assertMasked = () => {
    expect(result.current.review.data?.part_groups[0]?.parts[0]).toMatchObject({ spool_badge: null, filament_display: "", filament_color_id: "spoolman:1:filament:2" });
    expect(result.current.roles.data?.[0]).toMatchObject({ filament_display: "spoolman:1:2", filament_hex: "#112233", spoolman_spool_id: "spoolman:1:s1" });
    expect(result.current.roles.data?.slice(1)).toEqual(mockRoles.slice(1));
    expect(result.current.catalog.data).toMatchObject({ spoolman_colors: [], spoolman_status: "disabled", colors: mockCatalog.colors });
  };
  const toggle = (enabled: boolean) => client.setQueryData(queryKeys.planFeatures(1), planFeaturesData(1, enabled));
  act(() => { toggle(false); toggle(true); });
  await waitFor(() => { for (const queue of Object.values(pending)) expect(queue.length).toBeGreaterThan(0); });
  assertMasked();
  expect(client.getQueryData<PlanReview>(queryKeys.planReview(1, true))?.part_groups[0]?.parts[0]?.spool_badge).toBeNull();
  expect(client.getQueryState(queryKeys.planReview(1, true))?.isInvalidated).toBe(true);
  expect(client.getQueryData<PlanReview>(queryKeys.planReview(2))?.part_groups[0]?.parts[0]?.spool_badge).toBe("450g left");
  expect(client.getQueryData(queryKeys.roleFilaments(2))).toEqual(mockRoles);
  for (const id of [undefined, 2]) expect(client.getQueryData(queryKeys.filamentCatalog(id))).toEqual(mockCatalog);
  const freshReview = { ...enrichedReview, part_groups: enrichedReview.part_groups.map((group) => ({
    ...group, parts: group.parts.map((part) => ({ ...part, spool_badge: "480g left" })),
  })) };
  const freshRoles = mockRoles.map((row) => row.filament_color_id?.startsWith("spoolman:") ? { ...row, filament_display: "Fresh Blue" } : row);
  const freshCatalog = { ...mockCatalog, spoolman_colors: mockCatalog.spoolman_colors?.map((color) => ({ ...color, id: "spoolman:1:fresh" })) ?? [] };
  const bodies = { review: freshReview, roles: { roles: freshRoles }, catalog: freshCatalog };
  const response = (body: unknown) => new Response(JSON.stringify(body), { status: mode === "error" ? 500 : 200, headers: { "content-type": "application/json" } });
  if (mode === "revoked response") {
    const counts = Object.values(pending).map((queue) => queue.length);
    act(() => { toggle(false); toggle(true); });
    await waitFor(() => Object.values(pending).forEach((queue, index) => expect(queue.length).toBeGreaterThan(counts[index] ?? 0)));
  }
  await act(async () => {
    for (const key of ["review", "roles", "catalog"] satisfies Array<keyof typeof pending>) {
      for (const finish of pending[key].slice(0, -1)) finish(response(bodies[key]));
    }
  });
  assertMasked();
  for (const key of ["review", "roles", "catalog"] satisfies Array<keyof typeof pending>) pending[key].at(-1)?.(response(bodies[key]));
  if (mode === "error") {
    await waitFor(() => { for (const query of Object.values(result.current)) expect(query.isError).toBe(true); });
    assertMasked();
  } else {
    await waitFor(() => {
      expect(result.current.review.data?.part_groups[0]?.parts[0]?.spool_badge).toBe("480g left");
      expect(result.current.roles.data).toEqual(freshRoles);
      expect(result.current.catalog.data?.spoolman_colors).toEqual(freshCatalog.spoolman_colors);
    });
  }
});

it("loads ordinary catalog and delayed role data during disabled startup", async () => {
  planSpoolman = false;
  client.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
  client.setQueryData(queryKeys.planFeatures(1), planFeaturesData(1, false));
  let finishRoles: ((response: Response) => void) | undefined;
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => String(input).includes("/role-filaments")
    ? new Promise<Response>((resolve) => { finishRoles = resolve; }) : originalFetch(input)));
  const { result } = renderHook(() => {
    useSpoolmanWorkflowAccess(1);
    const catalog = useFilamentCatalogQuery({ profileId: 1 });
    const roles = useRoleFilamentsQuery(1);
    return { catalog, roles };
  }, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  await waitFor(() => expect(result.current.catalog.isSuccess).toBe(true));
  expect(result.current.catalog.data?.colors).toEqual(mockCatalog.colors);
  expect(result.current.catalog.data?.spoolman_colors).toEqual([]);
  expect(result.current.catalog.data?.spoolman_status).toBe("disabled");
  if (!finishRoles) throw new Error("Role read did not start");
  finishRoles(new Response(JSON.stringify({ roles: mockRoles }), { headers: { "content-type": "application/json" } }));
  await waitFor(() => expect(result.current.roles.isSuccess).toBe(true));
  expect(result.current.roles.data?.[1]).toEqual(mockRoles[1]);
});
