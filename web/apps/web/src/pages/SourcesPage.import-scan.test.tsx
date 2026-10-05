// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { JobEvent, JobSnapshot, SourceSummary } from "@print-partner/contracts";
import { fetchJob } from "../api/endpoints/jobs";
import { startImportScan } from "../api/endpoints/sources";
import { connectJobWebSocket } from "../api/jobWebSocket";
import { JobProvider, useJobContext } from "../context/JobContext";
import { queryKeys } from "../queries/keys";
import SourcesPage from "./SourcesPage";

const { api, content } = vi.hoisted(() => ({
  api: {
    fetchSourceCategories: vi.fn(),
    fetchSources: vi.fn(),
    startImportScan: vi.fn(),
  },
  content: {
    fetchDocs: vi.fn(),
    fetchSelectedPdf: vi.fn(),
  },
}));

vi.mock("../api/endpoints/jobs", () => ({
  fetchJob: vi.fn(),
  startSync: vi.fn(),
  waitForJobDone: vi.fn(),
}));
vi.mock("../api/endpoints/sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/endpoints/sources")>();
  return { ...actual, ...api };
});
vi.mock("../api/jobWebSocket", () => ({
  connectJobWebSocket: vi.fn(() => vi.fn()),
}));
vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true }, error: null, loading: false }),
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
    <div>
      <output data-testid="detail-source">{source.name}</output>
      <button type="button" onClick={() => runImportScan(source.id)}>
        Start import scan
      </button>
    </div>
  ) : null,
}));
vi.mock("../components/sources/SourceWatchPanel", () => ({ default: () => null }));

function source(id: number, name: string): SourceSummary {
  return {
    id,
    name,
    url: `https://github.com/example/source-${id}`,
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
  };
}

function snapshot(
  jobId: string,
  kind: string,
  overrides: Partial<JobSnapshot> = {},
): JobSnapshot {
  return {
    job_id: jobId,
    kind,
    status: "done",
    message: "Complete",
    progress: 100,
    result: {},
    error: null,
    ...overrides,
  };
}

function stalledJob(signal?: AbortSignal): Promise<JobSnapshot> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
  });
}

function sendJobEvent(jobId: string, event: JobEvent | JobSnapshot): void {
  const connection = vi.mocked(connectJobWebSocket).mock.calls.find(([connectedId]) =>
    connectedId === jobId);
  expect(connection).toBeDefined();
  connection?.[1](event);
}

function ImportScanProbe() {
  const { isJobKindRunning } = useJobContext();
  const docs = useQuery({
    queryKey: ["sourceContent", 17, "docs"],
    queryFn: content.fetchDocs,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const selectedPdf = useQuery({
    queryKey: ["sourceContent", 17, "document", "manual.pdf"],
    queryFn: content.fetchSelectedPdf,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return (
    <div>
      <output data-testid="selected-busy">
        {String(isJobKindRunning("extract-source-docs", 17))}
      </output>
      <output data-testid="unrelated-busy">
        {String(isJobKindRunning("extract-source-docs", 18))}
      </output>
      <output data-testid="source-docs">{String(docs.data)}</output>
      <output data-testid="selected-pdf">{String(selectedPdf.data)}</output>
    </div>
  );
}

describe("SourcesPage import scan", () => {
  beforeEach(() => {
    api.fetchSources.mockResolvedValue([source(17, "Selected Source"), source(18, "Other Source")]);
    api.fetchSourceCategories.mockResolvedValue([]);
    api.startImportScan.mockResolvedValue("import-parent");
    content.fetchDocs.mockResolvedValue("refreshed docs");
    content.fetchSelectedPdf.mockResolvedValue("refreshed PDF text");
    vi.mocked(fetchJob).mockImplementation((_jobId, signal) => stalledJob(signal));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("scopes extraction progress to the selected Source and refreshes its mounted content", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(queryKeys.sources, [
      source(17, "Selected Source"),
      source(18, "Other Source"),
    ]);
    queryClient.setQueryData(queryKeys.sourceCategories, []);
    queryClient.setQueryData(["sourceContent", 17, "docs"], "cached docs");
    queryClient.setQueryData(
      ["sourceContent", 17, "document", "manual.pdf"],
      "cached PDF text",
    );

    render(
      <QueryClientProvider client={queryClient}>
        <JobProvider>
          <MemoryRouter initialEntries={["/library?source=17&tab=rules"]}>
            <SourcesPage />
            <ImportScanProbe />
          </MemoryRouter>
        </JobProvider>
      </QueryClientProvider>,
    );

    expect((await screen.findByTestId("detail-source")).textContent).toBe("Selected Source");
    expect(screen.getByTestId("source-docs").textContent).toBe("cached docs");
    expect(screen.getByTestId("selected-pdf").textContent).toBe("cached PDF text");

    fireEvent.click(screen.getByRole("button", { name: "Start import scan" }));

    await waitFor(() => expect(startImportScan).toHaveBeenCalledExactlyOnceWith(17));
    await waitFor(() => expect(connectJobWebSocket).toHaveBeenCalledWith(
      "import-parent",
      expect.any(Function),
      expect.any(Function),
    ));

    await act(async () => {
      sendJobEvent("import-parent", snapshot("import-parent", "import-scan", {
        result: { pdf_extract_job_id: "extract-child" },
      }));
    });

    await waitFor(() => expect(connectJobWebSocket).toHaveBeenCalledWith(
      "extract-child",
      expect.any(Function),
      expect.any(Function),
    ));
    expect(screen.getByTestId("selected-busy").textContent).toBe("true");
    expect.soft(screen.getByTestId("unrelated-busy").textContent).toBe("false");

    await act(async () => {
      sendJobEvent("extract-child", {
        status: "running",
        message: "Extracting PDF text",
        progress: 10,
        result: null,
        error: null,
      });
    });
    expect(screen.getByTestId("selected-busy").textContent).toBe("true");
    expect.soft(screen.getByTestId("unrelated-busy").textContent).toBe("false");

    await act(async () => {
      sendJobEvent("extract-child", snapshot("extract-child", "extract-source-docs", {
        result: { project_id: 17, extracted: 1 },
      }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("source-docs").textContent).toBe("refreshed docs");
      expect(screen.getByTestId("selected-pdf").textContent).toBe("refreshed PDF text");
    });
    expect(content.fetchDocs).toHaveBeenCalledOnce();
    expect(content.fetchSelectedPdf).toHaveBeenCalledOnce();
    expect(startImportScan).toHaveBeenCalledOnce();
  });
});
