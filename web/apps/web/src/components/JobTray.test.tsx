// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useJobContext, type ActiveJob } from "../context/JobContext";
import JobTray from "./JobTray";

vi.mock("../context/JobContext", () => ({
  useJobContext: vi.fn(),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const clearJob = vi.fn();

function job(
  jobId: string,
  progress: number | null,
  status = "running",
): ActiveJob {
  return {
    jobId,
    kind: "sync",
    status,
    message: `Job ${jobId}`,
    progress,
    profileId: null,
  };
}

function renderTray(activeJobs: ActiveJob[]) {
  vi.mocked(useJobContext).mockReturnValue({
    activeJobs,
    clearJob,
    runJob: vi.fn(),
    isJobKindRunning: vi.fn(),
  });
  return render(<JobTray />);
}

afterEach(() => {
  cleanup();
  clearJob.mockClear();
  document.documentElement.style.removeProperty("--job-tray-height");
});

describe("JobTray progress", () => {
  it("renders nullable percentage progress without rescaling it", () => {
    renderTray([
      job("zero", 0),
      job("ten", 10),
      job("complete", 100),
      job("unknown", null),
    ]);

    expect(screen.getByText("0%")).toBeTruthy();
    expect(screen.getByText("10%")).toBeTruthy();
    expect(screen.getByText("100%")).toBeTruthy();
    expect(screen.queryByText("null%")).toBeNull();
    expect(
      screen.getAllByRole("progressbar").map((progressbar) =>
        progressbar.getAttribute("aria-valuenow"),
      ),
    ).toEqual(["0", "10", "100"]);
  });

  it("clamps, rounds, and keeps terminal jobs dismissible", () => {
    renderTray([
      job("below", -3),
      job("fraction", 42.6),
      job("above", 104),
      job("failed", null, "error"),
    ]);

    expect(screen.getByText("0%")).toBeTruthy();
    expect(screen.getByText("43%")).toBeTruthy();
    expect(screen.getByText("100%")).toBeTruthy();
    expect(screen.getByText("error")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });
});
