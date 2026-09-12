// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
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
