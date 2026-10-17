// @vitest-environment jsdom
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TENANT_FEATURE_TOGGLES_CAPABILITY, type PlanFeatures } from "@print-partner/contracts";
import type { FilamentCatalog, RoleFilamentRow } from "../api/endpoints/filaments";
import * as colorPresets from "../lib/colorPresets";
import { queryKeys } from "../queries/keys";
import RoleFilamentPicker from "./RoleFilamentPicker";

vi.mock("../api/endpoints/media", () => ({ regeneratePlanThumbnails: vi.fn() }));
vi.mock("../lib/thumbnailCache", () => ({ bumpThumbnailCache: vi.fn() }));

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
let gated: boolean;
let allowed: boolean;
let catalog: FilamentCatalog;
let requests: Array<{ url: URL; method: string; body: unknown }>;
let intercept: ((url: URL, init?: RequestInit) => Response | Promise<Response> | undefined) | undefined;

function features(profileId: number, enabled: boolean): PlanFeatures {
  return {
    profile_id: profileId,
    overrides: { spoolman: enabled },
    effective: {
      farm: { enabled: false, source: "default" },
      orders: { enabled: false, source: "default" },
      bambu: { enabled: false, source: "default" },
      spoolman: { enabled, source: "plan" },
    },
  };
}

const roles: RoleFilamentRow[] = [
  { role: "primary", part_count: 2, filament_color_id: "spoolman:int-1:filament:2", spoolman_spool_id: "spoolman:int-1:spool:5", filament_custom_hex: null, filament_display: "Spoolman Blue", filament_hex: "#0000ff" },
  { role: "accent", part_count: 1, filament_color_id: "c1", spoolman_spool_id: null, filament_custom_hex: null, filament_display: "Catalog Red", filament_hex: "#ff0000" },
];
const spoolsPath = "/api/v1/integrations/int-1/spoolman/spools";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
});
const mutationResult = { updated: 1, thumbnails_cleared: 0, roles };
const count = (path: string) => requests.filter((request) => request.url.pathname === path).length;
const writes = () => requests.filter((request) => request.method === "PUT").map((request) => request.body);

function seedAccess() {
  client.setQueryData(queryKeys.health, {
    ok: true, version: "test", data_dir: "test", deploy_mode: "self-host",
    capabilities: gated ? [TENANT_FEATURE_TOGGLES_CAPABILITY] : [],
  });
  client.setQueryData(queryKeys.planFeatures(1), features(1, allowed));
}

function setAccess(enabled: boolean) {
  allowed = enabled;
  act(() => { client.setQueryData(queryKeys.planFeatures(1), features(1, enabled)); });
}

async function openPrimary() {
  fireEvent.click(await screen.findByRole("button", { name: "Change Primary color" }));
}

function importPreset(presetRoles: Parameters<typeof colorPresets.applyColorPreset>[1]["roles"]) {
  vi.spyOn(colorPresets, "pickColorPresetFile").mockResolvedValue(new File(["{}"], "colors.json"));
  vi.spyOn(colorPresets, "parseColorPreset").mockResolvedValue({
    type: "print-partner-colors", version: 1, exported_at: "now", roles: presetRoles,
  });
  fireEvent.click(screen.getByRole("button", { name: "Import colors" }));
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  gated = true;
  allowed = true;
  requests = [];
  intercept = undefined;
  catalog = {
    synced_at: "now", source: "test", status: "ok",
    colors: [{ id: "c1", display_name: "Catalog Red", product_line: "PLA", hex: "#ff0000", combo_label: "Catalog Red", swatch_url: "" }],
    custom_colors: [{ id: "custom:1", display_name: "Custom Teal", product_line: "PLA", hex: "#008080", combo_label: "Custom Teal", swatch_url: "" }],
    spoolman_colors: [{ id: "spoolman:int-1:filament:2", display_name: "Spoolman Blue", product_line: "PETG", hex: "#0000ff", combo_label: "Spoolman Blue", swatch_url: "" }],
    default_spoolman_integration_id: "int-1", spoolman_status: "ok",
  };
  seedAccess();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    requests.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    const response = await intercept?.(url, init);
    if (response) return response;
    if (url.pathname === "/health") return json(client.getQueryData(queryKeys.health));
    if (/^\/plans\/\d+\/features$/.test(url.pathname)) return json(features(Number(url.pathname.split("/")[2]), allowed));
    if (url.pathname === "/filaments/catalog") return json(catalog);
    if (url.pathname.endsWith("/role-filaments")) return json({ roles });
    if (url.pathname.endsWith("/role-filament") || url.pathname.endsWith("/apply-role-colors")) return json(mutationResult);
    if (url.pathname === spoolsPath) return json({ spools: [{ id: 5, filament_id: 2, remaining_weight: 850, location: "Shelf A" }] });
    throw new Error("Unexpected request: " + url.pathname);
  }));
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RoleFilamentPicker Plan access", () => {
  it.each([
    ["integration is disabled in Settings", "Spoolman: integration is disabled in Settings"],
    [null, "Spoolman integration is disabled — enable it in Settings → Integrations."],
  ])("gate off preserves main's disabled integration hint: %s", async (error, hint) => {
    gated = false;
    allowed = false;
    seedAccess();
    catalog = { ...catalog, spoolman_colors: [], spoolman_status: "disabled", spoolman_error: error };
    render(<RoleFilamentPicker profileId={1} />, { wrapper });

    await openPrimary();
    expect(screen.getByText(hint)).toBeTruthy();
    expect(screen.getByText("Spoolman Blue")).toBeTruthy();
    expect(screen.getByText("Catalog")).toBeTruthy();
    expect(screen.getByText("Custom")).toBeTruthy();
    expect(screen.queryByText("Spoolman")).toBeNull();
    expect(screen.queryByLabelText("Physical spool for Primary")).toBeNull();
    expect(count("/plans/1/features")).toBe(0);
    expect(count("/filaments/catalog")).toBe(1);
    expect(count("/plans/1/role-filaments")).toBe(1);
    expect(count(spoolsPath)).toBe(0);
  });

  it("gate off preserves main's options and fetch counts despite denied cached Plan access", async () => {
    gated = false;
    allowed = false;
    seedAccess();
    render(<RoleFilamentPicker profileId={1} />, { wrapper });

    await openPrimary();
    expect(await screen.findByLabelText("Physical spool for Primary")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Spoolman Blue" })).toBeTruthy();
    expect(screen.getByText("Catalog")).toBeTruthy();
    expect(screen.getByText("Custom")).toBeTruthy();
    expect(count("/plans/1/features")).toBe(0);
    expect(count("/filaments/catalog")).toBe(1);
    expect(count("/plans/1/role-filaments")).toBe(1);
    expect(count(spoolsPath)).toBe(1);
  });

  it("gate off imports Spoolman references with main's payloads and fetch counts", async () => {
    gated = false;
    allowed = false;
    seedAccess();
    render(<RoleFilamentPicker profileId={1} />, { wrapper });
    await screen.findByRole("button", { name: "Change Primary color" });
    const role = { role: "primary", filament_color_id: "spoolman:int-1:filament:2", filament_custom_hex: null, spoolman_spool_id: "5" };
    importPreset([role]);

    await waitFor(() => expect(count("/plans/1/apply-role-colors")).toBe(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import colors" })).toHaveProperty("disabled", false));
    expect(writes()).toEqual([{ ...role, refresh_thumbnails: false }]);
    expect(count("/plans/1/features")).toBe(0);
    expect(count("/plans/1/role-filaments")).toBe(1);
    expect(count("/filaments/catalog")).toBe(1);
    expect(count(spoolsPath)).toBe(1);
  });

  it("masks cached and successful denied reads and hides Spoolman options", async () => {
    allowed = false;
    seedAccess();
    client.setQueryData(queryKeys.filamentCatalog(1, false), catalog);
    client.setQueryData(queryKeys.roleFilaments(1, false), roles);
    const onRolesChange = vi.fn();
    render(<RoleFilamentPicker profileId={1} onRolesChange={onRolesChange} />, { wrapper });

    await openPrimary();
    await waitFor(() => expect(count("/plans/1/role-filaments")).toBe(1));
    expect(screen.queryByText("Spoolman Blue")).toBeNull();
    expect(screen.getByText("spoolman:int-1:filament:2")).toBeTruthy();
    expect(screen.queryByText("Spoolman")).toBeNull();
    expect(screen.queryByLabelText("Physical spool for Primary")).toBeNull();
    expect(screen.queryByText(/Spoolman:/)).toBeNull();
    expect(screen.getByText("Catalog")).toBeTruthy();
    expect(screen.getByText("Custom")).toBeTruthy();
    expect(onRolesChange).toHaveBeenLastCalledWith([
      { ...roles[0], filament_display: roles[0]?.filament_color_id, filament_hex: null }, roles[1],
    ]);
    expect(count(spoolsPath)).toBe(0);
    expect(requests.find((request) => request.url.pathname === "/filaments/catalog")?.url.searchParams.get("profile_id")).toBe("1");
    expect(client.getQueryData(queryKeys.filamentCatalog())).toBeUndefined();
  });

  it("refetches scoped catalog, roles and spools when access is restored", async () => {
    render(<RoleFilamentPicker profileId={1} />, { wrapper });
    await openPrimary();
    await screen.findByLabelText("Physical spool for Primary");
    const initialCatalog = count("/filaments/catalog");
    const initialRoles = count("/plans/1/role-filaments");
    const initialSpools = count(spoolsPath);

    setAccess(false);
    await waitFor(() => expect(screen.queryByText("Spoolman Blue")).toBeNull());
    expect(screen.queryByLabelText("Physical spool for Primary")).toBeNull();
    expect(screen.queryByText("Spoolman")).toBeNull();

    catalog = { ...catalog, spoolman_colors: catalog.spoolman_colors?.map((color) => ({ ...color, combo_label: "Fresh inventory blue" })) };
    setAccess(true);
    await screen.findByRole("button", { name: "Fresh inventory blue" });
    await screen.findByLabelText("Physical spool for Primary");
    expect(count("/filaments/catalog")).toBeGreaterThan(initialCatalog);
    expect(count("/plans/1/role-filaments")).toBeGreaterThan(initialRoles);
    expect(count(spoolsPath)).toBeGreaterThan(initialSpools);
    expect(requests.filter((request) => request.url.pathname === spoolsPath).every((request) => request.url.searchParams.get("profile_id") === "1")).toBe(true);
  });

  it.each(["catalog", "spool"])("refreshes access and shows feedback after a denied %s assignment", async (kind) => {
    render(<RoleFilamentPicker profileId={1} />, { wrapper });
    await openPrimary();
    await screen.findByLabelText("Physical spool for Primary");
    const before = count("/plans/1/features");
    intercept = (url, init) => {
      if (url.pathname.endsWith("/role-filament") && init?.method === "PUT") {
        allowed = false;
        return json({ status: 403, code: "FEATURE_DISABLED", detail: "Feature spoolman is disabled." }, 403);
      }
    };

    if (kind === "catalog") fireEvent.click(screen.getByRole("button", { name: "Spoolman Blue" }));
    else fireEvent.change(screen.getByLabelText("Physical spool for Primary"), { target: { value: "5" } });

    await screen.findByText(/Feature spoolman is disabled/);
    await waitFor(() => expect(count("/plans/1/features")).toBeGreaterThan(before));
    await waitFor(() => expect(client.getQueryData<PlanFeatures>(queryKeys.planFeatures(1))?.effective.spoolman.enabled).toBe(false));
    expect(screen.queryByLabelText("Physical spool for Primary")).toBeNull();
    expect(screen.queryByText("Spoolman Blue")).toBeNull();
    expect(screen.getByText("Save failed")).toBeTruthy();
  });

  it("imports ordinary colors while stripping inaccessible Spoolman references", async () => {
    setAccess(false);
    render(<RoleFilamentPicker profileId={1} />, { wrapper });
    await screen.findByRole("button", { name: "Change Primary color" });
    importPreset([
      { role: "primary", filament_color_id: "spoolman:int-1:filament:2", filament_custom_hex: "#112233", spoolman_spool_id: "5" },
      { role: "accent", filament_color_id: "c1", filament_custom_hex: null, spoolman_spool_id: "5" },
      { role: "other", filament_color_id: null, filament_custom_hex: "#abcdef", spoolman_spool_id: null },
    ]);

    await waitFor(() => expect(count("/plans/1/apply-role-colors")).toBe(1));
    expect(writes()).toEqual([
      { role: "primary", filament_color_id: null, filament_custom_hex: "#112233", spoolman_spool_id: null, refresh_thumbnails: true },
      { role: "accent", filament_color_id: "c1", filament_custom_hex: null, spoolman_spool_id: null, refresh_thumbnails: true },
      { role: "other", filament_color_id: null, filament_custom_hex: "#abcdef", spoolman_spool_id: null, refresh_thumbnails: true },
    ]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Import colors" })).toHaveProperty("disabled", false));
    expect(screen.queryByText("Spoolman Blue")).toBeNull();
  });

  it("refreshes access after an import is denied and reloads partial assignments", async () => {
    render(<RoleFilamentPicker profileId={1} />, { wrapper });
    await screen.findByRole("button", { name: "Change Primary color" });
    const before = count("/plans/1/features");
    intercept = (url, init) => {
      if (url.pathname.endsWith("/role-filament") && init?.method === "PUT" && writes().length === 2) {
        allowed = false;
        return json({ status: 403, code: "FEATURE_DISABLED", detail: "Feature spoolman is disabled." }, 403);
      }
    };
    importPreset([
      { role: "accent", filament_color_id: "c1", filament_custom_hex: null, spoolman_spool_id: null },
      { role: "primary", filament_color_id: "spoolman:int-1:filament:2", filament_custom_hex: null, spoolman_spool_id: null },
    ]);

    await screen.findByText(/Feature spoolman is disabled/);
    await waitFor(() => expect(count("/plans/1/features")).toBeGreaterThan(before));
    expect(writes()).toHaveLength(2);
    expect(count("/plans/1/apply-role-colors")).toBe(0);
    await waitFor(() => expect(count("/plans/1/role-filaments")).toBeGreaterThan(1));
  });

  it("does not apply imported colors after access is revoked during a save", async () => {
    render(<RoleFilamentPicker profileId={1} />, { wrapper });
    await screen.findByRole("button", { name: "Change Primary color" });
    intercept = (url, init) => {
      if (url.pathname.endsWith("/role-filament") && init?.method === "PUT") {
        client.setQueryData(queryKeys.planFeatures(1), features(1, false));
        allowed = false;
        return json(mutationResult);
      }
    };
    importPreset([{ role: "primary", filament_color_id: "spoolman:int-1:filament:2", filament_custom_hex: null, spoolman_spool_id: null }]);

    await screen.findByText("Spoolman integration is disabled.");
    expect(writes()).toHaveLength(1);
    expect(count("/plans/1/apply-role-colors")).toBe(0);
  });

  it("ignores an import completion after switching Plans and refreshes the original Plan", async () => {
    let finish: ((response: Response) => void) | undefined;
    intercept = (url, init) => url.pathname === "/plans/1/role-filament" && init?.method === "PUT"
      ? new Promise<Response>((resolve) => { finish = resolve; }) : undefined;
    const { rerender } = render(<RoleFilamentPicker profileId={1} />, { wrapper });
    await screen.findByRole("button", { name: "Change Primary color" });
    importPreset([{ role: "accent", filament_color_id: "c1", filament_custom_hex: null, spoolman_spool_id: null }]);
    await waitFor(() => expect(finish).toBeDefined());
    rerender(<RoleFilamentPicker profileId={2} />);
    await screen.findByRole("button", { name: "Change Primary color" });
    expect(screen.getByRole("button", { name: "Import colors" })).toHaveProperty("disabled", false);

    await act(async () => { finish?.(json(mutationResult)); });
    expect(count("/plans/1/apply-role-colors")).toBe(0);
    expect(count("/plans/2/apply-role-colors")).toBe(0);
    expect(client.getQueryState(queryKeys.roleFilaments(1))?.isInvalidated).toBe(true);
    expect(client.getQueryData<RoleFilamentRow[]>(queryKeys.roleFilaments(2))?.[0]?.filament_color_id).toBe(roles[0]?.filament_color_id);
  });
});
