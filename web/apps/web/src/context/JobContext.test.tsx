// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TENANT_FEATURE_TOGGLES_CAPABILITY, type JobSnapshot } from "@print-partner/contracts";
import type { ReactNode } from "react";
import { EngineHttpError } from "../api/engineTransport";
import { fetchJob } from "../api/endpoints/jobs";
import { connectJobWebSocket, JobNotFoundError } from "../api/jobWebSocket";
import { queryKeys } from "../queries/keys";
import { JobProvider, useJobContext } from "./JobContext";

const healthState = vi.hoisted(() => ({ capabilities: [] as string[] }));

vi.mock("../queries/health", () => ({
  useHealthQuery: () => ({
    data: { ok: true, capabilities: healthState.capabilities },
    status: "success",
  }),
}));

vi.mock("../api/endpoints/jobs", () => ({
  fetchJob: vi.fn(),
}));

vi.mock("../api/jobWebSocket", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api/jobWebSocket")>(),
  connectJobWebSocket: vi.fn(() => vi.fn()),
}));

describe("JobProvider elapsed observation deadline", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>
      <JobProvider>{children}</JobProvider>
    </QueryClientProvider>
  );
  const running: JobSnapshot = {
    job_id: "observed", kind: "check-source-updates", status: "running",
    message: "Checking sources", progress: 10, result: null, error: null,
  };
  const completed: JobSnapshot = {
    ...running, status: "done", message: "Complete", progress: 100,
    result: { checked: 1 },
  };
  const timeoutMessage = "Lost contact with the job. It may still be running on the server. Job timed out waiting for completion";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(fetchJob).mockReset();
    vi.mocked(connectJobWebSocket).mockReset().mockReturnValue(vi.fn());
  });

  it.each([
    new TypeError("Failed to fetch"),
    new EngineHttpError("API restarting", 503),
  ])("expires at 60 seconds despite repeated %s failures", async (failure) => {
    vi.mocked(fetchJob).mockRejectedValue(failure);
    const disconnect = vi.fn();
    vi.mocked(connectJobWebSocket).mockReturnValue(disconnect);
    const { result } = renderHook(useJobContext, { wrapper });
    const onDone = vi.fn();
    await act(async () => {
      await result.current.runJob("check-source-updates", () => Promise.resolve("observed"), onDone);
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(result.current.activeJobs[0]).toMatchObject({ status: "pending", message: "Starting…" });
    expect(result.current.isJobKindRunning("check-source-updates")).toBe(true);
    expect(fetchJob).toHaveBeenCalledTimes(10);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.activeJobs[0]).toMatchObject({ status: "error", message: timeoutMessage });
    expect(result.current.isJobKindRunning("check-source-updates")).toBe(false);
    expect(onDone).toHaveBeenCalledExactlyOnceWith({
      job_id: "observed", kind: "check-source-updates", status: "error",
      message: timeoutMessage, error: timeoutMessage, progress: null, result: null,
    });
    expect(disconnect).toHaveBeenCalledOnce();
    expect(vi.mocked(fetchJob).mock.calls[0]?.[1]?.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(fetchJob).toHaveBeenCalledTimes(10);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it.each(["sync", "extract-source-docs", "import-scan"])("keeps %s's 30-minute elapsed window", async (kind) => {
    vi.mocked(fetchJob).mockRejectedValue(new EngineHttpError("API restarting", 502));
    const { result } = renderHook(useJobContext, { wrapper });
    const onDone = vi.fn();
    await act(async () => {
      await result.current.runJob(kind, () => Promise.resolve("observed"), onDone);
      await vi.advanceTimersByTimeAsync(1_799_999);
    });
    expect(result.current.activeJobs[0]?.status).toBe("pending");
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(onDone).toHaveBeenCalledExactlyOnceWith({
      job_id: "observed", kind, status: "error", message: timeoutMessage,
      error: timeoutMessage, progress: null, result: null,
    });
  });

  it("resets backoff after a successful poll without renewing the deadline", async () => {
    vi.mocked(fetchJob).mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = renderHook(useJobContext, { wrapper });
    const onDone = vi.fn();
    await act(async () => {
      await result.current.runJob("check-source-updates", () => Promise.resolve("observed"), onDone);
      await vi.advanceTimersByTimeAsync(12_400);
    });
    vi.mocked(fetchJob).mockResolvedValueOnce(running).mockRejectedValue(new TypeError("Failed to fetch"));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(result.current.activeJobs[0]).toMatchObject({ status: "running", message: "Checking sources" });
    expect(fetchJob).toHaveBeenCalledTimes(7);
    await act(async () => { await vi.advanceTimersByTimeAsync(399); });
    expect(fetchJob).toHaveBeenCalledTimes(7);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchJob).toHaveBeenCalledTimes(8);
    await act(async () => { await vi.advanceTimersByTimeAsync(37_199); });
    expect(result.current.activeJobs[0]?.status).toBe("running");
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const message = `${timeoutMessage} (last status: running)`;
    expect(result.current.activeJobs[0]).toMatchObject({ status: "error", message });
    expect(onDone).toHaveBeenCalledExactlyOnceWith({
      job_id: "observed", kind: "check-source-updates", status: "error", message,
      error: message, progress: null, result: null,
    });
  });

  it("expires a stalled HTTP request and ignores its late completion", async () => {
    let settle: ((snapshot: JobSnapshot) => void) | undefined;
    vi.mocked(fetchJob).mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    const disconnect = vi.fn();
    vi.mocked(connectJobWebSocket).mockReturnValue(disconnect);
    const { result } = renderHook(useJobContext, { wrapper });
    const onDone = vi.fn();
    await act(async () => {
      await result.current.runJob("check-source-updates", () => Promise.resolve("observed"), onDone);
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current.activeJobs[0]).toMatchObject({ status: "error", message: timeoutMessage });
    expect(vi.mocked(fetchJob).mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(disconnect).toHaveBeenCalledOnce();
    await act(async () => { settle?.(completed); });
    expect(onDone).toHaveBeenCalledExactlyOnceWith({
      job_id: "observed", kind: "check-source-updates", status: "error",
      message: timeoutMessage, error: timeoutMessage, progress: null, result: null,
    });
  });

  it("rejects a late terminal snapshot before the delayed deadline timer runs", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      vi.mocked(fetchJob).mockRejectedValue(new TypeError("Failed to fetch"));
      const { result } = renderHook(useJobContext, { wrapper });
      const onDone = vi.fn();
      await act(async () => {
        await result.current.runJob("check-source-updates", () => Promise.resolve("observed"), onDone);
      });
      clock.mockReturnValue(60_000);
      await act(async () => { vi.mocked(connectJobWebSocket).mock.calls[0]?.[1](completed); });
      expect(result.current.activeJobs[0]).toMatchObject({ status: "error", message: timeoutMessage });
      expect(onDone).toHaveBeenCalledExactlyOnceWith({
        job_id: "observed", kind: "check-source-updates", status: "error", message: timeoutMessage,
        error: timeoutMessage, progress: null, result: null,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("reports a non-transient HTTP failure immediately", async () => {
    vi.mocked(fetchJob).mockRejectedValue(new EngineHttpError("Access denied", 403));
    const { result } = renderHook(useJobContext, { wrapper });
    const onDone = vi.fn();
    await act(async () => {
      await result.current.runJob("check-source-updates", () => Promise.resolve("observed"), onDone);
    });
    const message = "Lost contact with the job. It may still be running on the server. Access denied";
    expect(result.current.activeJobs[0]).toMatchObject({ status: "error", message });
    expect(onDone).toHaveBeenCalledExactlyOnceWith({
      job_id: "observed", kind: "check-source-updates", status: "error", message,
      error: message, progress: null, result: null,
    });
    expect(vi.mocked(fetchJob).mock.calls[0]?.[1]?.aborted).toBe(true);
  });

  it("aborts bounded observation on unmount without reporting a timeout", async () => {
    vi.mocked(fetchJob).mockResolvedValue(running);
    const disconnect = vi.fn();
    vi.mocked(connectJobWebSocket).mockReturnValue(disconnect);
    const { result, unmount } = renderHook(useJobContext, { wrapper });
    const onDone = vi.fn();
    await act(async () => {
      await result.current.runJob("check-source-updates", () => Promise.resolve("observed"), onDone);
    });
    expect(result.current.activeJobs[0]).toMatchObject({ status: "running", message: "Checking sources" });
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(vi.mocked(fetchJob).mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(fetchJob).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes a terminal socket event immediately even if its snapshot fetch stalls", async () => {
    vi.mocked(fetchJob).mockRejectedValue(new TypeError("Failed to fetch"));
    const disconnect = vi.fn();
    vi.mocked(connectJobWebSocket).mockReturnValue(disconnect);
    const { result } = renderHook(useJobContext, { wrapper });
    const onDone = vi.fn();
    await act(async () => {
      await result.current.runJob("check-source-updates", () => Promise.resolve("observed"), onDone);
      await vi.advanceTimersByTimeAsync(12_400);
    });
    vi.mocked(fetchJob).mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      vi.mocked(connectJobWebSocket).mock.calls[0]?.[1]({
        status: "done", message: "Complete", progress: 100, result: { checked: 1 }, error: null,
      });
    });
    expect(onDone).toHaveBeenCalledExactlyOnceWith(completed);
    expect(result.current.activeJobs[0]).toMatchObject({ status: "done", message: "Complete", progress: 100 });
    expect(disconnect).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(onDone).toHaveBeenCalledOnce();
  });

  it.each(["HTTP 404", "WS 1008"])("stops with Job not found after transient failures on %s", async (outcome) => {
    vi.mocked(fetchJob).mockRejectedValue(new EngineHttpError("API restarting", 503));
    const disconnect = vi.fn();
    vi.mocked(connectJobWebSocket).mockReturnValue(disconnect);
    const { result } = renderHook(useJobContext, { wrapper });
    const onDone = vi.fn();
    await act(async () => {
      await result.current.runJob("check-source-updates", () => Promise.resolve("observed"), onDone);
      await vi.advanceTimersByTimeAsync(12_400);
    });
    await act(async () => {
      if (outcome === "HTTP 404") {
        vi.mocked(fetchJob).mockRejectedValue(new EngineHttpError("Job not found", 404));
        await vi.advanceTimersByTimeAsync(10_000);
      } else {
        vi.mocked(connectJobWebSocket).mock.calls[0]?.[2](new JobNotFoundError());
      }
    });
    expect(result.current.activeJobs[0]).toMatchObject({ status: "error", message: "Job not found" });
    expect(onDone).toHaveBeenCalledExactlyOnceWith({
      job_id: "observed", kind: "check-source-updates", status: "error",
      message: "Job not found", error: "Job not found", progress: null, result: null,
    });
    expect(disconnect).toHaveBeenCalledOnce();
    expect(vi.mocked(fetchJob).mock.calls[0]?.[1]?.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("keeps STL exports unbounded through failures beyond 30 minutes", async () => {
    vi.mocked(fetchJob).mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = renderHook(useJobContext, { wrapper });
    const onDone = vi.fn();
    await act(async () => {
      await result.current.runJob("stl-export", () => Promise.resolve("observed"), onDone);
      await vi.advanceTimersByTimeAsync(2_100_000);
    });
    expect(result.current.activeJobs[0]).toMatchObject({ status: "pending", message: "Starting…" });
    expect(result.current.isJobKindRunning("stl-export")).toBe(true);
    await act(async () => { vi.mocked(connectJobWebSocket).mock.calls[0]?.[1](completed); });
    expect(onDone).toHaveBeenCalledExactlyOnceWith(completed);
    expect(result.current.activeJobs[0]?.status).toBe("done");
  });
});

afterEach(() => {
  healthState.capabilities = [];
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("JobProvider rebuild job transport", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <JobProvider>{children}</JobProvider>
    </QueryClientProvider>
  );
  const running: JobSnapshot = {
    job_id: "observed", kind: "check-source-updates", status: "running",
    message: "Checking sources", progress: 4, result: null, error: null,
  };
  const reconnected: JobSnapshot = {
    ...running, message: "Checked 16", progress: 16,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(fetchJob).mockReset();
    vi.mocked(connectJobWebSocket).mockReset().mockReturnValue(vi.fn());
    healthState.capabilities = [];
  });

  it("job_context_rebuild_reconnect_uses_snapshot", async () => {
    healthState.capabilities = [TENANT_FEATURE_TOGGLES_CAPABILITY];
    vi.mocked(fetchJob).mockResolvedValue({ ...running, progress: 1, message: "Stale poll" });
    const { result } = renderHook(useJobContext, { wrapper });
    await act(async () => {
      await result.current.runJob("check-source-updates", () => Promise.resolve("observed"));
    });
    expect(connectJobWebSocket).toHaveBeenCalledTimes(1);
    expect(fetchJob).not.toHaveBeenCalled();
    await act(async () => {
      vi.mocked(connectJobWebSocket).mock.calls[0]?.[1](running);
    });
    expect(result.current.activeJobs[0]).toMatchObject({ status: "running", progress: 4 });
    await act(async () => {
      vi.mocked(connectJobWebSocket).mock.calls[0]?.[2](new Error("Job event stream failed"));
    });
    expect(result.current.activeJobs[0]).toMatchObject({ status: "running", progress: 4, message: "Checking sources" });
    await act(async () => {
      vi.mocked(connectJobWebSocket).mock.calls[0]?.[1](reconnected);
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current.activeJobs[0]).toMatchObject({
      status: "running", message: "Checked 16", progress: 16,
    });
    expect(fetchJob).not.toHaveBeenCalled();
  });

  it("job_context_flag_off_uses_existing_transport", async () => {
    vi.mocked(fetchJob).mockResolvedValue(running);
    const { result } = renderHook(useJobContext, { wrapper });
    await act(async () => {
      await result.current.runJob("check-source-updates", () => Promise.resolve("observed"));
    });
    expect(connectJobWebSocket).toHaveBeenCalledTimes(1);
    expect(fetchJob).toHaveBeenCalledWith("observed", expect.any(AbortSignal));
    await act(async () => {
      vi.mocked(connectJobWebSocket).mock.calls[0]?.[2](new Error("Job event stream failed"));
    });
    expect(result.current.activeJobs[0]).toMatchObject({
      status: "running", message: "Checking sources", progress: 4,
    });
    expect(result.current.activeJobs[0]?.message).not.toMatch(/Lost contact/);
  });
});

describe("JobProvider terminal retention", () => {
  it("shows Job not found immediately and aborts polling on a missing-job close", async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(fetchJob).mockImplementationOnce((_id, pollSignal) => new Promise((_resolve, reject) => {
      signal = pollSignal;
      pollSignal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    }));
    const disconnect = vi.fn();
    vi.mocked(connectJobWebSocket).mockReturnValue(disconnect);
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}><JobProvider>{children}</JobProvider></QueryClientProvider>
    );
    const { result } = renderHook(useJobContext, { wrapper });
    const onDone = vi.fn();
    await act(async () => {
      await result.current.runJob("stl-export", () => Promise.resolve("missing"), onDone);
      vi.mocked(connectJobWebSocket).mock.calls.at(-1)?.[2](new JobNotFoundError());
    });
    expect(result.current.activeJobs).toEqual([expect.objectContaining({ status: "error", message: "Job not found" })]);
    expect(onDone).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "error", error: "Job not found" }));
    expect(signal?.aborted).toBe(true);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("shows Job not found when HTTP 404 arrives before the socket close", async () => {
    vi.mocked(fetchJob).mockRejectedValueOnce(new EngineHttpError("Job not found", 404, { detail: "Job not found" }));
    const disconnect = vi.fn();
    vi.mocked(connectJobWebSocket).mockReturnValue(disconnect);
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}><JobProvider>{children}</JobProvider></QueryClientProvider>
    );
    const { result } = renderHook(useJobContext, { wrapper });
    const onDone = vi.fn();
    await act(async () => {
      await result.current.runJob("stl-export", () => Promise.resolve("missing"), onDone);
    });
    expect(result.current.activeJobs).toEqual([expect.objectContaining({ status: "error", message: "Job not found" })]);
    expect(onDone).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "error", error: "Job not found" }));
    expect(vi.mocked(fetchJob).mock.calls.at(-1)?.[1]?.aborted).toBe(true);
    expect(disconnect).toHaveBeenCalledOnce();
    await act(async () => {
      vi.mocked(connectJobWebSocket).mock.calls.at(-1)?.[2](new JobNotFoundError());
    });
    expect(onDone).toHaveBeenCalledOnce();
    expect(result.current.activeJobs[0]?.message).toBe("Job not found");
  });

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

  it.each([new TypeError("Failed to fetch"), new EngineHttpError("API restarting", 503)])("keeps the socket observer alive through a transient poll failure: %s", async (failure) => {
    vi.useFakeTimers();
    const completed = { job_id: "download", kind: "export-stl-pack", status: "done", message: "Complete", progress: 100, result: {}, error: null };
    vi.mocked(fetchJob).mockRejectedValueOnce(failure).mockResolvedValue(completed);
    const disconnect = vi.fn();
    vi.mocked(connectJobWebSocket).mockReturnValue(disconnect);
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}><JobProvider>{children}</JobProvider></QueryClientProvider>
    );
    const { result } = renderHook(useJobContext, { wrapper });
    const onDone = vi.fn();
    await act(async () => {
      await result.current.runJob("stl-export", () => Promise.resolve("download"), onDone);
    });
    expect(disconnect).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(onDone).toHaveBeenCalledExactlyOnceWith(completed);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("backs off sustained poll failures to 10 seconds and resets after recovery", async () => {
    vi.useFakeTimers();
    const running = { job_id: "download", kind: "export-stl-pack", status: "running", message: "Creating ZIP", progress: null, result: null, error: null };
    const completed = { ...running, status: "done", message: "Complete", progress: 100, result: {} };
    vi.mocked(fetchJob).mockRejectedValue(new EngineHttpError("API restarting", 502));
    const disconnect = vi.fn();
    vi.mocked(connectJobWebSocket).mockReturnValue(disconnect);
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}><JobProvider>{children}</JobProvider></QueryClientProvider>
    );
    const { result } = renderHook(useJobContext, { wrapper });
    const onDone = vi.fn();
    await act(async () => { await result.current.runJob("stl-export", () => Promise.resolve("download"), onDone); });
    let calls = 1;
    for (const delay of [400, 800, 1600, 3200, 6400, 10_000, 10_000]) {
      await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
      expect(fetchJob).toHaveBeenCalledTimes(calls);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(fetchJob).toHaveBeenCalledTimes(++calls);
    }
    expect(onDone).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    vi.mocked(fetchJob).mockResolvedValueOnce(running).mockResolvedValue(completed);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(result.current.activeJobs[0]?.status).toBe("running");
    await act(async () => { await vi.advanceTimersByTimeAsync(399); });
    expect(onDone).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(onDone).toHaveBeenCalledExactlyOnceWith(completed);
    expect(disconnect).toHaveBeenCalledOnce();
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
