// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrinterStorageListing } from "@print-partner/contracts";
import type { PrinterCheckoffLink } from "../../api/endpoints/checkoff";
import PrinterWorkspaceSheet from "./PrinterWorkspaceSheet";
import { build, host, printer } from "./testFixtures";

const api = vi.hoisted(() => ({
  fetchPrinterCapabilities: vi.fn(),
  fetchPrinterStorageListing: vi.fn(),
  openPrinterStoredFile: vi.fn(),
  fetchPrinterCameras: vi.fn(),
  previewPrinterFileAssignment: vi.fn(),
  assignPrinterFile: vi.fn(),
  completeManualPrinterFile: vi.fn(),
  parseSlicedObjectsFile: vi.fn(),
}));

vi.mock("../../api/endpoints/printers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/endpoints/printers")>()),
  fetchPrinterCapabilities: api.fetchPrinterCapabilities,
  fetchPrinterStorageListing: api.fetchPrinterStorageListing,
  openPrinterStoredFile: api.openPrinterStoredFile,
  fetchPrinterCameras: api.fetchPrinterCameras,
  printerCameraViewUrl: () => "/camera-view",
  printerStoredFileUrl: () => "/stored-file",
}));

vi.mock("../../api/endpoints/checkoff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/endpoints/checkoff")>()),
  previewPrinterFileAssignment: api.previewPrinterFileAssignment,
  assignPrinterFile: api.assignPrinterFile,
  completeManualPrinterFile: api.completeManualPrinterFile,
}));

vi.mock("../../lib/parseSlicedObjects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/parseSlicedObjects")>()),
  parseSlicedObjectsFile: api.parseSlicedObjectsFile,
}));

const LISTING: PrinterStorageListing = {
  path: "",
  entries: [
    {
      kind: "file",
      path: "jobs/bracket.bgcode",
      name: "bracket.bgcode",
      size_bytes: 2048,
      modified_at: "2026-08-27T10:00:00.000Z",
    },
  ],
};

const manualLink: PrinterCheckoffLink = {
  id: "link-manual",
  profile_id: build.id,
  integration_id: `manual:${printer.id}`,
  printer_id: printer.id,
  host_name: "Manual",
  filename: "bracket.gcode",
  units: [],
  state: "watching",
  saw_active: false,
  created_at: "2026-08-27T00:00:00.000Z",
};

function renderSheet(links: PrinterCheckoffLink[] = []) {
  const onChanged = vi.fn();
  render(
    <PrinterWorkspaceSheet
      open
      onOpenChange={vi.fn()}
      printer={printer}
      host={host}
      profiles={[build]}
      selectedProfileId={build.id}
      links={links}
      onChanged={onChanged}
    />,
  );
  return { onChanged };
}

describe("PrinterWorkspaceSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchPrinterCapabilities.mockResolvedValue({ files: true, cameras: true });
    api.fetchPrinterStorageListing.mockResolvedValue(LISTING);
    api.openPrinterStoredFile.mockResolvedValue(new File(["binary"], "bracket.bgcode"));
    api.fetchPrinterCameras.mockResolvedValue([]);
    api.parseSlicedObjectsFile.mockResolvedValue({
      objects: [{ name: "bracket.stl", source: "comment" }],
      names: ["bracket.stl"],
      format: "bgcode",
      unlabeled: false,
    });
    api.previewPrinterFileAssignment.mockResolvedValue({
      inspected: true,
      classification: { format: "bgcode" },
      print_ready: true,
      suggested_units: [{ part_id: 41, unit_index: 0, object_name: "bracket.stl" }],
      suggestion_basis: "object_names",
      unlabeled_names: [],
      plan_revision_id: 9,
    });
    api.assignPrinterFile.mockResolvedValue({
      link: {
        ...manualLink,
        id: "link-new",
        filename: "bracket.bgcode",
        units: [{ part_id: 41, unit_index: 0 }],
      },
    });
  });

  afterEach(cleanup);

  it("asks the server what the printer can do rather than matching the host type", async () => {
    renderSheet();

    await waitFor(() => expect(api.fetchPrinterCapabilities).toHaveBeenCalledWith("voron-one"));
    expect(await screen.findByText("bracket.bgcode")).toBeTruthy();
  });

  it("hides browsing and cameras when the server says the host serves neither", async () => {
    api.fetchPrinterCapabilities.mockResolvedValue({ files: false, cameras: false });
    renderSheet();

    expect(await screen.findByRole("button", { name: /Choose a print file/ })).toBeTruthy();
    expect(api.fetchPrinterStorageListing).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Camera" }));

    expect(await screen.findByText(/does not serve cameras to PrintPartner/)).toBeTruthy();
    expect(api.fetchPrinterCameras).not.toHaveBeenCalled();
  });

  it("keeps a failed capability check on screen with a Retry", async () => {
    api.fetchPrinterCapabilities.mockRejectedValueOnce(new Error("Engine unreachable"));
    renderSheet();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not check what Voron One can do");
    expect(alert.textContent).toContain("Engine unreachable");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("bracket.bgcode")).toBeTruthy();
  });

  it("checks a stored file, then assigns the confirmed mapping and reports it", async () => {
    const { onChanged } = renderSheet();

    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check this file" }));
    fireEvent.click(await screen.findByRole("button", { name: "Assign print file" }));

    await waitFor(() => {
      expect(api.assignPrinterFile).toHaveBeenCalledWith({
        profile_id: 7,
        printer_id: "voron-one",
        filename: "bracket.bgcode",
        remote_path: "jobs/bracket.bgcode",
        object_names: ["bracket.stl"],
        tracking: "host",
        completed: false,
        plan_revision_id: 9,
        unit_tokens: ["41:0"],
      });
    });

    // Success is announced politely where the print now lives, not in a toast.
    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain(
      "bracket.bgcode is assigned, with 1 Required unit linked.",
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("counts the prints only the operator can finish on the Tracked tab", async () => {
    renderSheet([manualLink]);

    expect(await screen.findByRole("tab", { name: "Tracked (1)" })).toBeTruthy();
  });

  it("shows only this printer's tracked prints", async () => {
    renderSheet([manualLink, { ...manualLink, id: "other", printer_id: "other-printer" }]);

    fireEvent.mouseDown(await screen.findByRole("tab", { name: /Tracked/ }));

    expect(await screen.findByText("bracket.gcode")).toBeTruthy();
    expect(screen.getAllByText("bracket.gcode")).toHaveLength(1);
  });
});
