// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { TENANT_FEATURE_TOGGLES_CAPABILITY, type JobEvent, type JobSnapshot, type SourceSummary } from "@print-partner/contracts";
import { fetchJob } from "../api/endpoints/jobs";
import { startImportScan } from "../api/endpoints/sources";
import { connectJobWebSocket } from "../api/jobWebSocket";
import { JobProvider } from "../context/JobContext";
import { queryKeys } from "../queries/keys";
import SourcesPage from "./SourcesPage";

const healthState = vi.hoisted(() => ({ capabilities: [] as string[] }));

vi.mock("../queries/health", () => ({
  useHealthQuery: () => ({
    data: { ok: true, capabilities: healthState.capabilities },
    error: null,
    isLoading: false,
    isFetching: false,
    status: "success",
  }),
}));
vi.mock("../api/endpoints/jobs", () => ({
  fetchJob: vi.fn(),
  startSync: vi.fn(),
  waitForJobDone: vi.fn(),
}));
vi.mock("../api/endpoints/sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/endpoints/sources")>();
  return {
    ...actual,
    fetchSources: vi.fn(async () => [source(17, "Selected"), source(18, "Other")]),
    fetchSourceCategories: vi.fn(async () => []),
    startImportScan: vi.fn(async () => "import-parent"),
  };
});
vi.mock("../api/jobWebSocket", () => ({
  connectJobWebSocket: vi.fn(() => vi.fn()),
  JobNotFoundError: class JobNotFoundError extends Error {},
}));
vi.mock("../hooks/useImportSharedBuild", () => ({
  useImportSharedBuild: () => vi.fn(),
}));
vi.mock("../context/DateFormatContext", () => ({
  useDateFormat: () => ({ formatDate: (value: string) => value }),
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
    runImportScan,
  }: {
    source: SourceSummary | null;
    open: boolean;
    runImportScan: (sourceId: number) => void;
  }) => open && source ? (
    <button type="button" onClick={() => runImportScan(source.id)}>
      Start import scan
    </button>
  ) : null,
}));
vi.mock("../components/sources/SourceWatchPanel", () => ({ default: () => null }));

function source(id: number, name: string): SourceSummary {
  return {
    id, name, url: `https://github.com/example/source-${id}`, source_kind: "github",
    source_type: "git", role: "", category: null, branch: "main", tag: null,
    local_path: null, last_synced_at: null, last_commit_sha: null,
    current_source_revision_id: null, docs_url: null, manifest_community_slug: null, metadata: null,
  };
}

function doneScan(): JobSnapshot {
  return {
    job_id: "import-parent",
    kind: "import-scan",
    status: "done",
    message: "Complete",
    progress: 100,
    result: { stl_count: 1, downloaded: 1, doc_count: 0, docs_downloaded: 0 },
    error: null,
  };
}

function sendJobEvent(event: JobEvent | JobSnapshot): void {
  const connection = vi.mocked(connectJobWebSocket).mock.calls.find(([jobId]) => jobId === "import-parent");
  expect(connection).toBeDefined();
  connection?.[1](event);
}

function renderLibrary(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(queryKeys.sources, [source(17, "Selected"), source(18, "Other")]);
  queryClient.setQueryData(queryKeys.sourceCategories, []);
  queryClient.setQueryData(["sourceContent", 17, "docs"], ["selected"]);
  queryClient.setQueryData(["sourceContent", 18, "docs"], ["other"]);
  queryClient.setQueryData(queryKeys.planReview(4, false), { profile_id: 4 });
  render(
    <QueryClientProvider client={queryClient}>
      <JobProvider>
        <MemoryRouter initialEntries={["/library?source=17"]}>
          <SourcesPage />
        </MemoryRouter>
      </JobProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("SourcesPage import scan", () => {
  beforeEach(() => {
    healthState.capabilities = [];
    vi.mocked(fetchJob).mockImplementation((_jobId, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    }));
    vi.mocked(connectJobWebSocket).mockReset().mockReturnValue(vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("refreshes the selected source after import scan completion", async () => {
    healthState.capabilities = [TENANT_FEATURE_TOGGLES_CAPABILITY];
    const queryClient = renderLibrary();

    fireEvent.click(await screen.findByRole("button", { name: "Start import scan" }));
    await waitFor(() => expect(startImportScan).toHaveBeenCalledExactlyOnceWith(17));
    await waitFor(() => expect(connectJobWebSocket).toHaveBeenCalledWith(
      "import-parent",
      expect.any(Function),
      expect.any(Function),
    ));

    act(() => { sendJobEvent(doneScan()); });

    expect(queryClient.getQueryState(["sourceContent", 17, "docs"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["sourceContent", 18, "docs"])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(queryKeys.planReview(4, false))?.isInvalidated).toBe(false);
  });

  it("keeps the shared plan refresh when rebuild reads are off", async () => {
    const queryClient = renderLibrary();

    fireEvent.click(await screen.findByRole("button", { name: "Start import scan" }));
    await waitFor(() => expect(connectJobWebSocket).toHaveBeenCalled());

    act(() => { sendJobEvent(doneScan()); });

    expect(queryClient.getQueryState(queryKeys.planReview(4, false))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["sourceContent", 17, "docs"])?.isInvalidated).toBe(false);
  });
});
