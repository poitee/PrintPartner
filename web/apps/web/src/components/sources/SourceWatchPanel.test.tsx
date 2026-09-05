// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SourceWatchPanel from "./SourceWatchPanel";

const { api } = vi.hoisted(() => ({
  api: {
    fetchSourceActivity: vi.fn(),
    fetchSourceUpdateCheckSettings: vi.fn(),
  },
}));

vi.mock("../../api/endpoints/sourceContent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/endpoints/sourceContent")>();
  return { ...actual, ...api };
});

vi.mock("../../context/DateFormatContext", () => ({
  useDateFormat: () => ({ formatDate: (value: string) => value }),
}));

const props = {
  githubSourceCount: 1,
  manualTrackedCount: 0,
  updateCount: 0,
  attachedUpdateCount: 0,
  lastCheckedAt: null,
  checking: false,
  syncing: false,
  onCheckNow: vi.fn(),
  onSyncGitHub: vi.fn(),
  onShowUpdates: vi.fn(),
  onImportRepositories: vi.fn(),
};

describe("SourceWatchPanel activity", () => {
  beforeEach(() => {
    api.fetchSourceActivity.mockReset();
    api.fetchSourceUpdateCheckSettings.mockReset();
    api.fetchSourceUpdateCheckSettings.mockResolvedValue({
      interval_hours: 24,
      auto_sync_updates: false,
      last_checked_at: null,
    });
  });

  afterEach(cleanup);

  it("distinguishes an activity failure from an empty activity feed and retries", async () => {
    api.fetchSourceActivity
      .mockRejectedValueOnce(new Error("alerts offline"))
      .mockResolvedValueOnce([
        {
          id: 9,
          at: "2026-09-04T10:00:00Z",
          kind: "source.updated",
          source_id: 2,
          source_name: "Working Source",
          detail: null,
        },
      ]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <SourceWatchPanel {...props} />
      </QueryClientProvider>,
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load recent source alerts: alerts offline",
    );
    expect(
      screen.queryByText("Source updates and automatic refreshes will appear here and in the app banner."),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry source alerts" }));

    expect(await screen.findByText("Working Source refreshed automatically")).toBeTruthy();
  });
});
