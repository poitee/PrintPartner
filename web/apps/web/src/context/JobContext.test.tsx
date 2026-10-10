// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { JobEvent, JobSnapshot } from "@print-partner/contracts";
import { fetchJob } from "../api/endpoints/jobs";
import { connectJobWebSocket } from "../api/jobWebSocket";
import { queryKeys } from "../queries/keys";
import { JobProvider, useJobContext } from "./JobContext";

vi.mock("../api/endpoints/jobs", () => ({
  fetchJob: vi.fn(),
}));

vi.mock("../api/jobWebSocket", () => ({
  connectJobWebSocket: vi.fn(() => vi.fn()),
}));

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

function providerWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <JobProvider>{children}</JobProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("JobProvider terminal retention", () => {
  it.each(["completion", "unmount"])("aborts a stalled poll on %s", async (reason) => {
    let pollSignal: AbortSignal | undefined;
    vi.mocked(fetchJob).mockImplementationOnce((_id, signal) => new Promise((_resolve, reject) => {
      pollSignal = signal;
      signal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    }));
    const completed = {
      job_id: "download", kind: "export-stl-pack", status: "done",
      message: "Complete", progress: 100, result: {}, error: null,
    };
    vi.mocked(fetchJob).mockResolvedValue(completed);
    const disconnect = vi.fn();
    vi.mocked(connectJobWebSocket).mockReturnValue(disconnect);
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <JobProvider>{children}</JobProvider>
      </QueryClientProvider>
    );
    const { result, unmount } = renderHook(useJobContext, { wrapper });
    const onDone = vi.fn();
    await act(async () => {
      await result.current.runJob("stl-export", () => Promise.resolve("download"), onDone);
    });
    await act(async () => {
      if (reason === "unmount") unmount();
      else vi.mocked(connectJobWebSocket).mock.calls.at(-1)?.[1](completed);
    });
    expect(pollSignal?.aborted).toBe(true);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledTimes(reason === "completion" ? 1 : 0);
  });

  it("keeps watching an STL export beyond a minute and delivers its download", async () => {
    vi.useFakeTimers();
    const running = {
      job_id: "download", kind: "export-stl-pack", status: "running",
      message: "Creating ZIP", progress: null, result: null, error: null,
    };
    vi.mocked(fetchJob).mockResolvedValue(running);
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <JobProvider>{children}</JobProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(useJobContext, { wrapper });
    const onDone = vi.fn();
    await act(async () => {
      await result.current.runJob("stl-export", () => Promise.resolve("download"), onDone);
      await vi.advanceTimersByTimeAsync(65_000);
    });
    expect(result.current.activeJobs).toEqual([
      expect.objectContaining({ status: "running" }),
    ]);
    const completed = { ...running, status: "done", result: { download_url: "/exports/files.zip" } };
    vi.mocked(fetchJob).mockResolvedValue(completed);
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(onDone).toHaveBeenCalledExactlyOnceWith(completed);
    const calls = vi.mocked(fetchJob).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(fetchJob).toHaveBeenCalledTimes(calls);
  });

  it("settles the download panel when job observation fails", async () => {
    vi.mocked(fetchJob).mockRejectedValue(new Error("Connection lost"));
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <JobProvider>{children}</JobProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(useJobContext, { wrapper });
    const onDone = vi.fn();
    await act(async () => {
      await result.current.runJob("stl-export", () => Promise.resolve("download"), onDone);
    });
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({
      status: "error", error: expect.stringContaining("Connection lost"),
    }));
  });

  it("removes a job start failure after the bounded terminal display window", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <JobProvider>{children}</JobProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(useJobContext, { wrapper });

    await act(async () => {
      await result.current.runJob(
        "export-accepted-plate-3mf",
        () => Promise.reject(new Error("Could not start")),
        undefined,
        { profileId: 7 },
      );
    });
    expect(result.current.activeJobs).toEqual([
      expect.objectContaining({ status: "error", message: "Could not start", profileId: 7 }),
    ]);
    act(() => vi.advanceTimersByTime(2_500));
    expect(result.current.activeJobs).toEqual([]);
  });

  it("refreshes cached accepted history after start and after observer failure", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.acceptedPlateExportJobs(7), []);
    let rejectPoll: ((error: Error) => void) | undefined;
    vi.mocked(fetchJob).mockImplementation(() => new Promise((_resolve, reject) => {
      rejectPoll = reject;
    }));
    vi.mocked(connectJobWebSocket).mockReturnValue(vi.fn());
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <JobProvider>{children}</JobProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(useJobContext, { wrapper });

    await act(async () => {
      await result.current.runJob(
        "export-accepted-plate-3mf",
        () => Promise.resolve("job-one"),
        undefined,
        { profileId: 7 },
      );
    });
    expect(queryClient.getQueryState(queryKeys.acceptedPlateExportJobs(7))?.isInvalidated).toBe(true);

    queryClient.setQueryData(queryKeys.acceptedPlateExportJobs(7), []);
    await act(async () => {
      rejectPoll?.(new Error("Observer failed"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(queryClient.getQueryState(queryKeys.acceptedPlateExportJobs(7))?.isInvalidated).toBe(true);
  });
});

it("reports a job-start rejection once with the same local failure identity", async () => {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}><JobProvider>{children}</JobProvider></QueryClientProvider>;
  const { result } = renderHook(useJobContext, { wrapper });
  const onDone = vi.fn();
  const websocketCalls = vi.mocked(connectJobWebSocket).mock.calls.length;
  await act(async () => { await result.current.runJob("printer-upload", () => Promise.reject(new Error("Printer request offline")), onDone, { profileId: 7, sourceIds: [3] }); });
  const job = result.current.activeJobs[0];
  expect(job).toMatchObject({ status: "error", message: "Printer request offline", profileId: 7, sourceIds: [3] });
  expect(onDone).toHaveBeenCalledExactlyOnceWith({ job_id: job?.jobId, kind: "printer-upload", status: "error", message: "Printer request offline", error: "Printer request offline", progress: null, result: null });
  expect(connectJobWebSocket).toHaveBeenCalledTimes(websocketCalls);
});

it("observes a sync extraction child and refreshes mounted Source content", async () => {
  const queryClient = new QueryClient();
  const docsKey = ["sourceContent", 17, "docs"] as const;
  const documentKey = ["sourceContent", 17, "document", "manual.pdf"] as const;
  queryClient.setQueryData(docsKey, ["cached-manual"]);
  queryClient.setQueryData(documentKey, "cached text");
  const fetchDocs = vi.fn().mockResolvedValue(["refreshed-manual"]);
  const fetchDocument = vi.fn().mockResolvedValue("refreshed text");
  const docsObserver = new QueryObserver(queryClient, {
    queryKey: docsKey,
    queryFn: fetchDocs,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const documentObserver = new QueryObserver(queryClient, {
    queryKey: documentKey,
    queryFn: fetchDocument,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const unsubscribeDocs = docsObserver.subscribe(() => {});
  const unsubscribeDocument = documentObserver.subscribe(() => {});
  vi.mocked(fetchJob).mockImplementation((_jobId, signal) => stalledJob(signal));
  const { result } = renderHook(useJobContext, { wrapper: providerWrapper(queryClient) });
  await act(async () => {
    await result.current.runJob("sync", () => Promise.resolve("sync-parent"));
  });
  const parentDone = snapshot("sync-parent", "sync", {
    result: {
      synced: 1,
      failed: 0,
      results: [{ project_id: 17, pdf_extract_job_id: "extract-child" }],
      failures: [],
    },
  });
  await act(async () => {
    sendJobEvent("sync-parent", parentDone);
  });

  expect(connectJobWebSocket).toHaveBeenCalledWith(
    "extract-child",
    expect.any(Function),
    expect.any(Function),
  );

  const childDone = snapshot("extract-child", "extract-source-docs", {
    result: { project_id: 17, extracted: 1 },
  });
  await act(async () => {
    sendJobEvent("extract-child", childDone);
  });

  await waitFor(() => {
    expect(docsObserver.getCurrentResult().data).toEqual(["refreshed-manual"]);
    expect(documentObserver.getCurrentResult().data).toBe("refreshed text");
  });
  expect(fetchDocs).toHaveBeenCalledOnce();
  expect(fetchDocument).toHaveBeenCalledOnce();

  unsubscribeDocs();
  unsubscribeDocument();
  queryClient.clear();
});

it("scopes sync extraction progress and observes each child once", async () => {
  const queryClient = new QueryClient();
  vi.mocked(fetchJob).mockImplementation((_jobId, signal) => stalledJob(signal));
  const { result } = renderHook(useJobContext, { wrapper: providerWrapper(queryClient) });
  await act(async () => {
    await result.current.runJob("sync", () => Promise.resolve("sync-many"));
    sendJobEvent("sync-many", snapshot("sync-many", "sync", {
      result: {
        results: [
          { project_id: 17, pdf_extract_job_id: "extract-17" },
          { project_id: 17, pdf_extract_job_id: "extract-17" },
          { project_id: 18, pdf_extract_job_id: "extract-18" },
        ],
      },
    }));
  });

  expect(vi.mocked(connectJobWebSocket).mock.calls.filter(([jobId]) =>
    jobId === "extract-17")).toHaveLength(1);
  expect(vi.mocked(connectJobWebSocket).mock.calls.filter(([jobId]) =>
    jobId === "extract-18")).toHaveLength(1);

  await act(async () => {
    sendJobEvent("extract-17", {
      status: "running",
      message: "Extracting PDF text",
      progress: 10,
      result: null,
      error: null,
    });
  });
  expect(result.current.activeJobs).toContainEqual(expect.objectContaining({
    jobId: "extract-17",
    kind: "extract-source-docs",
    status: "running",
    progress: 10,
    sourceIds: [17],
  }));
  expect(result.current.isJobKindRunning("extract-source-docs", 17)).toBe(true);
  expect(result.current.isJobKindRunning("extract-source-docs", 19)).toBe(false);

  const childDone = snapshot("extract-17", "extract-source-docs", {
    result: { project_id: 17, extracted: 1 },
  });
  await act(async () => {
    sendJobEvent("extract-17", childDone);
    sendJobEvent("extract-17", childDone);
  });
  expect(result.current.activeJobs.filter((job) => job.jobId === "extract-17")).toHaveLength(1);
});

it("uses import-scan source scope and polling when its extraction child is already done", async () => {
  const queryClient = new QueryClient();
  vi.mocked(fetchJob).mockImplementation((jobId, signal) =>
    jobId === "extract-import"
      ? Promise.resolve(snapshot("extract-import", "extract-source-docs", {
        result: { project_id: 22, extracted: 1 },
      }))
      : stalledJob(signal));
  vi.mocked(connectJobWebSocket).mockImplementation((jobId, _onEvent, onError) => {
    if (jobId === "extract-import") onError(new Error("WebSocket unavailable"));
    return vi.fn();
  });
  const { result } = renderHook(useJobContext, { wrapper: providerWrapper(queryClient) });
  await act(async () => {
    await result.current.runJob(
      "sync",
      () => Promise.resolve("import-parent"),
      undefined,
      { sourceIds: [22, 22] },
    );
    sendJobEvent("import-parent", snapshot("import-parent", "import-scan", {
      result: { pdf_extract_job_id: "extract-import" },
    }));
    await Promise.resolve();
  });

  await waitFor(() => {
    expect(result.current.activeJobs).toContainEqual(expect.objectContaining({
      jobId: "extract-import",
      status: "done",
      sourceIds: [22],
    }));
  });
  expect(fetchJob).toHaveBeenCalledWith("extract-import", expect.any(AbortSignal));
});

it.each(["error", "cancelled"] as const)(
  "does not refresh mounted Source content when an observed extraction child is %s",
  async (status) => {
    const queryClient = new QueryClient();
    const docsKey = ["sourceContent", 31, "docs"] as const;
    queryClient.setQueryData(docsKey, ["cached"]);
    const fetchDocs = vi.fn().mockResolvedValue(["refreshed"]);
    const docsObserver = new QueryObserver(queryClient, {
      queryKey: docsKey,
      queryFn: fetchDocs,
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unsubscribe = docsObserver.subscribe(() => {});
    vi.mocked(fetchJob).mockImplementation((_jobId, signal) => stalledJob(signal));
    const { result } = renderHook(useJobContext, { wrapper: providerWrapper(queryClient) });
    await act(async () => {
      await result.current.runJob(
        "import-scan",
        () => Promise.resolve(`import-${status}`),
        undefined,
        { sourceIds: [31] },
      );
      sendJobEvent(`import-${status}`, snapshot(`import-${status}`, "import-scan", {
        result: { pdf_extract_job_id: `extract-${status}` },
      }));
      sendJobEvent(`extract-${status}`, snapshot(`extract-${status}`, "extract-source-docs", {
        status,
        progress: status === "error" ? 100 : 10,
        result: null,
        error: status === "error" ? "Extraction failed" : null,
      }));
      await Promise.resolve();
    });

    expect(docsObserver.getCurrentResult().data).toEqual(["cached"]);
    expect(fetchDocs).not.toHaveBeenCalled();
    unsubscribe();
    queryClient.clear();
  },
);

it("ignores malformed and absent extraction receipts", async () => {
  const queryClient = new QueryClient();
  vi.mocked(fetchJob).mockImplementation((_jobId, signal) => stalledJob(signal));
  const { result } = renderHook(useJobContext, { wrapper: providerWrapper(queryClient) });
  await act(async () => {
    await result.current.runJob("sync", () => Promise.resolve("missing-receipt"));
    sendJobEvent("missing-receipt", snapshot("missing-receipt", "sync", {
      result: { results: [{ project_id: 17 }] },
    }));
    await result.current.runJob("import-scan", () => Promise.resolve("malformed-receipt"));
    sendJobEvent("malformed-receipt", snapshot("malformed-receipt", "import-scan", {
      result: { pdf_extract_job_id: 42 },
    }));
  });

  expect(vi.mocked(connectJobWebSocket).mock.calls.map(([jobId]) => jobId)).toEqual([
    "missing-receipt",
    "malformed-receipt",
  ]);
});

it("retries receipt discovery after a terminal snapshot fetch fails", async () => {
  const queryClient = new QueryClient();
  let parentFetches = 0;
  vi.mocked(fetchJob).mockImplementation((jobId, signal) => {
    if (jobId !== "retry-parent") return stalledJob(signal);
    parentFetches += 1;
    if (parentFetches === 1) return stalledJob(signal);
    if (parentFetches === 2) return Promise.reject(new Error("Temporary fetch failure"));
    return Promise.resolve(snapshot("retry-parent", "import-scan", {
      result: { pdf_extract_job_id: "retry-child" },
    }));
  });
  const { result } = renderHook(useJobContext, { wrapper: providerWrapper(queryClient) });
  const terminalEvent: JobEvent = {
    status: "done",
    message: "Complete",
    progress: 100,
    result: null,
    error: null,
  };
  await act(async () => {
    await result.current.runJob(
      "import-scan",
      () => Promise.resolve("retry-parent"),
      undefined,
      { sourceIds: [41] },
    );
    sendJobEvent("retry-parent", terminalEvent);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(vi.mocked(connectJobWebSocket).mock.calls.some(([jobId]) =>
    jobId === "retry-child")).toBe(false);

  await act(async () => {
    sendJobEvent("retry-parent", terminalEvent);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(vi.mocked(connectJobWebSocket).mock.calls.filter(([jobId]) =>
    jobId === "retry-child")).toHaveLength(1);
});

it("stops an extraction child observer on unmount without reporting a failure", async () => {
  const queryClient = new QueryClient();
  let childSignal: AbortSignal | undefined;
  const childDisconnect = vi.fn();
  vi.mocked(fetchJob).mockImplementation((jobId, signal) => {
    if (jobId === "unmount-child") childSignal = signal;
    return stalledJob(signal);
  });
  vi.mocked(connectJobWebSocket).mockImplementation((jobId) =>
    jobId === "unmount-child" ? childDisconnect : vi.fn());
  const { result, unmount } = renderHook(useJobContext, { wrapper: providerWrapper(queryClient) });
  await act(async () => {
    await result.current.runJob("sync", () => Promise.resolve("unmount-parent"));
    sendJobEvent("unmount-parent", snapshot("unmount-parent", "sync", {
      result: {
        results: [{ project_id: 51, pdf_extract_job_id: "unmount-child" }],
      },
    }));
  });
  expect(childSignal?.aborted).toBe(false);

  await act(async () => unmount());
  expect(childSignal?.aborted).toBe(true);
  expect(childDisconnect).toHaveBeenCalledOnce();
});
