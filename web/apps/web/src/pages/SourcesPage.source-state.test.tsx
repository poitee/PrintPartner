// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { SourceSummary } from "@print-partner/contracts";
import { queryKeys } from "../queries/keys";
import SourcesPage from "./SourcesPage";

const { api, engineHealth, source } = vi.hoisted(() => ({
  api: {
    fetchSources: vi.fn(),
    fetchSourceCategories: vi.fn(),
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
}));

vi.mock("../api/endpoints/sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/endpoints/sources")>();
  return {
    ...actual,
    fetchSources: api.fetchSources,
    fetchSourceCategories: api.fetchSourceCategories,
  };
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
  usePlanWorkspace: () => ({ review: null }),
}));
vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => ({ profiles: [], selectedProfileId: null }),
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
vi.mock("../components/sources/SourceWatchPanel", () => ({ default: () => null }));

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
  });

  beforeEach(() => {
    api.fetchSources.mockResolvedValue([source("Cached Source")]);
    api.fetchSourceCategories.mockResolvedValue([]);
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
