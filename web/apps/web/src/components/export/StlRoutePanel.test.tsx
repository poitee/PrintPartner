// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobSnapshot } from "@print-partner/contracts";
import StlRoutePanel from "./StlRoutePanel";

const api = vi.hoisted(() => ({
  startExportStlPack: vi.fn(),
  runJob: vi.fn(),
}));

vi.mock("../../api/endpoints/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/endpoints/jobs")>()),
  startExportStlPack: api.startExportStlPack,
}));

vi.mock("../../api/endpoints/browserFiles", () => ({
  engineAssetUrl: (path: string) => `http://engine.test${path}`,
}));

vi.mock("../../hooks/useJobRunner", () => ({
  useJobRunner: () => ({
    busy: false,
    isBusyForSource: () => false,
    message: "",
    runJob: api.runJob,
  }),
}));

const TOKENS = [`ppu_${"a".repeat(32)}`, `ppu_${"b".repeat(32)}`];

function snapshot(overrides: Partial<JobSnapshot>): JobSnapshot {
  return {
    job_id: "stl-job",
    kind: "export-stl-pack",
    status: "done",
    message: "Complete",
    progress: 1,
    result: null,
    error: null,
    ...overrides,
  };
}

/**
 * Stand in for the job runner the way `JobContext` behaves: it awaits the start,
 * hands the terminal snapshot to `onDone`, and swallows a start that threw
 * because it reports that through the job strip instead.
 */
function runJobLike(next: JobSnapshot | null) {
  return async (
    start: () => Promise<string>,
    onDone?: (value: JobSnapshot) => void,
  ) => {
    try {
      await start();
    } catch {
      return;
    }
    if (next) onDone?.(next);
  };
}

function renderPanel(overrides?: { selectedTokens?: readonly string[] }) {
  const onOpenUnitSelection = vi.fn();
  render(
    <StlRoutePanel
      profileId={7}
      selectedTokens={overrides?.selectedTokens ?? TOKENS}
      totalUnitCount={40}
      onOpenUnitSelection={onOpenUnitSelection}
    />,
  );
  return { onOpenUnitSelection };
}

describe("StlRoutePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.startExportStlPack.mockResolvedValue("stl-job");
    api.runJob.mockImplementation(
      runJobLike(
        snapshot({
          result: {
            download_url: "/exports/accepted-stl.zip",
            root_path: "/data/exports/content-abc",
            file_total: 12,
            warnings: [],
          },
        }),
      ),
    );
  });

  afterEach(cleanup);

  it("says how many Required units the download covers and routes back to the selection", () => {
    const { onOpenUnitSelection } = renderPanel();

    expect(screen.getByText(/Required units\./).textContent).toContain("2 of 40");

    fireEvent.click(screen.getByRole("button", { name: "Change which Required units" }));
    expect(onOpenUnitSelection).toHaveBeenCalledTimes(1);
  });

  it("is honest that an empty choice means the whole work package", () => {
    renderPanel({ selectedTokens: [] });

    expect(
      screen.getByText(/No Required units are chosen/).textContent,
    ).toContain("all 40 Required units");
  });

  it("runs the export with the chosen units and offers the finished files", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Download the unit files/ }));

    await waitFor(() => {
      expect(api.startExportStlPack).toHaveBeenCalledWith(7, {
        missing_only: false,
        group_by: "color_dir",
        unit_tokens: TOKENS,
      });
    });

    const save = await screen.findByRole("link", { name: /Save the files/ });
    expect(save.getAttribute("href")).toBe("http://engine.test/exports/accepted-stl.zip");
    expect(save.hasAttribute("download")).toBe(true);
    expect(screen.getByText("12 files ready")).toBeTruthy();
  });

  it("sends the arrangement and the unit scope the operator picked", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /Only the ones still to print/ }));
    fireEvent.click(screen.getByRole("radio", { name: /By color only/ }));
    fireEvent.click(screen.getByRole("button", { name: /Download the unit files/ }));

    await waitFor(() => {
      expect(api.startExportStlPack).toHaveBeenCalledWith(7, {
        missing_only: true,
        group_by: "color",
        unit_tokens: TOKENS,
      });
    });
  });

  it("reports progress in a live region while the export runs", async () => {
    // A start that never settles leaves the panel in its running state.
    api.startExportStlPack.mockReturnValue(new Promise<string>(() => {}));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Download the unit files/ }));

    const progress = await screen.findByRole("status");
    expect(progress.textContent).toContain("Collecting the unit files");
  });

  it("keeps a failed export on screen with a Retry that keeps the operator's choices", async () => {
    api.runJob.mockImplementation(
      runJobLike(snapshot({ status: "error", error: "A verified accepted STL is unavailable." })),
    );
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /By color only/ }));
    fireEvent.click(screen.getByRole("button", { name: /Download the unit files/ }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not download the unit files");
    expect(alert.textContent).toContain("A verified accepted STL is unavailable.");
    expect(screen.queryByRole("link", { name: /Save the files/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(api.startExportStlPack).toHaveBeenCalledTimes(2));
    expect(api.startExportStlPack.mock.calls[1][1]).toEqual({
      missing_only: false,
      group_by: "color",
      unit_tokens: TOKENS,
    });
  });

  it("treats an export that produced nothing as a failure, not a download", async () => {
    api.runJob.mockImplementation(
      runJobLike(
        snapshot({
          result: {
            download_url: null,
            root_path: "/data/exports/empty",
            file_total: 0,
            warnings: ["A verified accepted STL is unavailable: bracket.stl (Frame)."],
          },
        }),
      ),
    );
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Download the unit files/ }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("bracket.stl (Frame)");
    expect(screen.queryByRole("link", { name: /Save the files/ })).toBeNull();
  });

  it("keeps a failed start on screen instead of waiting forever", async () => {
    api.startExportStlPack.mockRejectedValue(new Error("Profile not found"));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Download the unit files/ }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Profile not found");
  });

  it("falls back to the server path when the job published no bundle", async () => {
    api.runJob.mockImplementation(
      runJobLike(
        snapshot({
          result: {
            download_url: null,
            root_path: "/data/exports/content-abc",
            file_total: 3,
            warnings: [],
          },
        }),
      ),
    );
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Download the unit files/ }));

    expect(await screen.findByText(/on the PrintPartner server/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Save the files/ })).toBeNull();
  });

  it("says plainly that handing over files leaves the units unverified", () => {
    renderPanel();

    const note = screen.getByText(/stay unverified in Checkoff/);
    expect(note.textContent).toContain("Record a print made elsewhere");
  });
});
