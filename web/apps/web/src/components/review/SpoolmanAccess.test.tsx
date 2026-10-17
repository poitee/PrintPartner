// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { TENANT_FEATURE_TOGGLES_CAPABILITY, type PlanFeatures } from "@print-partner/contracts";
import type { PlanReview, ReviewPart } from "../../api/endpoints/planManifests";
import { queryKeys } from "../../queries/keys";
import { usePlanReviewQuery } from "../../queries/planReview";
import { REVIEW_PARTS_UI_STORAGE_KEY } from "../../lib/persistedReviewPartsUi";
import PartColorDialog from "./PartColorDialog";
import ReviewPartsSheet from "./ReviewPartsSheet";

vi.mock("../../context/ProfileContext", () => ({ useProfileSelection: () => ({ profiles: [] }) }));
vi.mock("../../context/PlanWorkspaceContext", () => ({ usePlanWorkspace: () => ({
  draftWorkspace: null, setQuantity: vi.fn(), setIncluded: vi.fn(), setSpoolmanSpool: vi.fn(), toggleUnit: vi.fn(), busyPartId: null,
}) }));
const layout = vi.hoisted(() => ({ mobile: false }));
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => layout.mobile }));
vi.mock("../parts/PartThumb", () => ({ default: () => null }));
vi.mock("../Preview3D", () => ({ default: ({ meshColor }: { meshColor?: string }) => <output aria-label="Preview color">{meshColor ?? "default"}</output> }));

let client: QueryClient;
let featureReads: number;
let featureEnabled: boolean;
let rejectColor: boolean;
let patches: number;
const part: ReviewPart = {
  id: 1, match_key: "a.stl", relative_path: "a.stl", filename: "a.stl", source_layer: null,
  status: "ok", role: "primary", requirement: null, option_group_id: null, included: true,
  filament_color_id: "spoolman:1:2", spoolman_spool_id: null,
  quantity_auto: 1, quantity_override: null, quantity_effective: 1, printed_count: 0,
  print_units: [false], missing: true, filament_display: "Blue", filament_hex: "#0000ff", spool_badge: "450g left",
};
const review: PlanReview = {
  profile_id: 1, accepted_basis: null, plan_name: "Test", layers: [], issues: [], has_blockers: false,
  totals: { included_parts: 1, total_print_units: 1, by_role: {}, by_filament: {} },
  part_groups: [{ folder: "parts", source_layer: null, parts: [part] }],
};
const catalog = {
  synced_at: "now", source: "test", status: "ok", colors: [], custom_colors: [],
  spoolman_colors: [{ id: part.filament_color_id, display_name: "Blue", product_line: "PLA", hex: "#0000ff", combo_label: "Blue", swatch_url: "" }],
  default_spoolman_integration_id: "int-1", spoolman_status: "ok",
};
function features(enabled: boolean): PlanFeatures {
  return { profile_id: 1, overrides: { spoolman: enabled }, effective: {
    farm: { enabled: false, source: "default" }, orders: { enabled: false, source: "default" },
    bambu: { enabled: false, source: "default" }, spoolman: { enabled, source: "plan" },
  } };
}
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
function ObservedReviewSheet({ profileId }: { profileId: number }) {
  const query = usePlanReviewQuery(profileId, { enabled: false });
  return query.data ? <ReviewPartsSheet review={query.data} planName={query.data.plan_name} /> : null;
}

beforeEach(() => {
  layout.mobile = false;
  localStorage.clear();
  localStorage.setItem(REVIEW_PARTS_UI_STORAGE_KEY, JSON.stringify({ layoutMode: "table", viewMode: "edit" }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(queryKeys.health, { ok: true, capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
  client.setQueryData(queryKeys.planFeatures(1), features(true));
  client.setQueryData(queryKeys.filamentCatalog(1), catalog);
  client.setQueryData(queryKeys.roleFilaments(1), []);
  featureReads = 0;
  featureEnabled = true;
  rejectColor = false;
  patches = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path === "/plans/1/features") { featureReads += 1; return json(features(featureEnabled)); }
    if (path === "/filaments/catalog") return json(catalog);
    if (path === "/plans/1/role-filaments") return json({ roles: [] });
    if (path.includes("/spoolman/spools")) return json({ spools: [] });
    if (path === "/parts/1" && init?.method === "PATCH") {
      patches += 1;
      return rejectColor ? json({ detail: "Feature spoolman is disabled." }, 403) : json(part);
    }
    throw new Error(`Unexpected request: ${path}`);
  }));
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });

it("updates an open preview from current masked Review data on revocation", async () => {
  client.setQueryData(queryKeys.planReview(1), review);
  client.setQueryData(queryKeys.planReview(2), { ...review, profile_id: 2 });
  const view = render(<ObservedReviewSheet profileId={1} />, { wrapper });
  await userEvent.click(screen.getAllByRole("button", { name: "Preview 3D model of a.stl" })[0]!);
  await waitFor(() => expect(screen.getByLabelText("Preview color").textContent).toBe("#0000ff"));
  act(() => { client.setQueryData(queryKeys.planFeatures(1), features(false)); });
  await waitFor(() => expect(screen.getByLabelText("Preview color").textContent).toBe("default"));
  expect(screen.queryByText("450g left")).toBeNull();
  view.rerender(<ObservedReviewSheet profileId={2} />);
  expect(screen.queryByLabelText("Preview color")).toBeNull();
});

it("refreshes feature access and displays a part-color denial", async () => {
  rejectColor = true;
  featureEnabled = false;
  const close = vi.fn();
  render(<PartColorDialog part={part} profileId={1} onClose={close} />, { wrapper });
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Part color" }), "catalog:spoolman:1:2");
  await userEvent.click(screen.getByRole("button", { name: "Save part color" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Feature spoolman is disabled."));
  await waitFor(() => expect(featureReads).toBe(1));
  await waitFor(() => expect(screen.queryByRole("option", { name: "Blue" })).toBeNull());
  expect(patches).toBe(1);
  expect(close).not.toHaveBeenCalled();
});

it("shows feedback and refreshes access when permission changes just before a color save", async () => {
  featureEnabled = false;
  render(<PartColorDialog part={part} profileId={1} onClose={vi.fn()} />, { wrapper });
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Part color" }), "catalog:spoolman:1:2");
  const save = screen.getByRole("button", { name: "Save part color" });
  act(() => {
    client.setQueryData(queryKeys.planFeatures(1), features(false));
    fireEvent.click(save);
  });
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Spoolman access changed"));
  await waitFor(() => expect(featureReads).toBe(1));
  expect(patches).toBe(0);
});

it.each([false, true])("keeps the part-color Spoolman choices with a gate-off unhealthy=%s poll", async (unhealthy) => {
  client.setQueryData(queryKeys.health, { ok: !unhealthy, capabilities: [] });
  render(<PartColorDialog part={part} profileId={1} onClose={vi.fn()} />, { wrapper });
  expect(screen.getByRole("option", { name: "Blue" })).toBeDefined();
  expect(featureReads).toBe(0);
});

it.each(["empty", "loading"] as const)("keeps the gate-off current color label when the live catalog is %s", async (state) => {
  client.setQueryData(queryKeys.health, { ok: false, capabilities: [] });
  client.removeQueries({ queryKey: queryKeys.filamentCatalog(1) });
  const fetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).includes("/filaments/catalog")) return fetch(input, init);
    return state === "loading" ? new Promise<Response>(() => {}) : Promise.resolve(new Response(JSON.stringify({
      ...catalog, spoolman_colors: [],
    }), { headers: { "content-type": "application/json" } }));
  }));
  render(<PartColorDialog part={{ ...part, filament_display: "Blue PLA" }} profileId={1} onClose={vi.fn()} />, { wrapper });
  if (state === "empty") {
    await waitFor(() => expect(client.getQueryState(queryKeys.filamentCatalog(1))?.status).toBe("success"));
  } else {
    expect(screen.getByRole("status").textContent).toBe("Loading colors…");
  }
  expect(screen.getByText("Current color: Blue PLA")).toBeDefined();
});

it.each([false, true])("masks cached enrichment in sheet when access is denied (isMobileLayout: %s)", async (isMobile) => {
  layout.mobile = isMobile;
  localStorage.setItem(REVIEW_PARTS_UI_STORAGE_KEY, JSON.stringify({ layoutMode: "table" }));

  const enrichedReview: PlanReview = {
    ...review,
    totals: { ...review.totals, included_parts: 2, total_print_units: 2 },
    part_groups: [{
      folder: "parts",
      source_layer: null,
      parts: [
        {
          id: 1, match_key: "a.stl", relative_path: "parts/a.stl", filename: "a.stl",
          source_layer: null, status: "ok", role: "primary", requirement: null, option_group_id: null,
          included: true, filament_color_id: "spoolman:int-1:filament:2", spoolman_spool_id: "spoolman:int-1:spool:5",
          quantity_auto: 1, quantity_override: null, quantity_effective: 1, printed_count: 0,
          print_units: [false], missing: true, filament_display: "Spoolman Blue", filament_hex: "#0000ff",
          spool_badge: "450g left", spool_summary: [{ remaining_g: 450, spool_id: 5 }],
        },
        {
          id: 2, match_key: "b.stl", relative_path: "parts/b.stl", filename: "b.stl",
          source_layer: null, status: "ok", role: "accent", requirement: null, option_group_id: null,
          included: true, filament_color_id: "c1", spoolman_spool_id: null,
          quantity_auto: 1, quantity_override: null, quantity_effective: 1, printed_count: 0,
          print_units: [false], missing: true, filament_display: "Catalog Red", filament_hex: "#ff0000",
        },
      ],
    }],
  };

  client.setQueryData(queryKeys.planReview(1), enrichedReview);
  render(<ObservedReviewSheet profileId={1} />, { wrapper });
  expect(screen.getAllByText("450g left").length).toBeGreaterThan(0);
  act(() => { client.setQueryData(queryKeys.planFeatures(1), features(false)); });
  await waitFor(() => expect(screen.queryByText("450g left")).toBeNull());
  expect(screen.queryByText("Spoolman Blue")).toBeNull();
  expect(screen.getAllByText("Catalog Red").length).toBeGreaterThan(0);
  expect(screen.getAllByRole("button", { name: "Remove" }).length).toBe(isMobile ? 4 : 2);
});


it.each([
  { filament_color_id: " spoolman:int-1:filament:2 ", spoolman_spool_id: null },
  { filament_color_id: null, spoolman_spool_id: " spoolman:int-1:spool:5 " },
  { filament_color_id: "catalog:red", spoolman_spool_id: "spoolman:int-1:spool:5" },
])("hides denied build choices and current enrichment for assignment %j", async (assignment) => {
  client.setQueryData(queryKeys.planFeatures(1), features(false));
  const roles = [
    { role: "primary", part_count: 1, ...assignment, filament_custom_hex: null, filament_display: "Spoolman Blue", filament_hex: "#0000ff" },
    { role: "accent", part_count: 1, filament_color_id: "catalog:red", spoolman_spool_id: "  ", filament_custom_hex: null, filament_display: "Catalog Red", filament_hex: "#ff0000" },
  ];
  const fetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => String(input).includes("/role-filaments")
    ? Promise.resolve(new Response(JSON.stringify({ roles }), { headers: { "content-type": "application/json" } }))
    : fetch(input, init)));
  client.setQueryData(queryKeys.roleFilaments(1, false), roles);
  render(<PartColorDialog part={{ ...part, ...assignment }} profileId={1} onClose={vi.fn()} />, { wrapper });
  expect(screen.queryByRole("option", { name: /^primary:/ })).toBeNull();
  await waitFor(() => expect(screen.getByRole("option", { name: "accent: Catalog Red" })).toBeDefined());
  expect(screen.getByText(`Current color: ${assignment.filament_color_id?.trim() || "Unassigned"}`)).toBeDefined();
  expect(screen.queryByText("Current color: Blue")).toBeNull();
});
