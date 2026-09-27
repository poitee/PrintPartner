// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render as renderView, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import GlobalProductionPage from "./GlobalProductionPage";
import { queryKeys } from "../queries/keys";

function render(children: ReactNode, queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return renderView(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>);
}

const state = vi.hoisted(() => ({
  profiles: [
    {
      id: 7,
      name: "Voron",
      archived_at: null,
      part_count: 24,
      accepted_progress: { kind: "ready" as const, remaining_units: 6, total_units: 30 },
      build_stale: true,
      last_used_at: "2026-08-20T00:00:00Z",
    },
    {
      id: 8,
      name: "Done Build",
      archived_at: null,
      part_count: 2,
      accepted_progress: { kind: "ready" as const, remaining_units: 0, total_units: 2 },
      build_stale: false,
      last_used_at: null,
    },
    {
      id: 9,
      name: "Fresh Build",
      archived_at: null,
      part_count: 0,
      accepted_progress: { kind: "empty" as const },
      build_stale: false,
      last_used_at: null,
    },
  ],
  loading: false,
  error: null as string | null,
}));

const api = vi.hoisted(() => ({
  fetchPrinterCheckoffLinks: vi.fn(),
  fetchUnattributedPrints: vi.fn(),
  fetchProfile: vi.fn(),
  fetchProfiles: vi.fn(),
  reloadProfiles: vi.fn(),
}));

vi.mock("../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: { ok: true }, error: null, loading: false }),
}));
vi.mock("../context/ProfileContext", () => ({
  useProfileSelection: () => ({
    profiles: state.profiles,
    selectedProfileId: 7,
    setSelectedProfileId: vi.fn(),
    loading: state.loading,
    error: state.error,
    reloadProfiles: api.reloadProfiles,
  }),
}));
vi.mock("../api/endpoints/checkoff", () => ({
  fetchPrinterCheckoffLinks: (...args: unknown[]) => api.fetchPrinterCheckoffLinks(...args),
  fetchUnattributedPrints: (...args: unknown[]) => api.fetchUnattributedPrints(...args),
}));
vi.mock("../api/endpoints/plans", () => ({
  fetchProfile: (...args: unknown[]) => api.fetchProfile(...args),
  fetchProfiles: (...args: unknown[]) => api.fetchProfiles(...args),
}));
vi.mock("../components/checkoff/PrinterLiveStrip", () => ({
  default: ({
    onCheckoffUpdate,
    onUnattributedUpdate,
  }: {
    onCheckoffUpdate: (profileId: number) => void;
    onUnattributedUpdate: () => void;
  }) => (
    <>
      <button type="button" onClick={() => onCheckoffUpdate(7)}>Live printers</button>
      <button type="button" onClick={onUnattributedUpdate}>Unmatched printer file</button>
    </>
  ),
}));
vi.mock("../components/checkoff/UnattributedPrintCard", () => ({
  default: ({ print }: { print: { filename: string } }) => <p>{print.filename}</p>,
}));

describe("GlobalProductionPage", () => {
  afterEach(cleanup);

  beforeEach(() => {
    state.loading = false;
    state.error = null;
    api.fetchPrinterCheckoffLinks.mockReset();
    api.fetchUnattributedPrints.mockReset();
    api.reloadProfiles.mockReset();
    api.fetchProfile.mockReset();
    api.fetchProfiles.mockReset();
    api.fetchProfile.mockResolvedValue({
      ...state.profiles[0],
      accepted_progress: { kind: "ready", remaining_units: 5, total_units: 30 },
    });
    api.fetchPrinterCheckoffLinks.mockResolvedValue({ links: [
      { id: "await-1", state: "awaiting_verify", profile_id: 7, host_name: "Core One", filename: "plate-01.gcode" },
      { id: "fail-1", state: "host_failed", profile_id: 8, host_name: "X1C", filename: "bad.gcode" },
    ] });
    api.fetchUnattributedPrints.mockResolvedValue([
      { id: "u1", filename: "orphan.gcode", candidates: [] },
    ]);
  });

  it("aggregates remaining Checkoff work across Builds", async () => {
    render(
      <MemoryRouter>
        <GlobalProductionPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "All Production" }).textContent).toBe("All Production");
    expect(screen.getByText(/6 of 30 remaining/).textContent).toContain(
      "6 of 30 remaining",
    );
    expect(screen.getByRole("link", { name: "Open Voron in Production" }).getAttribute("href")).toBe(
      "/export?profile=7",
    );
    expect(screen.getByRole("link", { name: "Checkoff for Voron" }).getAttribute("href")).toBe(
      "/progress?profile=7",
    );
    expect(screen.getByText("No Accepted Plan yet").textContent).toBe(
      "No Accepted Plan yet",
    );
    await waitFor(() => {
      expect(
        screen
          .getByRole("link", { name: "Needs verification for Voron" })
          .getAttribute("href"),
      ).toBe("/progress?profile=7");
    });
  });

  it("shows farm verification, failures, and unmatched prints", async () => {
    render(
      <MemoryRouter>
        <GlobalProductionPage />
      </MemoryRouter>,
    );

    expect((await screen.findByText("orphan.gcode")).textContent).toBe("orphan.gcode");
    expect(api.fetchPrinterCheckoffLinks).toHaveBeenCalledExactlyOnceWith();
    expect(
      api.fetchPrinterCheckoffLinks.mock.calls.every(
        (call) => (call[0] as { profile_id?: number } | undefined)?.profile_id == null,
      ),
    ).toBe(true);
    expect(screen.getByRole("link", { name: "Failed for Done Build" }).getAttribute("href")).toBe(
      "/progress?profile=8",
    );
  });

  it("refreshes only the affected Build summary after a printer event", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.profiles, state.profiles);
    render(
      <MemoryRouter>
        <GlobalProductionPage />
      </MemoryRouter>,
      queryClient,
    );
    await screen.findByText("orphan.gcode");

    fireEvent.click(screen.getByRole("button", { name: "Live printers" }));

    await waitFor(() => expect(api.fetchProfile).toHaveBeenCalledExactlyOnceWith(7));
    await waitFor(() => {
      expect(
        queryClient.getQueryData<typeof state.profiles>(queryKeys.profiles)?.[0]?.accepted_progress,
      ).toEqual({ kind: "ready", remaining_units: 5, total_units: 30 });
    });
    expect(api.fetchProfiles).not.toHaveBeenCalled();
    expect(api.reloadProfiles).not.toHaveBeenCalled();
    await waitFor(() => expect(api.fetchPrinterCheckoffLinks).toHaveBeenCalledTimes(2));
  });

  it("leaves Build summaries alone when only unmatched printer files change", async () => {
    render(
      <MemoryRouter>
        <GlobalProductionPage />
      </MemoryRouter>,
    );
    await screen.findByText("orphan.gcode");

    fireEvent.click(screen.getByRole("button", { name: "Unmatched printer file" }));

    await waitFor(() => expect(api.fetchUnattributedPrints).toHaveBeenCalledTimes(2));
    expect(api.fetchProfile).not.toHaveBeenCalled();
    expect(api.reloadProfiles).not.toHaveBeenCalled();
  });
});
