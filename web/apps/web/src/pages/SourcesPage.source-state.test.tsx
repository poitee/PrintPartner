// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { SourceSummary } from "../api/engine";
import { queryKeys } from "../queries/keys";
import SourcesPage from "./SourcesPage";

const { source } = vi.hoisted(() => ({
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

vi.mock("../api/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/engine")>();
  return {
    ...actual,
    fetchSources: vi.fn().mockResolvedValue([source("Cached Source")]),
    fetchSourceCategories: vi.fn().mockResolvedValue([]),
  };
});
vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true }, error: null, loading: false }),
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
  afterEach(cleanup);

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
});
