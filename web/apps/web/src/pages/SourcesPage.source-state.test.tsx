// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ProfileSummary, SourceSummary } from "@print-partner/contracts";
import type { PlanReview, ReviewPart } from "../api/endpoints/planManifests";
import type { ProfileLayer } from "../api/endpoints/plans";
import { queryKeys } from "../queries/keys";
import { SOURCES_UI_STORAGE_KEY } from "../lib/persistedSourcesUi";
import SourcesPage from "./SourcesPage";

const { api, engineHealth, source, workspace, profileSelection } = vi.hoisted(() => {
  const workspace: { review: PlanReview | null } = { review: null };
  const profileSelection: { profiles: ProfileSummary[]; selectedProfileId: number | null } = {
    profiles: [], selectedProfileId: null,
  };
  return {
    workspace,
    profileSelection,
    api: {
      fetchSources: vi.fn(),
      fetchSourceCategories: vi.fn(),
      fetchPlanLayers: vi.fn(),
    },
    engineHealth: { health: { ok: true } as { ok: boolean } | null, error: null as string | null, loading: false },
    source: (name: string): SourceSummary => ({
      id: 7,
      name,
      url: "https://github.com/example/source",
      source_kind: "github",
      source_type: "git",
      role: "",
      category: null,
      branch: "main",
      tag: null,
      local_path: null,
      last_synced_at: null,
      last_commit_sha: null,
      current_source_revision_id: null,
      docs_url: null,
      manifest_community_slug: null,
      metadata: null,
    }),
  };
});

vi.mock("../api/endpoints/sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/endpoints/sources")>();
  return {
    ...actual,
    fetchSources: api.fetchSources,
    fetchSourceCategories: api.fetchSourceCategories,
  };
});
vi.mock("../api/endpoints/planManifests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/endpoints/planManifests")>();
  return { ...actual, fetchPlanLayers: api.fetchPlanLayers };
});
vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => engineHealth,
}));
vi.mock("../hooks/useJobRunner", () => ({
  useJobRunner: () => ({ busy: false, runJob: vi.fn() }),
}));
vi.mock("../hooks/useImportSharedBuild", () => ({
  useImportSharedBuild: () => vi.fn(),
}));
vi.mock("../context/DateFormatContext", () => ({
  useDateFormat: () => ({ formatDate: (value: string) => value }),
}));
vi.mock("../context/JobContext", () => ({
  useJobContext: () => ({ activeJobs: [] }),
}));
vi.mock("../context/PlanWorkspaceContext", () => ({
  usePlanWorkspace: () => workspace,
}));
vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => profileSelection,
}));
vi.mock("../components/sources/SourceDetailSheet", () => ({
  default: ({
    source,
    open,
    tab,
    highlightPath,
    onOpenChange,
    onTabChange,
    onHighlightPathChange,
  }: {
    source: SourceSummary | null;
    open: boolean;
    tab?: string;
    highlightPath?: string | null;
    onOpenChange: (open: boolean) => void;
    onTabChange?: (tab: "docs" | "rules" | "naming") => void;
    onHighlightPathChange?: (path: string | null) => void;
  }) =>
    open && source ? (
      <div>
        <output data-testid="detail-source">{source.name}</output>
        <output data-testid="detail-route-state">
          {tab ?? "docs"}|{highlightPath ?? ""}
        </output>
        <button type="button" onClick={() => onHighlightPathChange?.("parts/new.stl")}>
          Select another file
        </button>
        <button type="button" onClick={() => onTabChange?.("naming")}>
          Show naming
        </button>
        <button type="button" onClick={() => onOpenChange(false)}>
          Close details
        </button>
      </div>
    ) : null,
}));
vi.mock("../components/sources/SourceWatchPanel", () => ({
  default: ({ attachedUpdateCount }: { attachedUpdateCount: number }) => (
    <output data-testid="attached-update-count">{attachedUpdateCount}</output>
  ),
}));

function LocationSearchProbe() {
  return <output data-testid="location-search">{useLocation().search}</output>;
}

function ReplaceCachedSource() {
  const queryClient = useQueryClient();
  return (
    <button
      type="button"
      onClick={() => queryClient.setQueryData(queryKeys.sources, [source("Updated Source")])}
    >
      Replace cached Source
    </button>
  );
}

describe("SourcesPage Source state ownership", () => {
  afterEach(() => {
    cleanup();
    engineHealth.health = { ok: true };
    engineHealth.error = null;
    engineHealth.loading = false;
    api.fetchSources.mockReset();
    api.fetchSources.mockResolvedValue([source("Cached Source")]);
    api.fetchSourceCategories.mockReset();
    api.fetchSourceCategories.mockResolvedValue([]);
    api.fetchPlanLayers.mockReset();
    workspace.review = null;
    profileSelection.profiles = [];
    profileSelection.selectedProfileId = null;
    localStorage.clear();
  });

  beforeEach(() => {
    api.fetchSources.mockResolvedValue([source("Cached Source")]);
    api.fetchSourceCategories.mockResolvedValue([]);
  });

  it.each(["grid", "list"])("uses current Build attachments in %s while retaining saved picks", async (viewMode) => {
    const sources = [
      { ...source("Saved Source"), id: 5 },
      { ...source("Updated Source"), id: 6, update_status: "updates_available" },
    ];
    const layers: ProfileLayer[] = [
      { id: 1, layer_order: 0, layer_type: "base", project_id: 5, project_name: "Saved Source" },
      { id: 2, layer_order: 1, layer_type: "addon", project_id: 6, project_name: "Updated Source" },
    ];
    const savedPart: ReviewPart = {
      id: 42, match_key: "widget.stl", relative_path: "parts/widget.stl", filename: "widget.stl",
      source_layer: "base:Saved Source", status: "ok", role: "primary", requirement: null, option_group_id: null,
      included: true, filament_color_id: null, quantity_auto: 2, quantity_override: null, quantity_effective: 2,
      printed_count: 0, print_units: [false, false], missing: true, filament_display: "Unset",
    };
    const review: PlanReview = {
      profile_id: 16, accepted_basis: null, plan_name: "Audit Build",
      layers: [{ id: 1, layer_type: "base", project_id: 5, project_name: "Saved Source", local_path: null, synced: true, last_synced_at: null }],
      totals: { included_parts: 1, total_print_units: 2, by_role: {}, by_filament: {} },
      issues: [], has_blockers: false,
      part_groups: [{ folder: "parts", source_layer: "base:Saved Source", parts: [savedPart] }],
    };
    const profile: ProfileSummary = {
      id: 16, name: "Audit Build", order_number: null, special_request: null, part_count: 1,
      accepted_progress: { kind: "ready", total_units: 2, remaining_units: 2 }, build_stale: true,
      freshness: { status: "stale", accepted_input_set_id: 1, accepted_at: "2026-09-30T12:00:00Z", reasons: [{ kind: "plan_configuration_changed" }], untracked_sources: [] },
      archived_at: null, last_used_at: null,
    };
    workspace.review = review;
    profileSelection.profiles = [profile];
    profileSelection.selectedProfileId = profile.id;
    api.fetchPlanLayers.mockResolvedValue(layers);
    localStorage.setItem(SOURCES_UI_STORAGE_KEY, JSON.stringify({ viewMode }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(queryKeys.sources, sources);
    queryClient.setQueryData(queryKeys.sourceCategories, []);
    queryClient.setQueryData(queryKeys.planReview(16, false), review);
    const savedReview = structuredClone(review);

    render(<QueryClientProvider client={queryClient}><MemoryRouter><SourcesPage /></MemoryRouter></QueryClientProvider>);

    expect(await screen.findByText(/2 attached to Audit Build/)).toBeTruthy();
    expect(api.fetchPlanLayers).toHaveBeenCalledWith(16);
    expect(screen.getByText("1 pick")).toBeTruthy();
    expect(screen.getByText("0 picks")).toBeTruthy();
    expect(screen.getByText("1 of them is in your plan.")).toBeTruthy();
    expect(screen.getByTestId("attached-update-count").textContent).toBe("1");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Updated Source" }));
    await act(async () => { queryClient.setQueryData(queryKeys.planLayers(16), layers.slice(0, 1)); });

    expect(await screen.findByText(/1 attached to Audit Build/)).toBeTruthy();
    expect(screen.getByText("not attached")).toBeTruthy();
    expect(screen.getByText("1 pick")).toBeTruthy();
    expect(screen.getByTestId("attached-update-count").textContent).toBe("0");
    expect(screen.queryByText("1 of them is in your plan.")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Select Updated Source" }).getAttribute("aria-checked")).toBe("true");
    expect(workspace.review).toEqual(savedReview);
    expect(queryClient.getQueryData(queryKeys.planReview(16, false))).toEqual(savedReview);
    expect(profileSelection.selectedProfileId).toBe(16);
  });

  it("shows current attachments for a Build with no saved Plan", async () => {
    const profile: ProfileSummary = {
      id: 17, name: "Unsaved Build", order_number: null, special_request: null, part_count: 0,
      accepted_progress: { kind: "empty" }, build_stale: true,
      freshness: { status: "untracked", accepted_input_set_id: null, accepted_at: null, reasons: [{ kind: "no_accepted_inputs" }] },
      archived_at: null, last_used_at: null,
    };
    profileSelection.profiles = [profile];
    profileSelection.selectedProfileId = profile.id;
    api.fetchPlanLayers.mockResolvedValue([{ id: 3, layer_order: 0, layer_type: "base", project_id: 7, project_name: "Cached Source" }]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.fetchSources.mockResolvedValue([source("Cached Source")]);

    render(<QueryClientProvider client={queryClient}><MemoryRouter><SourcesPage /></MemoryRouter></QueryClientProvider>);

    expect(await screen.findByText(/1 attached to Unsaved Build/)).toBeTruthy();
    expect(screen.getByText("0 picks")).toBeTruthy();
    expect(workspace.review).toBeNull();
    expect(profileSelection.selectedProfileId).toBe(17);
  });

  it("waits for current attachments before showing Library badges and alerts", async () => {
    profileSelection.selectedProfileId = 17;
    let resolveLayers: ((layers: ProfileLayer[]) => void) | undefined;
    api.fetchPlanLayers.mockImplementation(() => new Promise<ProfileLayer[]>((resolve) => {
      resolveLayers = resolve;
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.sources, [{ ...source("Cached Source"), update_status: "updates_available" }]);

    render(<QueryClientProvider client={queryClient}><MemoryRouter><SourcesPage /></MemoryRouter></QueryClientProvider>);

    expect(await screen.findByRole("status", { name: "Loading Source Library" })).toBeTruthy();
    expect(screen.queryByText("not attached")).toBeNull();
    expect(screen.queryByTestId("attached-update-count")).toBeNull();
    expect(screen.queryByText("Your plan may still use older files.")).toBeNull();
    await act(async () => resolveLayers?.([{ id: 3, layer_order: 0, layer_type: "base", project_id: 7, project_name: "Cached Source" }]));
    expect(await screen.findByText("0 picks")).toBeTruthy();
    expect(screen.getByTestId("attached-update-count").textContent).toBe("1");
  });

  it("shows an attachment read failure and retries without declaring Sources unattached", async () => {
    profileSelection.selectedProfileId = 17;
    api.fetchPlanLayers.mockRejectedValueOnce(new Error("Layer read failed"));
    api.fetchPlanLayers.mockResolvedValue([{ id: 3, layer_order: 0, layer_type: "base", project_id: 7, project_name: "Cached Source" }]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.sources, [source("Cached Source")]);

    render(<QueryClientProvider client={queryClient}><MemoryRouter><SourcesPage /></MemoryRouter></QueryClientProvider>);

    expect((await screen.findByRole("alert")).textContent).toContain("Layer read failed");
    expect(screen.queryByText("not attached")).toBeNull();
    expect(screen.queryByTestId("attached-update-count")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("0 picks")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retains cached attachments when a background read fails", async () => {
    profileSelection.selectedProfileId = 17;
    api.fetchPlanLayers.mockRejectedValue(new Error("Background layer read failed"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.sources, [source("Cached Source")]);
    queryClient.setQueryData(queryKeys.planLayers(17), [{ id: 3, layer_order: 0, layer_type: "base", project_id: 7, project_name: "Cached Source" }]);

    render(<QueryClientProvider client={queryClient}><MemoryRouter><SourcesPage /></MemoryRouter></QueryClientProvider>);

    expect((await screen.findByRole("alert")).textContent).toContain("Background layer read failed");
    expect(screen.getByText("0 picks")).toBeTruthy();
    expect(screen.queryByText("not attached")).toBeNull();
    expect(screen.queryByRole("status", { name: "Loading Source Library" })).toBeNull();
  });

  it("keeps the card and open detail sheet subscribed to the shared Source cache", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(queryKeys.sources, [source("Cached Source")]);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SourcesPage />
          <ReplaceCachedSource />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open Cached Source" }));
    expect(screen.getByTestId("detail-source").textContent).toBe("Cached Source");

    fireEvent.click(screen.getByRole("button", { name: "Replace cached Source" }));

    expect(await screen.findByRole("button", { name: "Open Updated Source" })).toBeTruthy();
    expect(screen.getByTestId("detail-source").textContent).toBe("Updated Source");
  });

  it("restores and updates Source detail context through the URL", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(queryKeys.sources, [source("Linked Source")]);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter
          initialEntries={["/library?source=7&tab=rules&file=parts%2Fwidget.stl"]}
        >
          <SourcesPage />
          <LocationSearchProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect((await screen.findByTestId("detail-source")).textContent).toBe("Linked Source");
    expect(screen.getByTestId("detail-route-state").textContent).toBe(
      "rules|parts/widget.stl",
    );

    fireEvent.click(screen.getByRole("button", { name: "Select another file" }));
    await screen.findByText("?source=7&tab=rules&file=parts%2Fnew.stl");

    fireEvent.click(screen.getByRole("button", { name: "Show naming" }));
    await screen.findByText("?source=7&tab=naming");

    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    await screen.findByTestId("location-search");
    expect(screen.getByTestId("location-search").textContent).toBe("");
  });

  it("names each row action menu for its Source", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(queryKeys.sources, [source("Cached Source")]);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SourcesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("button", { name: "Source actions for Cached Source" }),
    ).toBeTruthy();
  });

  it("labels the add-source comboboxes and repository import field", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(queryKeys.sources, [source("Cached Source")]);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SourcesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click((await screen.findAllByRole("button", { name: "GitHub repo" }))[0]);
    expect(screen.getByRole("combobox", { name: "Platform" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Category" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Import repos.txt…" }));
    expect(screen.getByRole("textbox", { name: "Repository list" })).toBeTruthy();
  });

  it("keeps the Library heading and announces an offline engine as an alert", () => {
    engineHealth.health = null;
    engineHealth.error = "offline";

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SourcesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Source Library" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Engine offline");
  });

  it("keeps the Library heading and announces engine loading as status", () => {
    engineHealth.health = null;
    engineHealth.loading = true;

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SourcesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Source Library" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Connecting to the engine");
  });

  it("announces Source Library data loading after the engine connects", () => {
    api.fetchSources.mockReturnValue(new Promise(() => undefined));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SourcesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByRole("status", { name: "Loading Source Library" })).toBeTruthy();
  });

  it("announces Source Library query failures", async () => {
    api.fetchSources.mockRejectedValue(new Error("catalog unavailable"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SourcesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect((await screen.findByRole("alert")).textContent).toContain("catalog unavailable");
  });
});
