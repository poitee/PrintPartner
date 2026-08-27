// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
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
  default: ({ source, open }: { source: SourceSummary | null; open: boolean }) =>
    open && source ? <output data-testid="detail-source">{source.name}</output> : null,
}));

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

    expect(screen.getByRole("heading", { level: 1, name: "Library" })).toBeTruthy();
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

    expect(screen.getByRole("heading", { level: 1, name: "Library" })).toBeTruthy();
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
