// @vitest-environment jsdom

import { cleanup, render as renderRaw, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { PlanReview, ReviewPart } from "../../api/endpoints/planManifests";
import { planFileIdentity } from "../../hooks/usePlanFileChoices";
import { REVIEW_PARTS_UI_STORAGE_KEY } from "../../lib/persistedReviewPartsUi";
import ReviewPartsSheet from "./ReviewPartsSheet";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { queryKeys } from "../../queries/keys";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn(), message: vi.fn(), success: vi.fn() } }));
let queryClient: QueryClient;
function render(ui: Parameters<typeof renderRaw>[0]) {
  return renderRaw(ui, { wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> });
}

const queryMocks = vi.hoisted(() => ({
  usePlanReviewQuery: vi.fn<() => { data: PlanReview | null }>(() => ({ data: null })),
  usePlanWorkspace: vi.fn(),
  spoolmanAllowed: true,
  currentProfile: 7,
  spoolmanConfigured: false,
  spoolmanIntegrationId: null as string | null,
  isMobileLayout: false,
}));

vi.mock("../../context/ProfileContext", () => ({
  useProfileSelection: () => ({ profiles: [] }),
}));
vi.mock("../../context/PlanWorkspaceContext", () => ({
  usePlanWorkspace: queryMocks.usePlanWorkspace,
}));
vi.mock("../../queries/planReview", () => ({
  usePlanReviewQuery: queryMocks.usePlanReviewQuery,
}));
vi.mock("../../queries/roleFilaments", () => ({
  useRoleFilamentsQuery: () => ({ data: [] }),
}));
vi.mock("../../queries/filaments", () => ({
  useSpoolmanSpoolsQuery: () => ({ data: [{ id: 5, filament_id: 2, remaining_weight: 500 }], isLoading: false }),
}));
vi.mock("../../hooks/useSpoolmanWorkflowAccess", () => ({
  useSpoolmanWorkflowAccess: (profileId: number) => {
    queryMocks.currentProfile = profileId;
    return {
      allowed: queryMocks.spoolmanAllowed,
      currentAccessAllowed: () => queryMocks.spoolmanAllowed,
      beginAction: () => ({ isCurrent: () => queryMocks.currentProfile === profileId }),
    };
  },
}));
vi.mock("../../hooks/useSpoolmanEnabled", () => ({
  useSpoolmanEnabled: () => ({
    configured: queryMocks.spoolmanConfigured,
    integrationId: queryMocks.spoolmanIntegrationId,
  }),
}));
vi.mock("../../hooks/useMediaQuery", () => ({
  useMediaQuery: () => queryMocks.isMobileLayout,
}));
vi.mock("../parts/PartThumbExpandButton", () => ({
  default: () => null,
}));

const review: PlanReview = {
  profile_id: 7,
  accepted_basis: null,
  plan_name: "Voron",
  layers: [],
  totals: {
    included_parts: 0,
    total_print_units: 0,
    by_role: {},
    by_filament: {},
  },
  issues: [],
  has_blockers: false,
  part_groups: [],
};

describe("ReviewPartsSheet accessibility", () => {
  afterEach(() => { cleanup(); queryClient.clear(); vi.clearAllMocks(); });

  beforeEach(() => {
    localStorage.clear();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryMocks.spoolmanAllowed = true;
    queryMocks.spoolmanConfigured = false;
    queryMocks.spoolmanIntegrationId = null;
    queryMocks.isMobileLayout = false;
    queryMocks.usePlanReviewQuery.mockReset().mockReturnValue({ data: null });
    queryMocks.usePlanWorkspace.mockReturnValue({
      draftWorkspace: null,
      setQuantity: vi.fn(async () => {}),
      setIncluded: vi.fn(async () => {}),
      setSpoolmanSpool: vi.fn(async () => {}),
      toggleUnit: vi.fn(async () => {}),
      busyPartId: null,
    });
  });

  it("gives the parts search control a persistent accessible name", () => {
    render(
      <MemoryRouter>
        <ReviewPartsSheet review={review} planName="Voron" />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("searchbox", { name: "Search review parts" }).tagName,
    ).toBe("INPUT");
  });

  it.each(["edit", "print"])("shows a pending restore in %s mode with the Included-only filter", (viewMode) => {
    localStorage.setItem(REVIEW_PARTS_UI_STORAGE_KEY, JSON.stringify({ viewMode, layoutMode: "table", includedFilter: "included" }));
    const part: ReviewPart = {
      id: 42, match_key: "bracket.stl", relative_path: "frame/bracket.stl", filename: "bracket.stl",
      source_layer: "base:Voron", status: "ok", role: "primary", requirement: null, option_group_id: null,
      included: false, filament_color_id: null, quantity_auto: 1, quantity_override: null, quantity_effective: 1,
      printed_count: 0, print_units: [false], missing: true, filament_display: "",
    };
    queryMocks.usePlanReviewQuery.mockReturnValue({ data: { ...review, part_groups: [{ folder: "frame", source_layer: part.source_layer, parts: [part] }] } });
    queryMocks.usePlanWorkspace.mockReturnValue({
      draftWorkspace: null,
      pendingFileChoices: new Map([[planFileIdentity(part), { part, included: true }]]),
      setQuantity: vi.fn(), setIncluded: vi.fn(), setSpoolmanSpool: vi.fn(), toggleUnit: vi.fn(), busyPartId: null,
    });
    render(<MemoryRouter><ReviewPartsSheet review={review} planName="Voron" /></MemoryRouter>);
    expect(queryMocks.usePlanReviewQuery).toHaveBeenCalledWith(7, { includeExcluded: true, enabled: true });
    expect(screen.getAllByText("bracket.stl").length).toBeGreaterThan(0);
  });

  it("requests excluded parts without changing the workspace projection", () => {
    localStorage.setItem(
      REVIEW_PARTS_UI_STORAGE_KEY,
      JSON.stringify({ includedFilter: "excluded" }),
    );

    render(
      <MemoryRouter>
        <ReviewPartsSheet review={review} planName="Voron" />
      </MemoryRouter>,
    );

    expect(queryMocks.usePlanReviewQuery).toHaveBeenCalledWith(7, {
      includeExcluded: true,
      enabled: true,
    });
  });

  it("labels edit controls as proposed and renders saved draft values", () => {
    localStorage.setItem(
      REVIEW_PARTS_UI_STORAGE_KEY,
      JSON.stringify({ layoutMode: "table", viewMode: "edit" }),
    );
    const acceptedReview: PlanReview = {
      ...review,
      totals: { ...review.totals, included_parts: 1, total_print_units: 2 },
      part_groups: [{
        folder: "frame",
        source_layer: "base:Voron",
        parts: [{
          id: 42,
          match_key: "frame/bracket.stl",
          relative_path: "frame/bracket.stl",
          filename: "bracket.stl",
          source_layer: "base:Voron",
          status: "ok",
          role: "structural",
          requirement: null,
          option_group_id: null,
          included: true,
          filament_color_id: null,
          quantity_auto: 2,
          quantity_override: null,
          quantity_effective: 2,
          printed_count: 0,
          print_units: [false, false],
          missing: false,
          filament_display: "",
        }],
      }],
    };
    queryMocks.usePlanWorkspace.mockReturnValue({
      draftWorkspace: {
        profile_id: 7,
        draft: {
          draft_id: 9,
          state: "open",
          lifecycle_version: 0,
          snapshot_digest: "a".repeat(64),
          base: { revision_id: 3, plan_version: 1 },
        },
        parts: [{
          draft_part_id: 17,
          base_revision_part_id: 42,
          part_key: "frame/bracket.stl",
          filename: "bracket.stl",
          relative_path: "frame/bracket.stl",
          source_layer: "base:Voron",
          role: "structural",
          quantity_inferred: 2,
          quantity_override: 4,
          quantity_effective: 4,
          included: true,
        }],
        diff: { base_is_current: true, added: [], removed: [], changed: [] },
        reconciliation: { kind: "ready", reused_units: 0, new_units: 0, surplus_units: 0 },
      },
      setQuantity: vi.fn(async () => {}),
      setIncluded: vi.fn(async () => {}),
      setSpoolmanSpool: vi.fn(async () => {}),
      toggleUnit: vi.fn(async () => {}),
      busyPartId: null,
    });

    render(
      <MemoryRouter>
        <ReviewPartsSheet review={acceptedReview} planName="Voron" />
      </MemoryRouter>,
    );

    expect(screen.queryByText(/Working Plan|not accepted yet/i)).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Qty" })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "Quantity for bracket.stl" }).getAttribute("value")).toBe("4");
    expect(screen.getByText(/Previously saved: qty 2, included/)).toBeTruthy();
  });

  it("removes a proposed part with one click", async () => {
    const setIncluded = vi.fn(async () => {});
    const acceptedReview: PlanReview = {
      ...review,
      totals: { ...review.totals, included_parts: 1, total_print_units: 1 },
      part_groups: [{
        folder: "frame",
        source_layer: "base:Voron",
        parts: [{
          id: 42,
          match_key: "frame/bracket.stl",
          relative_path: "frame/bracket.stl",
          filename: "bracket.stl",
          source_layer: "base:Voron",
          status: "ok",
          role: "structural",
          requirement: null,
          option_group_id: null,
          included: true,
          filament_color_id: null,
          quantity_auto: 1,
          quantity_override: null,
          quantity_effective: 1,
          printed_count: 0,
          print_units: [false],
          missing: true,
          filament_display: "",
        }],
      }],
    };
    queryMocks.usePlanWorkspace.mockReturnValue({
      draftWorkspace: {
        profile_id: 7,
        draft: {
          draft_id: 9,
          state: "open",
          lifecycle_version: 0,
          snapshot_digest: "a".repeat(64),
          base: { revision_id: 3, plan_version: 1 },
        },
        parts: [{
          draft_part_id: 17,
          base_revision_part_id: 42,
          part_key: "frame/bracket.stl",
          filename: "bracket.stl",
          relative_path: "frame/bracket.stl",
          source_layer: "base:Voron",
          role: "structural",
          quantity_inferred: 1,
          quantity_override: null,
          quantity_effective: 1,
          included: true,
        }],
        diff: { base_is_current: true, added: [], removed: [], changed: [] },
        reconciliation: { kind: "ready", reused_units: 0, new_units: 0, surplus_units: 0 },
      },
      setQuantity: vi.fn(async () => {}),
      setIncluded,
      setSpoolmanSpool: vi.fn(async () => {}),
      toggleUnit: vi.fn(async () => {}),
      busyPartId: null,
    });

    render(
      <MemoryRouter>
        <ReviewPartsSheet review={acceptedReview} planName="Voron" />
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(setIncluded).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42, match_key: "frame/bracket.stl" }),
      false,
    );
  });

describe("ReviewPartsSheet Spoolman access revocation masking", () => {
  it.each([false, true])("masks cached enrichment in sheet when access is denied (isMobileLayout: %s)", (isMobile) => {
    queryMocks.spoolmanAllowed = false;
    queryMocks.spoolmanConfigured = true;
    queryMocks.isMobileLayout = isMobile;
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

    queryMocks.spoolmanAllowed = true;
    const { rerender } = render(<MemoryRouter><ReviewPartsSheet review={enrichedReview} planName="Voron" /></MemoryRouter>);
    expect(screen.getAllByText("450g left").length).toBeGreaterThan(0);
    queryMocks.spoolmanAllowed = false;
    rerender(<MemoryRouter><ReviewPartsSheet review={enrichedReview} planName="Voron" /></MemoryRouter>);
    expect(screen.queryByText("450g left")).toBeNull();
    expect(screen.queryByText("Spoolman Blue")).toBeNull();
    expect(screen.getAllByText("Catalog Red").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Remove" }).length).toBe(isMobile ? 4 : 2);
  });
});

  it.each([false, true].flatMap((mobile) =>
    ["denied", "switched", "network"].map((state) => ({ mobile, state })),
  ))("handles spool rejection with mobile=$mobile and $state state", async ({ mobile, state }) => {
    localStorage.setItem(REVIEW_PARTS_UI_STORAGE_KEY, JSON.stringify({ layoutMode: "table", viewMode: "edit" }));
    queryMocks.isMobileLayout = mobile;
    queryMocks.spoolmanConfigured = true;
    queryMocks.spoolmanIntegrationId = "int-1";
    const part: ReviewPart = {
      id: 1, match_key: "a.stl", relative_path: "parts/a.stl", filename: "a.stl",
      source_layer: null, status: "ok", role: "primary", requirement: null, option_group_id: null,
      included: true, filament_color_id: "spoolman:int-1:filament:2", spoolman_spool_id: null,
      quantity_auto: 1, quantity_override: null, quantity_effective: 1, printed_count: 0,
      print_units: [false], missing: true, filament_display: "Spoolman Blue", filament_hex: "#0000ff",
    };
    const testReview = { ...review, part_groups: [{ folder: "parts", source_layer: null, parts: [part] }] };
    queryClient.setQueryData(queryKeys.planFeatures(7), { enabled: true });
    let fail: (error: Error) => void = () => {};
    const setSpoolmanSpool = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    queryMocks.usePlanWorkspace.mockReturnValue({
      draftWorkspace: null, setQuantity: vi.fn(), setIncluded: vi.fn(), setSpoolmanSpool,
      toggleUnit: vi.fn(), busyPartId: null,
    });
    const sheet = (profileId: number) => <MemoryRouter><ReviewPartsSheet review={{ ...testReview, profile_id: profileId }} planName="Voron" /></MemoryRouter>;
    const { rerender } = render(sheet(7));
    await userEvent.selectOptions(screen.getAllByRole("combobox", { name: "Spool for 1" })[0]!, "5");
    expect(setSpoolmanSpool).toHaveBeenCalledWith(1, "spoolman:int-1:spool:5");
    if (state === "switched") rerender(sheet(8));
    const message = state === "network" ? "Network timeout" : "Feature spoolman is disabled.";
    fail(new Error(message));
    await waitFor(() => expect(queryClient.getQueryState(queryKeys.planFeatures(7))?.isInvalidated).toBe(true));
    if (state === "switched") expect(toast.error).not.toHaveBeenCalled();
    else expect(toast.error).toHaveBeenCalledWith(message);
  });

});
