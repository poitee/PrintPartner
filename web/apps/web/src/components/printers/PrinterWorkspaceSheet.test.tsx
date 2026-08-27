// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileSummary } from "@print-partner/contracts";
import PrinterWorkspaceSheet from "./PrinterWorkspaceSheet";

const api = vi.hoisted(() => ({
  fetchPrinterStoredFiles: vi.fn(),
  openPrinterStoredFile: vi.fn(),
  fetchPrinterCameras: vi.fn(),
  assignPrinterFile: vi.fn(),
  completeManualPrinterFile: vi.fn(),
  parseSlicedObjectsFile: vi.fn(),
}));

vi.mock("../../api/endpoints/printers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/endpoints/printers")>()),
  fetchPrinterStoredFiles: api.fetchPrinterStoredFiles,
  openPrinterStoredFile: api.openPrinterStoredFile,
  fetchPrinterCameras: api.fetchPrinterCameras,
  printerCameraViewUrl: () => "/camera-view",
}));

vi.mock("../../api/endpoints/checkoff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/endpoints/checkoff")>()),
  assignPrinterFile: api.assignPrinterFile,
  completeManualPrinterFile: api.completeManualPrinterFile,
}));

vi.mock("../../lib/parseSlicedObjects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/parseSlicedObjects")>()),
  parseSlicedObjectsFile: api.parseSlicedObjectsFile,
}));

const build = {
  id: 7,
  name: "Enclosure Build",
  order_number: null,
  special_request: null,
  part_count: 1,
  accepted_progress: { kind: "ready", total_units: 1, remaining_units: 1 },
  build_stale: false,
  freshness: {
    status: "current",
    accepted_input_set_id: 11,
    accepted_at: "2026-08-27T00:00:00.000Z",
  },
  archived_at: null,
  last_used_at: null,
} satisfies ProfileSummary;

const printer = {
  id: "voron-one",
  name: "Voron One",
  model: "voron-250",
  bed_width_mm: 250,
  bed_depth_mm: 250,
  bed_height_mm: 250,
  margin_mm: 4,
  max_filament_slots: 1,
  loaded_filaments: [{ slot: 1, filament_color_id: null, label: "" }],
  integration_id: "moonraker-one",
};

const host = {
  id: "moonraker-one",
  type: "moonraker" as const,
  name: "Voron host",
  config: { base_url: "http://voron.local" },
  created_at: "2026-08-27T00:00:00.000Z",
  updated_at: "2026-08-27T00:00:00.000Z",
};

describe("PrinterWorkspaceSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchPrinterStoredFiles.mockResolvedValue([{
      id: "jobs/bracket.bgcode",
      path: "jobs/bracket.bgcode",
      filename: "bracket.bgcode",
      size_bytes: 2048,
    }]);
    api.fetchPrinterCameras.mockResolvedValue([]);
    api.openPrinterStoredFile.mockResolvedValue(new File(["binary"], "bracket.bgcode"));
    api.parseSlicedObjectsFile.mockResolvedValue({
      objects: [{ name: "bracket.stl", source: "comment" }],
      names: ["bracket.stl"],
      format: "bgcode",
      unlabeled: false,
    });
    api.assignPrinterFile.mockResolvedValue({
      link: { id: "link-one", units: [{ part_id: 1, unit_index: 0 }] },
    });
  });

  afterEach(cleanup);

  it("opens a stored printer file and assigns it to the selected Build", async () => {
    render(
      <PrinterWorkspaceSheet
        open
        onOpenChange={vi.fn()}
        printer={printer}
        host={host}
        profiles={[build]}
        selectedProfileId={build.id}
        links={[]}
        onChanged={vi.fn()}
      />,
    );

    expect(await screen.findByText("bracket.bgcode")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(await screen.findByText("1 object label found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Assign print file" }));

    await waitFor(() => {
      expect(api.assignPrinterFile).toHaveBeenCalledWith({
        profile_id: 7,
        printer_id: "voron-one",
        filename: "bracket.bgcode",
        remote_path: "jobs/bracket.bgcode",
        object_names: ["bracket.stl"],
        tracking: "host",
        completed: false,
      });
    });
  });
});
