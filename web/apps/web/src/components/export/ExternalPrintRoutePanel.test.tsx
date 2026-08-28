// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UNMANAGED_PRINTER_ID,
  UNMANAGED_PRINTER_NAME,
  type PrinterStorageListing,
} from "@print-partner/contracts";
import ExternalPrintRoutePanel from "./ExternalPrintRoutePanel";
import { build, host, printer } from "../printers/testFixtures";

const api = vi.hoisted(() => ({
  fetchPrinters: vi.fn(),
  fetchIntegrations: vi.fn(),
  fetchPrinterCapabilities: vi.fn(),
  fetchPrinterStorageListing: vi.fn(),
  openPrinterStoredFile: vi.fn(),
  parseSlicedObjectsFile: vi.fn(),
  uploadPrintFileForAssignment: vi.fn(),
  assignUploadedPrinterFile: vi.fn(),
  verifyPrinterCheckoff: vi.fn(),
  previewPrinterFileAssignment: vi.fn(),
  assignPrinterFile: vi.fn(),
}));

vi.mock("../../api/endpoints/printers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/endpoints/printers")>()),
  fetchPrinters: api.fetchPrinters,
  fetchPrinterCapabilities: api.fetchPrinterCapabilities,
  fetchPrinterStorageListing: api.fetchPrinterStorageListing,
  openPrinterStoredFile: api.openPrinterStoredFile,
  printerStoredFileUrl: () => "/stored-file",
}));

vi.mock("../../api/endpoints/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/endpoints/integrations")>()),
  fetchIntegrations: api.fetchIntegrations,
}));

vi.mock("../../api/endpoints/checkoff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/endpoints/checkoff")>()),
  uploadPrintFileForAssignment: api.uploadPrintFileForAssignment,
  assignUploadedPrinterFile: api.assignUploadedPrinterFile,
  verifyPrinterCheckoff: api.verifyPrinterCheckoff,
  previewPrinterFileAssignment: api.previewPrinterFileAssignment,
  assignPrinterFile: api.assignPrinterFile,
}));

vi.mock("../../lib/parseSlicedObjects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/parseSlicedObjects")>()),
  parseSlicedObjectsFile: api.parseSlicedObjectsFile,
}));

vi.mock("../../context/ProfileContext", () => ({
  useProfileSelection: () => ({ profiles: [build], selectedProfileId: build.id }),
}));

const sdCard = { ...printer, id: "sd-card", name: "SD Card Printer", integration_id: null };

const STORAGE: PrinterStorageListing = {
  path: "",
  entries: [
    {
      kind: "file",
      path: "bracket.bgcode",
      name: "bracket.bgcode",
      size_bytes: 2048,
      modified_at: "2026-08-27T10:00:00.000Z",
    },
  ],
};

const CHECK = {
  inspected: true,
  classification: { format: "bgcode" },
  print_ready: true,
  suggested_units: [{ part_id: 41, unit_index: 0, object_name: "bracket.stl" }],
  suggestion_basis: "object_names",
  unlabeled_names: [],
  plan_revision_id: 9,
  upload_token: "upload-one",
};

function renderPanel() {
  const onRecorded = vi.fn();
  render(
    <MemoryRouter>
      <ExternalPrintRoutePanel profileId={build.id} onRecorded={onRecorded} />
    </MemoryRouter>,
  );
  return { onRecorded };
}

/**
 * Hand a file to the hidden picker the way a browser does.
 *
 * The picker only exists once the printer roster has loaded, because the roster
 * fills the printer answer, so this waits for it rather than racing it.
 */
async function pickFile(name = "bracket.bgcode") {
  const input = await screen.findByLabelText("Print file to upload");
  fireEvent.change(input, { target: { files: [new File(["binary"], name)] } });
}

/** Answer "which printer made this print?" with a fleet id or the unmanaged one. */
function answerPrinter(value: string) {
  fireEvent.change(screen.getByLabelText("Which printer made this print?"), { target: { value } });
}

/** Answer "have you checked the parts?". */
function answerChecked(answer: "checked" | "not_checked") {
  fireEvent.click(
    screen.getByRole("radio", {
      name: answer === "checked" ? /Printed and checked/ : /Printed, not checked yet/,
    }),
  );
}

describe("ExternalPrintRoutePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchPrinters.mockResolvedValue([printer, sdCard]);
    api.fetchIntegrations.mockResolvedValue([host]);
    api.fetchPrinterCapabilities.mockResolvedValue({ files: true, cameras: true });
    api.fetchPrinterStorageListing.mockResolvedValue(STORAGE);
    api.parseSlicedObjectsFile.mockResolvedValue({
      objects: [{ name: "bracket.stl", source: "comment" }],
      names: ["bracket.stl"],
      format: "bgcode",
      unlabeled: false,
    });
    api.uploadPrintFileForAssignment.mockResolvedValue(CHECK);
    api.assignUploadedPrinterFile.mockResolvedValue({
      link: {
        id: "link-one",
        filename: "bracket.bgcode",
        units: [{ part_id: 41, unit_index: 0 }],
      },
    });
    api.verifyPrinterCheckoff.mockResolvedValue({
      link: { id: "link-one", state: "verified" },
      units_confirmed: 1,
      units_rejected: 0,
      outcomes: [],
    });
  });

  afterEach(cleanup);

  it("asks where the file is without answering for the operator", async () => {
    renderPanel();

    expect(screen.getByText(/This records a print that already happened/)).toBeTruthy();
    for (const label of [/On a printer PrintPartner watches/, /On this computer/]) {
      expect(screen.getByRole("radio", { name: label, checked: false })).toBeTruthy();
    }
    await waitFor(() => expect(api.fetchPrinters).toHaveBeenCalled());
    // Nothing below the question until it is answered.
    expect(screen.queryByLabelText("Print file to upload")).toBeNull();
    expect(screen.queryByLabelText("Which printer made this print?")).toBeNull();
  });

  it("reaches the printer's own storage through the shared files view", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /On a printer PrintPartner watches/ }));
    fireEvent.change(await screen.findByLabelText("Which printer made this print?"), {
      target: { value: printer.id },
    });

    expect(await screen.findByText("bracket.bgcode")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    // Only linked printers can be browsed, so the unlinked one is not offered here.
    expect(screen.queryByRole("option", { name: "SD Card Printer" })).toBeNull();
  });

  it("sends the operator to the upload when a printer serves no files", async () => {
    api.fetchPrinterCapabilities.mockResolvedValue({ files: false, cameras: false });
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /On a printer PrintPartner watches/ }));
    fireEvent.change(await screen.findByLabelText("Which printer made this print?"), {
      target: { value: printer.id },
    });

    expect(await screen.findByText(/does not serve its stored files to PrintPartner/)).toBeTruthy();
  });

  it("checks the confirmed units off when the operator has already checked the parts", async () => {
    const { onRecorded } = renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /On this computer/ }));
    await pickFile();

    await waitFor(() => {
      expect(api.uploadPrintFileForAssignment).toHaveBeenCalledWith({
        profile_id: 7,
        file: expect.any(File),
        object_names: ["bracket.stl"],
      });
    });

    // The server's classification, in the operator's words.
    expect(await screen.findByText("Sliced binary G-code")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /bracket.stl/, checked: true })).toBeTruthy();

    answerPrinter("sd-card");
    answerChecked("checked");
    fireEvent.click(screen.getByRole("button", { name: "Record this print" }));

    await waitFor(() => {
      expect(api.assignUploadedPrinterFile).toHaveBeenCalledWith({
        profile_id: 7,
        printer_id: "sd-card",
        filename: "bracket.bgcode",
        upload_token: "upload-one",
        object_names: ["bracket.stl"],
        tracking: "manual",
        completed: true,
        plan_revision_id: 9,
        unit_tokens: ["41:0"],
      });
    });

    // The units are checked off through the one verify path, as confirmed.
    await waitFor(() => {
      expect(api.verifyPrinterCheckoff).toHaveBeenCalledWith({
        link_id: "link-one",
        decisions: [{ part_id: 41, unit_index: 0, result: "confirmed" }],
      });
    });
    expect(onRecorded).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(/bracket.bgcode is on the record and 1 Required unit is checked off/),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "See the units in Checkoff" }).getAttribute("href")).toBe(
      "/progress?profile=7",
    );
  });

  it("leaves the units for Checkoff when the parts are not checked yet", async () => {
    const { onRecorded } = renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /On this computer/ }));
    await pickFile();

    await screen.findByText("Sliced binary G-code");
    answerPrinter("sd-card");
    answerChecked("not_checked");
    fireEvent.click(screen.getByRole("button", { name: "Record this print" }));

    await waitFor(() => expect(api.assignUploadedPrinterFile).toHaveBeenCalledTimes(1));
    // Verify-first stands: nothing was checked off on the operator's behalf.
    expect(api.verifyPrinterCheckoff).not.toHaveBeenCalled();
    expect(onRecorded).toHaveBeenCalledTimes(1);

    expect(
      await screen.findByText(/bracket.bgcode is on the record, covering 1 Required unit/),
    ).toBeTruthy();
    expect(screen.getByText(/The units are not checked off yet/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Finish the units in Checkoff" })).toBeTruthy();
  });

  it("records against a printer PrintPartner does not manage without naming one", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /On this computer/ }));
    await pickFile();

    await screen.findByText("Sliced binary G-code");
    answerPrinter(UNMANAGED_PRINTER_ID);
    answerChecked("checked");
    fireEvent.click(screen.getByRole("button", { name: "Record this print" }));

    await waitFor(() => expect(api.assignUploadedPrinterFile).toHaveBeenCalledTimes(1));
    const [body] = api.assignUploadedPrinterFile.mock.calls[0];
    // No printer id at all, rather than the literal id, which the server resolves
    // in the fleet and would refuse.
    expect("printer_id" in body).toBe(false);
    expect(body).toMatchObject({ profile_id: 7, tracking: "manual", unit_tokens: ["41:0"] });
    await waitFor(() => expect(api.verifyPrinterCheckoff).toHaveBeenCalledTimes(1));
  });

  it("records an uploaded print when the fleet is empty", async () => {
    api.fetchPrinters.mockResolvedValue([]);
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /On this computer/ }));
    await pickFile();

    expect(await screen.findByText("Sliced binary G-code")).toBeTruthy();
    // No dead end telling the operator to go and register hardware first.
    expect(screen.queryByText(/has no printers yet/)).toBeNull();
    expect(screen.getByRole("option", { name: UNMANAGED_PRINTER_NAME })).toBeTruthy();

    answerPrinter(UNMANAGED_PRINTER_ID);
    answerChecked("checked");
    fireEvent.click(screen.getByRole("button", { name: "Record this print" }));

    await waitFor(() => expect(api.verifyPrinterCheckoff).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/1 Required unit is checked off/)).toBeTruthy();
  });

  it("says both facts and reruns only the check-off when the units fail to check off", async () => {
    api.verifyPrinterCheckoff.mockRejectedValueOnce(
      new Error("Confirm must include lower incomplete units first"),
    );
    const { onRecorded } = renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /On this computer/ }));
    await pickFile();

    await screen.findByText("Sliced binary G-code");
    answerPrinter("sd-card");
    answerChecked("checked");
    fireEvent.click(screen.getByRole("button", { name: "Record this print" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "bracket.bgcode is on the record, and its units are not checked off",
    );
    expect(alert.textContent).toContain("Confirm must include lower incomplete units first");
    expect(alert.textContent).toContain("1 Required unit is still waiting to be checked");
    // The print is on the record, so the work package hears about it either way.
    expect(onRecorded).toHaveBeenCalledTimes(1);
    // Nothing claims the units are checked off, and nothing offers to record twice.
    expect(screen.queryByText(/is checked off/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Record this print" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Check the units off again" }));

    await waitFor(() => expect(api.verifyPrinterCheckoff).toHaveBeenCalledTimes(2));
    // Only the check-off reran. The print was never recorded a second time.
    expect(api.assignUploadedPrinterFile).toHaveBeenCalledTimes(1);
    expect(api.verifyPrinterCheckoff.mock.calls[1][0]).toEqual({
      link_id: "link-one",
      decisions: [{ part_id: 41, unit_index: 0, result: "confirmed" }],
    });
    expect(await screen.findByText(/1 Required unit is checked off/)).toBeTruthy();
  });

  it("lets a failed check-off be left for Checkoff without claiming it is done", async () => {
    api.verifyPrinterCheckoff.mockRejectedValue(new Error("Accepted Plan changed; reload and retry"));
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /On this computer/ }));
    await pickFile();

    await screen.findByText("Sliced binary G-code");
    answerPrinter("sd-card");
    answerChecked("checked");
    fireEvent.click(screen.getByRole("button", { name: "Record this print" }));

    fireEvent.click(await screen.findByRole("button", { name: "Leave the units for Checkoff" }));

    expect(
      await screen.findByText(/bracket.bgcode is on the record, covering 1 Required unit/),
    ).toBeTruthy();
    expect(screen.getByText(/The units are not checked off yet/)).toBeTruthy();
  });

  it("sends only the units the operator left confirmed", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /On this computer/ }));
    await pickFile();

    fireEvent.click(await screen.findByRole("checkbox", { name: /bracket.stl/ }));
    answerPrinter("sd-card");
    answerChecked("checked");
    fireEvent.click(screen.getByRole("button", { name: "Record this print" }));

    // A finished print with no units has nothing to check off, so it is refused.
    const summary = await screen.findByRole("alert");
    expect(summary.textContent).toContain("Confirm at least one Required unit");
    expect(api.assignUploadedPrinterFile).not.toHaveBeenCalled();
  });

  it("will not record a print until the printer and the check are both answered", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /On this computer/ }));
    await pickFile();

    fireEvent.click(await screen.findByRole("button", { name: "Record this print" }));

    const summary = await screen.findByRole("alert");
    expect(summary.textContent).toContain("2 decisions still need your answer");
    expect(summary.textContent).toContain("Say which printer made this print");
    expect(summary.textContent).toContain("Say whether you have checked the parts");
    expect(api.assignUploadedPrinterFile).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText("Which printer made this print?").getAttribute("aria-invalid"),
    ).toBe("true");
  });

  it("keeps a failed upload on screen with a Retry that does not ask for the file again", async () => {
    api.uploadPrintFileForAssignment.mockRejectedValueOnce(new Error("Upload store is full"));
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /On this computer/ }));
    await pickFile();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not upload bracket.bgcode");
    expect(alert.textContent).toContain("Upload store is full");

    fireEvent.click(screen.getByRole("button", { name: "Upload again" }));

    expect(await screen.findByText("Sliced binary G-code")).toBeTruthy();
    await waitFor(() => expect(api.uploadPrintFileForAssignment).toHaveBeenCalledTimes(2));
    // The bytes were already read once, so the operator is not sent back to the picker.
    expect(api.parseSlicedObjectsFile).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed record on screen with a Retry that keeps the operator's answers", async () => {
    api.assignUploadedPrinterFile.mockRejectedValueOnce(new Error("Plan revision moved on"));
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /On this computer/ }));
    await pickFile();

    await screen.findByText("Sliced binary G-code");
    answerPrinter("sd-card");
    answerChecked("checked");
    fireEvent.click(screen.getByRole("button", { name: "Record this print" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Plan revision moved on");
    // Nothing was checked off, because nothing was recorded.
    expect(api.verifyPrinterCheckoff).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Record again" }));

    await waitFor(() => expect(api.assignUploadedPrinterFile).toHaveBeenCalledTimes(2));
    expect(api.assignUploadedPrinterFile.mock.calls[1][0]).toMatchObject({
      printer_id: "sd-card",
      unit_tokens: ["41:0"],
      plan_revision_id: 9,
    });
    expect(await screen.findByText(/1 Required unit is checked off/)).toBeTruthy();
  });

  it("will not record a 3MF the server says still needs slicing", async () => {
    api.uploadPrintFileForAssignment.mockResolvedValue({
      ...CHECK,
      classification: { format: "3mf", kind: "slicer_project" },
      print_ready: false,
      suggested_units: [],
      suggestion_basis: "none",
    });
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /On this computer/ }));
    await pickFile("chassis.3mf");

    expect(await screen.findByText("Needs slicing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Record this print" })).toBeNull();
    expect(screen.getByRole("button", { name: /Choose a different file/ })).toBeTruthy();
  });

  it("refuses a file that is not a print file before it uploads anything", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /On this computer/ }));
    await pickFile("notes.txt");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("notes.txt is not a print file");
    expect(api.uploadPrintFileForAssignment).not.toHaveBeenCalled();
  });

  it("points an empty fleet at the upload when the operator wants printer storage", async () => {
    api.fetchPrinters.mockResolvedValue([]);
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /On a printer PrintPartner watches/ }));

    expect(
      await screen.findByText(/PrintPartner has no printers yet, so there is no storage to browse/),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "add the printer in settings" })).toBeTruthy();
  });

  it("keeps a failed printer load on screen with a Retry", async () => {
    api.fetchPrinters.mockRejectedValueOnce(new Error("Engine is offline"));
    renderPanel();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load your printers");
    expect(alert.textContent).toContain("Engine is offline");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    fireEvent.click(screen.getByRole("radio", { name: /On this computer/ }));
    expect(await screen.findByLabelText("Print file to upload")).toBeTruthy();
  });
});
