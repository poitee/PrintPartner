// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrinterStorageListing, ProfileSummary } from "@print-partner/contracts";
import PrinterFilesView from "./PrinterFilesView";
import { build, host, printer } from "./testFixtures";

const api = vi.hoisted(() => ({
  fetchPrinterStorageListing: vi.fn(),
  openPrinterStoredFile: vi.fn(),
  previewPrinterFileAssignment: vi.fn(),
  assignPrinterFile: vi.fn(),
  parseSlicedObjectsFile: vi.fn(),
}));

vi.mock("../../api/endpoints/printers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/endpoints/printers")>()),
  fetchPrinterStorageListing: api.fetchPrinterStorageListing,
  openPrinterStoredFile: api.openPrinterStoredFile,
  printerStoredFileUrl: () => "/stored-file",
}));

vi.mock("../../api/endpoints/checkoff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/endpoints/checkoff")>()),
  previewPrinterFileAssignment: api.previewPrinterFileAssignment,
  assignPrinterFile: api.assignPrinterFile,
}));

vi.mock("../../lib/parseSlicedObjects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/parseSlicedObjects")>()),
  parseSlicedObjectsFile: api.parseSlicedObjectsFile,
}));

const ROOT: PrinterStorageListing = {
  path: "",
  entries: [
    { kind: "directory", path: "jobs", name: "jobs" },
    {
      kind: "file",
      path: "loose.gcode",
      name: "loose.gcode",
      size_bytes: 1024,
      modified_at: "2026-08-20T10:00:00.000Z",
    },
  ],
};

const JOBS: PrinterStorageListing = {
  path: "jobs",
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

function renderView(overrides?: { canBrowse?: boolean; profiles?: ProfileSummary[] }) {
  const onAssigned = vi.fn();
  render(
    <PrinterFilesView
      printer={printer}
      host={host}
      canBrowse={overrides?.canBrowse ?? true}
      profiles={overrides?.profiles ?? [build]}
      selectedProfileId={build.id}
      onAssigned={onAssigned}
    />,
  );
  return { onAssigned };
}

describe("PrinterFilesView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchPrinterStorageListing.mockImplementation(
      ({ path }: { printerId: string; path: string }) => Promise.resolve(path === "jobs" ? JOBS : ROOT),
    );
    api.openPrinterStoredFile.mockResolvedValue(new File(["binary"], "bracket.bgcode"));
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
      link: { id: "link-one", filename: "bracket.bgcode", units: [{ part_id: 41, unit_index: 0 }] },
    });
  });

  afterEach(cleanup);

  it("walks into a folder and back out to the root", async () => {
    renderView();

    expect(await screen.findByRole("button", { name: "jobs" })).toBeTruthy();
    // Root shows the loose file, not the one inside jobs/.
    expect(screen.getByText("loose.gcode")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "jobs" }));

    expect(await screen.findByText("bracket.bgcode")).toBeTruthy();
    expect(screen.queryByText("loose.gcode")).toBeNull();
    // The trail marks where the operator is.
    expect(screen.getByText("jobs").getAttribute("aria-current")).toBe("location");

    fireEvent.click(screen.getByRole("button", { name: "Printer storage" }));

    expect(await screen.findByText("loose.gcode")).toBeTruthy();
    expect(screen.queryByText("bracket.bgcode")).toBeNull();
  });

  it("searches the current folder and sorts files using printer metadata", async () => {
    api.fetchPrinterStorageListing.mockResolvedValue({
      path: "",
      entries: [
        { kind: "file", path: "small.gcode", name: "small.gcode", size_bytes: 10, modified_at: "2026-08-20T10:00:00.000Z" },
        { kind: "file", path: "large.gcode", name: "large.gcode", size_bytes: 500, modified_at: "2026-08-19T10:00:00.000Z" },
        { kind: "directory", path: "archive", name: "archive" },
      ],
    });
    renderView();

    const search = await screen.findByPlaceholderText("Search this folder…");
    fireEvent.change(search, { target: { value: "large" } });
    expect(screen.getByText("large.gcode")).toBeTruthy();
    expect(screen.queryByText("small.gcode")).toBeNull();
    expect(screen.getByText("1 file · 0 folders")).toBeTruthy();

    fireEvent.change(search, { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "largest" } });
    expect(screen.getAllByText(/\.gcode$/).map((node) => node.textContent)).toEqual([
      "large.gcode",
      "small.gcode",
    ]);
  });

  it("keeps a failed listing on screen with a Retry that reruns it", async () => {
    api.fetchPrinterStorageListing.mockRejectedValueOnce(new Error("Host refused the connection"));
    renderView();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not list files on Voron One");
    expect(alert.textContent).toContain("Host refused the connection");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("button", { name: "jobs" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a failed file open on screen with a Retry that reruns it", async () => {
    api.openPrinterStoredFile.mockRejectedValueOnce(new Error("404 from the host"));
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "jobs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not open bracket.bgcode");
    expect(alert.textContent).toContain("404 from the host");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText(/1 object label read from the file/)).toBeTruthy();
  });

  it("checks the file before it will assign anything", async () => {
    const { onAssigned } = renderView();

    fireEvent.click(await screen.findByRole("button", { name: "jobs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    // Step one writes nothing, and there is no way to assign yet.
    const check = await screen.findByRole("button", { name: "Check this file" });
    expect(screen.queryByRole("button", { name: "Assign print file" })).toBeNull();

    fireEvent.click(check);

    await waitFor(() => {
      expect(api.previewPrinterFileAssignment).toHaveBeenCalledWith({
        profile_id: 7,
        printer_id: "voron-one",
        filename: "bracket.bgcode",
        remote_path: "jobs/bracket.bgcode",
        object_names: ["bracket.stl"],
      });
    });
    expect(api.assignPrinterFile).not.toHaveBeenCalled();

    // The server's classification, in the operator's words.
    expect(await screen.findByText("Sliced binary G-code")).toBeTruthy();
    // The suggested unit arrives already confirmed, ready to be unticked.
    expect(screen.getByRole("checkbox", { name: /bracket.stl/, checked: true })).toBeTruthy();

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
        plan_revision_id: 9,
        unit_tokens: ["41:0"],
      });
    });
    expect(onAssigned).toHaveBeenCalled();
  });

  it("sends only the units the operator left confirmed", async () => {
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "jobs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check this file" }));

    const unit = await screen.findByRole("checkbox", { name: /bracket.stl/ });
    fireEvent.click(unit);
    fireEvent.click(screen.getByRole("button", { name: "Assign print file" }));

    await waitFor(() => {
      expect(api.assignPrinterFile).toHaveBeenCalledWith(
        expect.objectContaining({ unit_tokens: [] }),
      );
    });
  });

  it("summarises the form's problems instead of a toast", async () => {
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "jobs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    fireEvent.change(await screen.findByLabelText("Assign to Build"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check this file" }));

    const summary = await screen.findByRole("alert");
    expect(summary.textContent).toContain("1 decision still needs your answer");
    expect(summary.textContent).toContain("Choose the Build this print belongs to");
    // The message also sits on the field itself.
    const select = screen.getByLabelText("Assign to Build");
    expect(select.getAttribute("aria-invalid")).toBe("true");
    const describedBy = select.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? "")?.textContent).toContain(
      "Choose the Build this print belongs to",
    );
    expect(api.previewPrinterFileAssignment).not.toHaveBeenCalled();
  });

  it("keeps a failed assignment on screen with a Retry that keeps the operator's choices", async () => {
    api.assignPrinterFile.mockRejectedValueOnce(new Error("Plan revision moved on"));
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "jobs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check this file" }));

    fireEvent.click(await screen.findByLabelText(/This print is already finished/));
    fireEvent.click(screen.getByRole("button", { name: "Assign and send to Checkoff" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Plan revision moved on");

    fireEvent.click(screen.getByRole("button", { name: "Assign again" }));

    await waitFor(() => expect(api.assignPrinterFile).toHaveBeenCalledTimes(2));
    // The retry reruns with the choices intact, including "already finished".
    expect(api.assignPrinterFile.mock.calls[1][0]).toMatchObject({
      completed: true,
      unit_tokens: ["41:0"],
      plan_revision_id: 9,
    });
  });

  it("will not assign a 3MF the server says still needs slicing", async () => {
    api.previewPrinterFileAssignment.mockResolvedValue({
      inspected: true,
      classification: { format: "3mf", kind: "slicer_project" },
      print_ready: false,
      suggested_units: [],
      suggestion_basis: "none",
      unlabeled_names: [],
      plan_revision_id: 9,
    });
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "jobs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check this file" }));

    expect(await screen.findByText("Needs slicing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Assign print file" })).toBeNull();
    // No checkbox asks the operator to promise the file is print-ready.
    expect(screen.queryByLabelText(/already sliced/i)).toBeNull();
    expect(screen.getByRole("link", { name: /Download a copy/ }).getAttribute("href")).toBe(
      "/stored-file",
    );
  });

  it("will not assign a 3MF whose bytes PrintPartner never read", async () => {
    api.fetchPrinterStorageListing.mockResolvedValue({
      path: "jobs",
      entries: [
        { kind: "file", path: "jobs/chassis.3mf", name: "chassis.3mf", size_bytes: 4096 },
      ],
    });
    api.openPrinterStoredFile.mockResolvedValue(new File(["zip"], "chassis.3mf"));
    api.previewPrinterFileAssignment.mockResolvedValue({
      inspected: false,
      suggested_units: [],
      suggestion_basis: "none",
      unlabeled_names: [],
      plan_revision_id: 9,
    });
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check this file" }));

    expect(await screen.findByText("Not read by PrintPartner")).toBeTruthy();
    expect(screen.getByText(/has to read a 3MF/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Assign print file" })).toBeNull();
  });

  it("still records an unread G-code, so an unmonitored printer keeps a paper trail", async () => {
    api.previewPrinterFileAssignment.mockResolvedValue({
      inspected: false,
      suggested_units: [{ part_id: 41, unit_index: 0, object_name: "bracket.stl" }],
      suggestion_basis: "filename",
      unlabeled_names: [],
      plan_revision_id: 9,
    });
    api.fetchPrinterStorageListing.mockResolvedValue({
      path: "jobs",
      entries: [
        { kind: "file", path: "jobs/plate.gcode", name: "plate.gcode", size_bytes: 4096 },
      ],
    });
    api.openPrinterStoredFile.mockResolvedValue(new File(["text"], "plate.gcode"));
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check this file" }));

    expect(await screen.findByText("Not read by PrintPartner")).toBeTruthy();
    expect(screen.getByText(/Mark it finished by hand/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Assign print file" }));

    await waitFor(() =>
      expect(api.assignPrinterFile).toHaveBeenCalledWith(
        expect.objectContaining({ unit_tokens: ["41:0"], plan_revision_id: 9 }),
      ),
    );
  });

  it("turns a reply it cannot read into a retryable failure, not a crash", async () => {
    api.previewPrinterFileAssignment.mockRejectedValueOnce(
      new Error("The server answered the print file check in a shape this app cannot read."),
    );
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "jobs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check this file" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not check bracket.bgcode");
    expect(alert.textContent).toContain("shape this app cannot read");

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByText("Sliced binary G-code")).toBeTruthy();
  });

  it("offers only the computer when the host cannot list files", async () => {
    renderView({ canBrowse: false });

    expect(await screen.findByRole("button", { name: /Choose a print file/ })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Where is the file?" })).toBeNull();
    expect(api.fetchPrinterStorageListing).not.toHaveBeenCalled();
  });
});
