// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import GlobalProductionPage from "./GlobalProductionPage";

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
    reloadProfiles: vi.fn(),
  }),
}));
vi.mock("../api/engine", () => ({
  fetchPrinterCheckoffLinks: (...args: unknown[]) => api.fetchPrinterCheckoffLinks(...args),
  fetchUnattributedPrints: (...args: unknown[]) => api.fetchUnattributedPrints(...args),
}));
vi.mock("../components/checkoff/PrinterLiveStrip", () => ({
  default: () => <div>Live printers</div>,
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
    api.fetchPrinterCheckoffLinks.mockImplementation(async (options?: { state?: string }) => {
      if (options?.state === "awaiting_verify") {
        return {
          links: [
            {
              id: "await-1",
              state: "awaiting_verify",
              profile_id: 7,
              host_name: "Core One",
              filename: "plate-01.gcode",
            },
          ],
        };
      }
      if (options?.state === "host_failed") {
        return {
          links: [
            {
              id: "fail-1",
              state: "host_failed",
              profile_id: 8,
              host_name: "X1C",
              filename: "bad.gcode",
            },
          ],
        };
      }
      return { links: [] };
    });
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
    expect(screen.getByText(/6 remaining/).textContent).toContain("6 remaining");
    expect(screen.getByRole("link", { name: "Open Voron in Production" }).getAttribute("href")).toBe(
      "/export?profile=7",
    );
    expect(screen.getByRole("link", { name: "Checkoff for Voron" }).getAttribute("href")).toBe(
      "/progress?profile=7",
    );
    expect(screen.getByText("Not applied").textContent).toBe("Not applied");
    await waitFor(() => {
      expect(
        screen
          .getByRole("link", { name: "Awaiting verification for Voron" })
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

    await waitFor(() => {
      expect(screen.getByText("Live printers").textContent).toBe("Live printers");
    });
    expect(api.fetchPrinterCheckoffLinks).toHaveBeenCalledWith({ state: "watching" });
    expect(api.fetchPrinterCheckoffLinks).toHaveBeenCalledWith({ state: "awaiting_verify" });
    expect(api.fetchPrinterCheckoffLinks).toHaveBeenCalledWith({ state: "host_failed" });
    expect(api.fetchPrinterCheckoffLinks).toHaveBeenCalledWith({ state: "verified" });
    expect(
      api.fetchPrinterCheckoffLinks.mock.calls.every(
        (call) => (call[0] as { profile_id?: number } | undefined)?.profile_id == null,
      ),
    ).toBe(true);
    expect(screen.getByText("orphan.gcode").textContent).toBe("orphan.gcode");
    expect(screen.getByRole("link", { name: "Failed for Done Build" }).getAttribute("href")).toBe(
      "/progress?profile=8",
    );
  });
});
