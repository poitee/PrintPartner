// @vitest-environment jsdom
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TENANT_FEATURE_TOGGLES_CAPABILITY, type PlanFeatures } from "@print-partner/contracts";
import type { FilamentCatalog, RoleFilamentRow } from "../api/endpoints/filaments";
import type { PlanReview } from "../api/endpoints/planManifests";
import { queryKeys } from "../queries/keys";
import { useFilamentCatalogQuery, useSpoolmanSpoolsQuery } from "../queries/filaments";
import { usePlanReviewQuery } from "../queries/planReview";
import { useRoleFilamentsQuery } from "../queries/roleFilaments";
import { useSpoolmanEnabled } from "./useSpoolmanEnabled";
import { useSpoolmanWorkflowAccess } from "./useSpoolmanWorkflowAccess";

let client: QueryClient;
let capabilities: string[];
let healthState: "ok" | "unhealthy" | "error";
let planEnabled: boolean;
let requests: string[];
let pending: Array<() => void> | null;
let badge: string;

function features(profileId: number, enabled: boolean): PlanFeatures {
  return {
    profile_id: profileId, overrides: { spoolman: enabled },
    effective: {
      farm: { enabled: false, source: "default" }, orders: { enabled: false, source: "default" },
      bambu: { enabled: false, source: "default" }, spoolman: { enabled, source: "plan" },
    },
  };
}

const catalog: FilamentCatalog = {
  synced_at: "now", source: "test", status: "ok", custom_colors: [],
  colors: [{ id: "c1", display_name: "Catalog Red", product_line: "PLA", hex: "#ff0000", combo_label: "Red", swatch_url: "" }],
  spoolman_colors: [{ id: "spoolman:1:2", display_name: "Blue", product_line: "PETG", hex: "#0000ff", combo_label: "Blue", swatch_url: "" }],
  default_spoolman_integration_id: "int-1", spoolman_status: "ok",
};
const review: PlanReview = {
  profile_id: 1, accepted_basis: null, plan_name: "Proof", layers: [], issues: [], has_blockers: false,
  totals: { included_parts: 1, total_print_units: 1, by_role: {}, by_filament: {} },
  part_groups: [{ folder: "parts", source_layer: null, parts: [{
    id: 1, match_key: "a.stl", relative_path: "a.stl", filename: "a.stl", source_layer: null,
    status: "ok", role: "primary", requirement: null, option_group_id: null, included: true,
    filament_color_id: "spoolman:1:2", spoolman_spool_id: "spoolman:1:spool:5",
    quantity_auto: 1, quantity_override: null, quantity_effective: 1, printed_count: 0,
    print_units: [false], missing: true, filament_display: "Blue", filament_hex: "#0000ff",
    spool_badge: "450g left", spool_summary: [{ remaining_g: 450, spool_id: 5 }],
  }] }],
};
const roles: RoleFilamentRow[] = [
  { role: "primary", part_count: 1, filament_color_id: "spoolman:1:2", spoolman_spool_id: "5", filament_custom_hex: "#112233", filament_display: "Blue", filament_hex: "#0000ff" },
  { role: "accent", part_count: 1, filament_color_id: "c1", filament_custom_hex: null, filament_display: "Red", filament_hex: "#ff0000" },
];
const spools = [{ id: 5, filament_id: 2, remaining_weight: 450 }];
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

function useObservations(profileId = 1) {
  const access = useSpoolmanWorkflowAccess(profileId);
  const inventory = useSpoolmanEnabled(profileId);
  const catalogQuery = useFilamentCatalogQuery({ profileId });
  const reviewQuery = usePlanReviewQuery(profileId);
  const rolesQuery = useRoleFilamentsQuery(profileId);
  const spoolsQuery = useSpoolmanSpoolsQuery("int-1", { profileId });
  return { access, inventory, catalogQuery, reviewQuery, rolesQuery, spoolsQuery };
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, staleTime: 30_000, gcTime: Infinity } } });
  capabilities = [TENANT_FEATURE_TOGGLES_CAPABILITY];
  healthState = "ok";
  planEnabled = true;
  requests = [];
  pending = null;
  badge = "450g left";
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    const path = url.pathname;
    requests.push(path + url.search);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path === "/health") return json({ ok: healthState === "ok", version: "test", data_dir: "test", capabilities }, healthState === "error" ? 500 : 200);
    if (/^\/plans\/\d+\/features$/.test(path)) return json(features(Number(path.split("/")[2]), planEnabled));
    if (pending) await new Promise<void>((resolve) => pending?.push(resolve));
    if (path === "/filaments/catalog") return json(catalog);
    if (path.includes("/spoolman/spools")) return json({ spools });
    if (path.endsWith("/role-filaments")) return json({ roles });
    if (path.endsWith("/review")) return json({ ...review, part_groups: review.part_groups.map((group) => ({ ...group, parts: group.parts.map((part) => ({ ...part, spool_badge: badge })) })) });
    throw new Error(`Unexpected request: ${path}`);
  }));
});
afterEach(() => { cleanup(); client.clear(); focusManager.setFocused(undefined); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Spoolman workflow access", () => {
  it("fetches discovery once when a failed features query retries on mount", async () => {
    client.setQueryData(queryKeys.health, { ok: true, capabilities });
    await expect(client.fetchQuery({
      queryKey: queryKeys.planFeatures(1),
      queryFn: () => Promise.reject(new Error("offline")),
    })).rejects.toThrow("offline");
    const fetch = globalThis.fetch;
    let finishFeatures: (response: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => String(input).endsWith("/features")
      ? new Promise<Response>((resolve) => { finishFeatures = resolve; }) : fetch(input)));

    const { result } = renderHook(() => useFilamentCatalogQuery({ profileId: 1 }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      finishFeatures(new Response(JSON.stringify(features(1, true)), { headers: { "content-type": "application/json" } }));
    });
    await waitFor(() => expect(result.current.data?.spoolman_colors).toEqual(catalog.spoolman_colors));
    expect(requests.filter((path) => path.startsWith("/filaments/catalog"))).toEqual([
      "/filaments/catalog?profile_id=1",
    ]);
  });

  it("masks loaded spools while Plan features are pending, then reveals them when allowed", async () => {
    client.setQueryData(queryKeys.health, { ok: true, capabilities });
    const fetch = globalThis.fetch;
    let finishFeatures: (response: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => String(input).endsWith("/features")
      ? new Promise<Response>((resolve) => { finishFeatures = resolve; }) : fetch(input)));
    const { result } = renderHook(() => useSpoolmanSpoolsQuery("int-1", { profileId: 1 }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryState(queryKeys.planFeatures(1))?.status).toBe("pending");
    expect(client.getQueryData(queryKeys.spoolmanSpools("int-1", 1, true))).toEqual([
      { id: 5, filament_id: 2, remaining_weight: 450 },
    ]);
    expect(result.current.data).toEqual([]);

    await act(async () => {
      finishFeatures(new Response(JSON.stringify(features(1, true)), { headers: { "content-type": "application/json" } }));
    });
    await waitFor(() => expect(result.current.data).toEqual([
      { id: 5, filament_id: 2, remaining_weight: 450 },
    ]));
    expect(requests.filter((path) => path.includes("/spoolman/spools"))).toHaveLength(1);
  });

  it("keeps gate-off reads fresh across a second observer and window focus within 30 seconds", async () => {
    capabilities = [];
    healthState = "unhealthy";
    const first = renderHook(() => useObservations(), { wrapper });
    await waitFor(() => expect(first.result.current.reviewQuery.isSuccess && first.result.current.rolesQuery.isSuccess
      && first.result.current.catalogQuery.isSuccess && first.result.current.spoolsQuery.isSuccess).toBe(true));
    const second = renderHook(() => useObservations(), { wrapper });
    await waitFor(() => expect(second.result.current.reviewQuery.fetchStatus === "idle" && second.result.current.rolesQuery.fetchStatus === "idle"
      && second.result.current.catalogQuery.fetchStatus === "idle" && second.result.current.spoolsQuery.fetchStatus === "idle").toBe(true));
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect({
      review: requests.filter((path) => path === "/plans/1/review").length,
      roles: requests.filter((path) => path === "/plans/1/role-filaments").length,
      catalog: requests.filter((path) => path === "/filaments/catalog?profile_id=1").length,
      spools: requests.filter((path) => path === "/api/v1/integrations/int-1/spoolman/spools?profile_id=1").length,
    }).toEqual({ review: 1, roles: 1, catalog: 1, spools: 1 });
  });

  it.each(["error", "unhealthy"] as const)("preserves gate-off UI through a health %s, including a cold load", async (state) => {
    capabilities = [];
    healthState = state;
    const { result } = renderHook(() => useObservations(), { wrapper });
    expect(result.current.access.allowed).toBe(true);
    expect(result.current.access.currentAccessAllowed()).toBe(true);
    await waitFor(() => expect(result.current.inventory.configured).toBe(true));
    await waitFor(() => expect(client.getQueryState(queryKeys.health)?.fetchStatus).toBe("idle"));
    expect(result.current.inventory.enabled).toBe(true);
    expect(result.current.catalogQuery.data?.spoolman_colors).toEqual(catalog.spoolman_colors);
    expect(result.current.reviewQuery.data?.part_groups[0]?.parts[0]?.spool_badge).toBe("450g left");
    expect(requests.some((path) => path.endsWith("/features"))).toBe(false);
  });

  it("does not wait for health to load the gate-off catalog", async () => {
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => String(input).endsWith("/health")
      ? new Promise<Response>(() => {}) : fetch(input)));
    const { result } = renderHook(() => useSpoolmanEnabled(1), { wrapper });
    await waitFor(() => expect(result.current.enabled).toBe(true));
  });

  it.each([false, true])("fetches each query once on cold load with gate=%s and multiple consumers", async (gated) => {
    capabilities = gated ? [TENANT_FEATURE_TOGGLES_CAPABILITY] : [];
    // A disabled catalog is a valid response, not a reason for an extra fetch.
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (!String(input).includes("/filaments/catalog")) return fetch(input);
      requests.push(String(input));
      return new Response(JSON.stringify({ ...catalog, spoolman_status: "disabled" }), { headers: { "content-type": "application/json" } });
    }));
    const { result } = renderHook(() => { const first = useObservations(); useObservations(); return first; }, { wrapper });
    await waitFor(() => expect(result.current.reviewQuery.isSuccess && result.current.rolesQuery.isSuccess && result.current.catalogQuery.isSuccess && result.current.spoolsQuery.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.access.currentAccessAllowed()).toBe(true));
    for (const path of ["/health", "/plans/1/review", "/plans/1/role-filaments", "/filaments/catalog?profile_id=1", "/api/v1/integrations/int-1/spoolman/spools?profile_id=1"]) {
      expect(requests.filter((request) => request.endsWith(path)), path).toHaveLength(1);
    }
  });

  it("masks denied reads without errors or cancellation and refetches when restored", async () => {
    client.setQueryData(queryKeys.health, { ok: true, capabilities });
    client.setQueryData(queryKeys.planFeatures(1), features(1, true));
    const { result } = renderHook(() => useObservations(), { wrapper });
    await waitFor(() => expect(result.current.reviewQuery.isSuccess && result.current.rolesQuery.isSuccess && result.current.catalogQuery.isSuccess && result.current.spoolsQuery.isSuccess).toBe(true));
    const transitions: string[] = [];
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (["planReview", "roleFilaments", "filamentCatalog", "spoolmanSpools"].includes(String(event.query.queryKey[0]))) transitions.push(event.query.state.status);
    });
    pending = [];
    act(() => { void client.invalidateQueries({ queryKey: ["planReview", 1] }); });
    await waitFor(() => expect(pending?.length).toBeGreaterThan(0));
    act(() => { client.setQueryData(queryKeys.planFeatures(1), features(1, false)); });
    await waitFor(() => expect(result.current.access.allowed).toBe(false));
    expect(result.current.reviewQuery.data?.part_groups[0]?.parts[0]).toMatchObject({ spool_badge: null, filament_display: "", filament_hex: null });
    expect(result.current.rolesQuery.data?.[0]).toMatchObject({ filament_display: "spoolman:1:2", filament_hex: "#112233", spoolman_spool_id: "5" });
    expect(result.current.rolesQuery.data?.[1]).toEqual(roles[1]);
    expect(result.current.catalogQuery.data).toMatchObject({ spoolman_colors: [], colors: catalog.colors });
    expect(result.current.spoolsQuery.data).toBeUndefined();
    await waitFor(() => expect(pending?.length).toBe(4));
    const finish = pending;
    pending = null;
    await act(async () => { finish.forEach((resolve) => resolve()); });
    await waitFor(() => expect(client.isFetching({ predicate: (query) =>
      ["planReview", "roleFilaments", "filamentCatalog"].includes(String(query.queryKey[0])),
    })).toBe(0));
    expect(result.current.reviewQuery.data?.part_groups[0]?.parts[0]?.spool_badge).toBeNull();
    const count = requests.length;
    badge = "480g left";
    act(() => { client.setQueryData(queryKeys.planFeatures(1), features(1, true)); });
    await waitFor(() => expect(result.current.reviewQuery.data?.part_groups[0]?.parts[0]?.spool_badge).toBe("480g left"));
    expect(requests.slice(count)).toEqual(expect.arrayContaining(["/plans/1/review", "/plans/1/role-filaments", "/filaments/catalog?profile_id=1", "/api/v1/integrations/int-1/spoolman/spools?profile_id=1"]));
    expect(transitions).not.toContain("error");
    expect(client.getQueryCache().getAll().every((query) => query.state.error === null)).toBe(true);
    unsubscribe();
  });

  it("masks successful cached reads during feature refresh and failure", async () => {
    const { result } = renderHook(() => useObservations(), { wrapper });
    await waitFor(() => expect(result.current.reviewQuery.isSuccess && result.current.access.allowed).toBe(true));
    const fetch = globalThis.fetch;
    let reject: (error: Error) => void = () => {};
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => String(input).endsWith("/features")
      ? new Promise<Response>((_resolve, fail) => { reject = fail; }) : fetch(input)));
    act(() => { void client.invalidateQueries({ queryKey: queryKeys.planFeatures(1) }); });
    await waitFor(() => expect(result.current.access.allowed).toBe(false));
    expect(result.current.reviewQuery.data?.part_groups[0]?.parts[0]?.spool_badge).toBeNull();
    act(() => reject(new Error("offline")));
    await waitFor(() => expect(client.getQueryState(queryKeys.planFeatures(1))?.status).toBe("error"));
    expect(result.current.access.allowed).toBe(false);
    expect(result.current.reviewQuery.isError).toBe(false);
  });

  it.each(["health", "features"] as const)("refetches observations when access returns after a %s refresh", async (source) => {
    client.setQueryData(queryKeys.health, { ok: true, capabilities });
    client.setQueryData(queryKeys.planFeatures(1), features(1, true));
    const { result } = renderHook(() => useObservations(), { wrapper });
    await waitFor(() => expect(result.current.reviewQuery.isSuccess && result.current.rolesQuery.isSuccess && result.current.catalogQuery.isSuccess && result.current.spoolsQuery.isSuccess).toBe(true));
    let finishFeatures: (response: Response) => void = () => {};
    if (source === "features") {
      const fetch = globalThis.fetch;
      vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => String(input).endsWith("/features")
        ? new Promise<Response>((resolve) => { finishFeatures = resolve; }) : fetch(input)));
      act(() => { void client.invalidateQueries({ queryKey: queryKeys.planFeatures(1) }); });
    } else {
      act(() => { client.setQueryData(queryKeys.health, { ok: false, capabilities }); });
    }
    await waitFor(() => expect(result.current.access.allowed).toBe(false));
    await waitFor(() => expect(client.isFetching({ predicate: (query) =>
      ["planReview", "roleFilaments", "filamentCatalog"].includes(String(query.queryKey[0])),
    })).toBe(0));
    expect(result.current.reviewQuery.data?.part_groups[0]?.parts[0]?.spool_badge).toBeNull();
    badge = "490g left";
    const count = requests.length;
    await act(async () => {
      if (source === "features") finishFeatures(new Response(JSON.stringify(features(1, true)), { headers: { "content-type": "application/json" } }));
      else client.setQueryData(queryKeys.health, { ok: true, capabilities });
    });
    await waitFor(() => expect(result.current.reviewQuery.data?.part_groups[0]?.parts[0]?.spool_badge).toBe("490g left"));
    expect(requests.slice(count)).toEqual(expect.arrayContaining(["/plans/1/review", "/plans/1/role-filaments", "/filaments/catalog?profile_id=1", "/api/v1/integrations/int-1/spoolman/spools?profile_id=1"]));
    expect(result.current.reviewQuery.isError || result.current.rolesQuery.isError || result.current.catalogQuery.isError).toBe(false);
  });

  it("does not carry cached observations or actions into another Plan", async () => {
    client.setQueryData(queryKeys.health, { ok: true, capabilities });
    client.setQueryData(queryKeys.planFeatures(1), features(1, true));
    client.setQueryData(queryKeys.planFeatures(2), features(1, true));
    const hook = renderHook(({ profileId }) => useObservations(profileId), { initialProps: { profileId: 1 }, wrapper });
    await waitFor(() => expect(hook.result.current.reviewQuery.isSuccess).toBe(true));
    const action = hook.result.current.access.beginAction();
    pending = [];
    hook.rerender({ profileId: 2 });
    expect(hook.result.current.access.allowed).toBe(false);
    expect(hook.result.current.reviewQuery.data).toBeUndefined();
    expect(action.isCurrent()).toBe(false);
    hook.unmount();
  });
});
