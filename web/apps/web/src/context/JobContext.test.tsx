// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { connectJobWebSocket, fetchJob } from "../api/engine";
import { queryKeys } from "../queries/keys";
import { JobProvider, useJobContext } from "./JobContext";

vi.mock("../api/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/engine")>();
  return {
    ...actual,
    connectJobWebSocket: vi.fn(() => vi.fn()),
    fetchJob: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("JobProvider terminal retention", () => {
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
