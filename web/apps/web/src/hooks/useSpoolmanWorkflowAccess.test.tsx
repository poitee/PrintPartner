// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PlanReview } from "../api/endpoints/planManifests";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TENANT_FEATURE_TOGGLES_CAPABILITY,
  type PlanFeatures,
} from "@print-partner/contracts";
import type { FilamentCatalog } from "../api/endpoints/filaments";
import { queryKeys } from "../queries/keys";
import { useSpoolmanWorkflowAccess } from "./useSpoolmanWorkflowAccess";
import { useSpoolmanEnabled } from "./useSpoolmanEnabled";
import { useSpoolmanSpoolsQuery } from "../queries/filaments";
import { usePlanReviewQuery } from "../queries/planReview";

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
  it.each([false, true])("uses the server-resolved Plan choice %s", async (enabled) => {
    planSpoolman = enabled;
    const { result } = renderHook(() => useSpoolmanWorkflowAccess(1), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    await waitFor(() => expect(client.getQueryState(queryKeys.planFeatures(1))?.status).toBe("success"));
    expect(result.current.allowed).toBe(enabled);
    expect(result.current.currentAccessAllowed()).toBe(enabled);
    expect(requests).not.toContain("/settings/features");
  });

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

  it("tracks plan switch cleanly", async () => {
    client.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
    client.setQueryData(queryKeys.planFeatures(1), planFeaturesData(1, true));
    client.setQueryData(queryKeys.planFeatures(2), planFeaturesData(2, false));

    const { result, rerender } = renderHook(({ id }) => useSpoolmanWorkflowAccess(id), {
      initialProps: { id: 1 },
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    expect(result.current.allowed).toBe(true);

    rerender({ id: 2 });
    expect(result.current.allowed).toBe(false);
  });

  it("beginAction provides isCurrent and isSpoolmanAllowed checks", async () => {
    client.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
    client.setQueryData(queryKeys.planFeatures(1), planFeaturesData(1, true));

    const { result, rerender } = renderHook(({ id }) => useSpoolmanWorkflowAccess(id), {
      initialProps: { id: 1 },
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    const action = result.current.beginAction();
    expect(action.isCurrent()).toBe(true);
    expect(action.isSpoolmanAllowed()).toBe(true);

    act(() => {
      client.setQueryData(queryKeys.planFeatures(1), planFeaturesData(1, false));
    });

    expect(action.isCurrent()).toBe(true);
    expect(action.isSpoolmanAllowed()).toBe(false);

    rerender({ id: 2 });
    expect(action.isCurrent()).toBe(false);
    expect(action.isSpoolmanAllowed()).toBe(false);
  });

  it("invalidates cached catalog with disabled status when allowed becomes true", async () => {
    client.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
    client.setQueryData(queryKeys.planFeatures(1), planFeaturesData(1, false));
    client.setQueryData(queryKeys.filamentCatalog(1), { ...mockCatalog, spoolman_status: "disabled" });

    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    const { rerender } = renderHook(({ id }) => useSpoolmanWorkflowAccess(id), {
      initialProps: { id: 1 },
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    expect(invalidateSpy).not.toHaveBeenCalled();

    act(() => {
      client.setQueryData(queryKeys.planFeatures(1), planFeaturesData(1, true));
    });
    rerender({ id: 1 });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.filamentCatalog(1) });
    });
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

describe("useSpoolmanEnabled", () => {
  it("masks spoolman choices when disallowed even if cached", async () => {
    client.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
    client.setQueryData(queryKeys.planFeatures(1), planFeaturesData(1, false));
    client.setQueryData(queryKeys.filamentCatalog(1), mockCatalog);

    const { result } = renderHook(() => useSpoolmanEnabled(1), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    expect(result.current.enabled).toBe(false);
    expect(result.current.configured).toBe(false);
    expect(result.current.integrationId).toBeNull();
    expect(result.current.catalog?.spoolman_colors).toEqual([]);
    expect(result.current.catalog?.colors.length).toBe(1);
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

it.each(["refresh", "error", "revoked response"])("keeps mounted Review stock cleared across off/on until fresh: %s", async (mode) => {
  planSpoolman = true;
  client.setDefaultOptions({ queries: { retry: false, staleTime: 30_000 } });
  client.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
  client.setQueryData(queryKeys.planFeatures(1), planFeaturesData(1, true));
  for (const id of [1, 2]) for (const excluded of [false, true]) {
    client.setQueryData(queryKeys.planReview(id, excluded), { ...enrichedReview, profile_id: id });
  }
  const pending: Array<(response: Response) => void> = [];
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => String(input).includes("/review")
    ? new Promise<Response>((resolve) => pending.push(resolve)) : originalFetch(input)));
  const { result } = renderHook(() => {
    useSpoolmanWorkflowAccess(1);
    useSpoolmanWorkflowAccess(1);
    return usePlanReviewQuery(1);
  }, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  expect(result.current.data?.part_groups[0]?.parts[0]?.spool_badge).toBe("450g left");
  const toggle = (enabled: boolean) => client.setQueryData(queryKeys.planFeatures(1), planFeaturesData(1, enabled));
  act(() => { toggle(false); toggle(true); });
  await waitFor(() => expect(pending.length).toBeGreaterThan(0));
  const part = () => result.current.data?.part_groups[0]?.parts[0];
  expect(part()).toMatchObject({ spool_badge: null, filament_display: "", filament_color_id: "spoolman:1:filament:2" });
  expect(client.getQueryData<PlanReview>(queryKeys.planReview(1, true))?.part_groups[0]?.parts[0]?.spool_badge).toBeNull();
  expect(client.getQueryState(queryKeys.planReview(1, true))?.isInvalidated).toBe(true);
  expect(client.getQueryData<PlanReview>(queryKeys.planReview(2))?.part_groups[0]?.parts[0]?.spool_badge).toBe("450g left");
  const before = pending.length;
  if (mode === "revoked response") {
    act(() => { toggle(false); toggle(true); });
    await waitFor(() => expect(pending.length).toBeGreaterThan(before));
  }
  const response = () => new Response(JSON.stringify(enrichedReview), { status: mode === "error" ? 500 : 200, headers: { "content-type": "application/json" } });
  await act(async () => { for (const finish of pending.slice(0, -1)) finish(response()); });
  expect(part()?.spool_badge).toBeNull();
  pending.at(-1)?.(response());
  if (mode === "error") {
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(part()?.spool_badge).toBeNull();
  } else await waitFor(() => expect(part()?.spool_badge).toBe("450g left"));
});
