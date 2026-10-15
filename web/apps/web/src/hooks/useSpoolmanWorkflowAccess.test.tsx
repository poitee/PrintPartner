// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TENANT_FEATURE_TOGGLES_CAPABILITY,
  type PlanFeatures,
} from "@print-partner/contracts";
import type { FilamentCatalog } from "../api/endpoints/filaments";
import { queryKeys } from "../queries/keys";
import { useSpoolmanWorkflowAccess } from "./useSpoolmanWorkflowAccess";
import { useSpoolmanEnabled } from "./useSpoolmanEnabled";

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
