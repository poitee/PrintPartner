// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TENANT_FEATURE_TOGGLES_CAPABILITY, type PlanFeatures } from "@print-partner/contracts";
import type { FilamentCatalog, RoleFilamentRow, SpoolmanSpoolRow } from "../api/endpoints/filaments";
import type { ReviewPart } from "../api/endpoints/planManifests";
import * as filamentsApi from "../api/endpoints/filaments";
import * as colorPresets from "../lib/colorPresets";
import { queryKeys } from "../queries/keys";
import RoleFilamentPicker from "./RoleFilamentPicker";
import PartColorDialog from "./review/PartColorDialog";

vi.mock("../api/endpoints/media", () => ({ regeneratePlanThumbnails: vi.fn() }));
vi.mock("../lib/thumbnailCache", () => ({ bumpThumbnailCache: vi.fn() }));

let client: QueryClient;
let planSpoolman = false;

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
  colors: [{ id: "c1", display_name: "Catalog Red", product_line: "PLA", hex: "#ff0000", combo_label: "Catalog Red", swatch_url: "" }],
  custom_colors: [{ id: "custom:1", display_name: "Custom Teal", product_line: "PLA", hex: "#008080", combo_label: "Custom Teal", swatch_url: "" }],
  spoolman_colors: [{ id: "spoolman:int-1:filament:2", display_name: "Spoolman Blue", product_line: "PETG", hex: "#0000ff", combo_label: "Spoolman Blue", swatch_url: "" }],
  default_spoolman_integration_id: "int-1",
  spoolman_status: "ok",
};

const mockRoles: RoleFilamentRow[] = [
  { role: "primary", part_count: 2, filament_color_id: "spoolman:int-1:filament:2", spoolman_spool_id: "spoolman:int-1:spool:5", filament_custom_hex: null, filament_display: "Spoolman Blue", filament_hex: "#0000ff" },
  { role: "accent", part_count: 1, filament_color_id: "c1", spoolman_spool_id: null, filament_custom_hex: null, filament_display: "Catalog Red", filament_hex: "#ff0000" },
];

const mockSpools: SpoolmanSpoolRow[] = [
  { id: 5, filament_id: 2, remaining_weight: 850, location: "Shelf A" },
];

function makeReviewPart(overrides: Partial<ReviewPart> = {}): ReviewPart {
  return {
    id: 1,
    match_key: "test.stl",
    relative_path: "parts/test.stl",
    filename: "test.stl",
    source_layer: null,
    status: "active",
    role: "primary",
    requirement: null,
    option_group_id: null,
    included: true,
    filament_color_id: null,
    quantity_auto: 1,
    quantity_override: null,
    quantity_effective: 1,
    print_units: [false],
    printed_count: 0,
    missing: true,
    filament_display: "Unassigned",
    ...overrides,
  };
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  planSpoolman = false;

  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    const path = url.pathname;
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

    if (path === "/health") {
      return json({ ok: true, version: "test", data_dir: "test", deploy_mode: "self-host", capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY] });
    }
    if (/^\/plans\/\d+\/features$/.test(path)) {
      return json(planFeaturesData(Number(path.split("/")[2]), planSpoolman));
    }
    if (path === "/settings/features") {
      return json({ choices: { spoolman: false }, effective: { spoolman: { enabled: false, source: "default" } } });
    }
    if (path === "/filaments/catalog") {
      return json(planSpoolman ? mockCatalog : { ...mockCatalog, spoolman_colors: [], spoolman_status: "disabled", spoolman_error: "Feature spoolman is disabled." });
    }
    if (path.includes("/role-filaments")) {
      return json({ roles: mockRoles });
    }
    if (path.includes("/spoolman/spools")) {
      return json({ spools: mockSpools });
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

describe("RoleFilamentPicker and PartColorDialog plan-aware visibility", () => {
  it("masks Spoolman choices and suppresses disabled error banner when Spoolman is off", async () => {
    planSpoolman = false;
    render(
      <QueryClientProvider client={client}>
        <RoleFilamentPicker profileId={1} />
      </QueryClientProvider>,
    );

    const button = await screen.findByRole("button", { name: "Change Primary color" });
    expect(screen.queryByText(/Feature spoolman is disabled/)).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Physical spool for Primary" })).toBeNull();

    fireEvent.click(button);
    expect(screen.getByText("Catalog")).toBeTruthy();
    expect(screen.getByText("Custom")).toBeTruthy();
    expect(screen.queryByText("Spoolman")).toBeNull();
    expect(screen.queryByRole("button", { name: /Spoolman Blue/ })).toBeNull();
  });

  it("exposes Spoolman catalog and physical spool picker when Spoolman is on", async () => {
    planSpoolman = true;
    render(
      <QueryClientProvider client={client}>
        <RoleFilamentPicker profileId={1} />
      </QueryClientProvider>,
    );

    const button = await screen.findByRole("button", { name: "Change Primary color" });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText("Spoolman")).toBeTruthy());
    expect(await screen.findByRole("combobox", { name: "Physical spool for Primary" })).toBeTruthy();
  });

  it("PartColorDialog hides Spoolman catalog group and role-copy choices when off", async () => {
    planSpoolman = false;
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <PartColorDialog
          part={makeReviewPart({ id: 1, role: "primary", filament_color_id: "spoolman:int-1:filament:2", filament_display: "Spoolman Blue", filament_hex: "#0000ff" })}
          profileId={1}
          onClose={onClose}
        />
      </QueryClientProvider>,
    );

    await screen.findByText(/accent: Catalog Red/);
    expect(screen.getByText("Current color: Spoolman Blue")).toBeTruthy();

    expect(screen.queryByText(/primary: Spoolman Blue/)).toBeNull();
    expect(screen.getByText(/accent: Catalog Red/)).toBeTruthy();
    expect(screen.queryByText("Spoolman")).toBeNull();
  });

  it("invalidates stale selection when Spoolman role assignment becomes denied", async () => {
    planSpoolman = true;
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <PartColorDialog
          part={makeReviewPart({ id: 1, role: "accent", filament_color_id: "c1", filament_display: "Catalog Red", filament_hex: "#ff0000" })}
          profileId={1}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );

    await screen.findByText(/primary: Spoolman Blue/);
    const select = screen.getByLabelText("Part color");
    fireEvent.change(select, { target: { value: "build:primary" } });
    expect(screen.getByRole("button", { name: "Save part color" })).toHaveProperty("disabled", false);

    planSpoolman = false;
    act(() => {
      client.setQueryData(queryKeys.planFeatures(1), planFeaturesData(1, false));
    });

    rerender(
      <QueryClientProvider client={client}>
        <PartColorDialog
          part={makeReviewPart({ id: 1, role: "accent", filament_color_id: "c1", filament_display: "Catalog Red", filament_hex: "#ff0000" })}
          profileId={1}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("button", { name: "Save part color" })).toHaveProperty("disabled", true);
  });

  it.each(["picker", "assignments"])("stops a revoked import after awaiting %s", async (stage) => {
    planSpoolman = true;
    const applyRoleColorsSpy = vi.spyOn(filamentsApi, "applyRoleColorsToParts");
    const saveRoleFilamentSpy = vi.spyOn(filamentsApi, "saveRoleFilament");

    let resolveFilePicker: (file: File | null) => void = () => {};
    vi.spyOn(colorPresets, "pickColorPresetFile").mockImplementation(
      () => new Promise((resolve) => { resolveFilePicker = resolve; }),
    );
    vi.spyOn(colorPresets, "parseColorPreset").mockResolvedValue({
      type: "print-partner-colors",
      version: 1,
      exported_at: "now",
      roles: [{ role: "primary", filament_color_id: "spoolman:int-1:filament:2", filament_custom_hex: null, spoolman_spool_id: null }],
    });

    if (stage === "assignments") {
      vi.spyOn(colorPresets, "applyColorPreset").mockImplementation(async () => {
        client.setQueryData(queryKeys.planFeatures(1), planFeaturesData(1, false));
        client.setQueryData(queryKeys.planFeatures(1), planFeaturesData(1, true));
        return 1;
      });
    }
    render(
      <QueryClientProvider client={client}>
        <RoleFilamentPicker profileId={1} />
      </QueryClientProvider>,
    );

    await screen.findByRole("button", { name: "Change Primary color" });
    fireEvent.click(screen.getByRole("button", { name: "Import colors" }));

    if (stage === "picker") {
      planSpoolman = false;
      act(() => client.setQueryData(queryKeys.planFeatures(1), planFeaturesData(1, false)));
    }

    await act(async () => {
      resolveFilePicker(new File(["{}"], "preset.json", { type: "application/json" }));
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Import colors" })).toHaveProperty("disabled", false));
    await waitFor(() => {
      expect(saveRoleFilamentSpy).not.toHaveBeenCalled();
      expect(applyRoleColorsSpy).not.toHaveBeenCalled();
    });
  });

  it("resets local busy state on profile change and ignores pending applyColorPreset completion", async () => {
    planSpoolman = true;
    const applyRoleColorsSpy = vi.spyOn(filamentsApi, "applyRoleColorsToParts");
    let resolveApply: ((count: number) => void) | undefined;

    vi.spyOn(colorPresets, "pickColorPresetFile").mockResolvedValue(
      new File(["{}"], "preset.json", { type: "application/json" }),
    );
    vi.spyOn(colorPresets, "parseColorPreset").mockResolvedValue({
      type: "print-partner-colors",
      version: 1,
      exported_at: "now",
      roles: [{ role: "primary", filament_color_id: "c1", filament_custom_hex: null, spoolman_spool_id: null }],
    });
    vi.spyOn(colorPresets, "applyColorPreset").mockImplementation(
      () => new Promise((resolve) => { resolveApply = resolve; }),
    );

    const { rerender } = render(
      <QueryClientProvider client={client}>
        <RoleFilamentPicker profileId={1} />
      </QueryClientProvider>,
    );

    await screen.findByRole("button", { name: "Change Primary color" });
    fireEvent.click(screen.getByRole("button", { name: "Import colors" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Importing…" })).toHaveProperty("disabled", true));

    rerender(
      <QueryClientProvider client={client}>
        <RoleFilamentPicker profileId={2} />
      </QueryClientProvider>,
    );

    const importBtn = await screen.findByRole("button", { name: "Import colors" });
    expect(importBtn).toHaveProperty("disabled", false);

    await act(async () => {
      resolveApply?.(1);
    });

    expect(screen.getByRole("button", { name: "Import colors" })).toHaveProperty("disabled", false);
    expect(applyRoleColorsSpy).not.toHaveBeenCalled();
  });
});
