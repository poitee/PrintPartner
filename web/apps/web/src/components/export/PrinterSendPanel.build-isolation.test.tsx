// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { JobSnapshot } from "@print-partner/contracts";
import type { PrinterMachine } from "../../api/endpoints/printers";
import { startBambuConnectHandoff } from "../../api/endpoints/productionSend";
import { parseSlicedObjectsFile, type ParseSlicedObjectsResult } from "../../lib/parseSlicedObjects";
import PrinterSendPanel from "./PrinterSendPanel";

const state = vi.hoisted(() => ({
  hostType: "moonraker" as "moonraker" | "bambu",
  runJob: vi.fn<(start: () => Promise<string>, onDone?: (snapshot: JobSnapshot) => void) => Promise<void>>(),
}));

const printer: PrinterMachine = {
  id: "printer-1", name: "Printer", model: "Voron", integration_id: "host-1",
  bed_width_mm: 300, bed_depth_mm: 300, bed_height_mm: 300,
  margin_mm: 4, max_filament_slots: 1, loaded_filaments: [],
};

vi.mock("../../hooks/useJobRunner", () => ({
  useJobRunner: () => ({ busy: false, runJob: state.runJob }),
}));
vi.mock("../../queries/printerFleet", () => ({
  usePrintersQuery: () => ({ data: [printer], isPending: false }),
  useIntegrationsQuery: () => ({
    data: [{ id: "host-1", name: "Host", type: state.hostType, config: {} }], isPending: false,
  }),
}));
vi.mock("../../queries/printerStatuses", () => ({
  usePrinterStatuses: () => ({ statusByIntegration: {} }),
}));
vi.mock("../../api/endpoints/productionSend", () => ({
  startPrinterUpload: vi.fn(),
  startBambuConnectHandoff: vi.fn(),
  bambuConnectDownloadUrl: vi.fn(),
}));
vi.mock("../../lib/parseSlicedObjects", () => ({ parseSlicedObjectsFile: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

const parsed: ParseSlicedObjectsResult = {
  objects: [], names: [], format: "gcode", unlabeled: true,
};

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  if (!resolve) throw new Error("Deferred promise was not initialized");
  return { promise, resolve };
}

function panel(profileId: number, onFailure = vi.fn()) {
  return (
    <MemoryRouter>
      <PrinterSendPanel key={profileId} profileId={profileId} planName={`Build ${profileId}`}
        remainingParts={[]} engineReady onFailure={onFailure} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  state.hostType = "moonraker";
  state.runJob.mockReset().mockResolvedValue(undefined);
  vi.mocked(parseSlicedObjectsFile).mockReset().mockResolvedValue(parsed);
  vi.mocked(startBambuConnectHandoff).mockReset();
  vi.mocked(toast.message).mockClear();
  sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(["moonraker", "bambu"] as const)("does not dispatch a %s file when its parse finishes after switching Builds", async (hostType) => {
  state.hostType = hostType;
  const previous = deferred<ParseSlicedObjectsResult>();
  vi.mocked(parseSlicedObjectsFile).mockReturnValueOnce(previous.promise);
  const view = render(panel(1));
  if (hostType === "moonraker") fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const fileInput = view.container.querySelector<HTMLInputElement>(
    hostType === "moonraker" ? 'input[accept^=".gcode"]' : 'input[accept^=".3mf"]',
  );
  if (!fileInput) throw new Error("Print file input was not rendered");
  fireEvent.change(fileInput, { target: { files: [new File(["G28"], "build-one.gcode")] } });
  expect(parseSlicedObjectsFile).toHaveBeenCalledTimes(1);

  view.rerender(panel(2));
  await act(async () => previous.resolve(parsed));

  expect(state.runJob).not.toHaveBeenCalled();
  expect(startBambuConnectHandoff).not.toHaveBeenCalled();
  expect(screen.queryByText("build-one.gcode")).toBeNull();
});

it("does not report a previous Build's job failure into a new workspace", async () => {
  const onFailure = vi.fn();
  const view = render(panel(1, onFailure));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const fileInput = view.container.querySelector<HTMLInputElement>('input[accept^=".gcode"]');
  if (!fileInput) throw new Error("Print file input was not rendered");
  fireEvent.change(fileInput, { target: { files: [new File(["G28"], "build-one.gcode")] } });
  await waitFor(() => expect(state.runJob).toHaveBeenCalledTimes(1));
  const onDone = state.runJob.mock.calls[0]?.[1];
  if (!onDone) throw new Error("Upload completion handler was not registered");

  view.rerender(panel(2, onFailure));
  onFailure.mockClear();
  act(() => onDone({ job_id: "job-1", kind: "printer-upload", status: "error",
    message: "Previous Build upload failed", progress: null, error: "offline", result: null }));

  expect(onFailure).not.toHaveBeenCalled();
  expect(screen.queryByText(/Previous Build upload failed/)).toBeNull();
});

it("keeps the current Build's upload failure recoverable", async () => {
  const view = render(panel(1));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const fileInput = view.container.querySelector<HTMLInputElement>('input[accept^=".gcode"]');
  if (!fileInput) throw new Error("Print file input was not rendered");
  fireEvent.change(fileInput, { target: { files: [new File(["G28"], "build-one.gcode")] } });
  await waitFor(() => expect(state.runJob).toHaveBeenCalledTimes(1));
  const onDone = state.runJob.mock.calls[0]?.[1];
  if (!onDone) throw new Error("Upload completion handler was not registered");
  act(() => onDone({ job_id: "job-1", kind: "printer-upload", status: "error",
    message: "Current Build upload failed", progress: null, error: "offline", result: null }));

  expect(screen.getByRole("alert").textContent).toContain("Current Build upload failed");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(state.runJob).toHaveBeenCalledTimes(2);

  view.rerender(panel(2));
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.queryByText("build-one.gcode")).toBeNull();
  expect(screen.getByText("No file chosen")).toBeTruthy();
});

it("ignores a late Bambu handoff response after switching Builds", async () => {
  state.hostType = "bambu";
  const previous = deferred<Awaited<ReturnType<typeof startBambuConnectHandoff>>>();
  vi.mocked(startBambuConnectHandoff).mockReturnValueOnce(previous.promise);
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const view = render(panel(1));
  const fileInput = view.container.querySelector<HTMLInputElement>('input[accept^=".3mf"]');
  if (!fileInput) throw new Error("Bambu file input was not rendered");
  fireEvent.change(fileInput, { target: { files: [new File(["G28"], "build-one.gcode")] } });
  await waitFor(() => expect(startBambuConnectHandoff).toHaveBeenCalledTimes(1));
  expect(startBambuConnectHandoff).toHaveBeenCalledWith(expect.objectContaining({ profile_id: 1 }));

  view.rerender(panel(2));
  await act(async () => previous.resolve({ handoff_id: "handoff-1", filename: "build-one.gcode",
    absolute_path: "/staged/build-one.gcode", connect_url: "bambu-connect://handoff-1",
    launched: false, in_container: true, download_path: "/download/handoff-1",
    message: "Previous Build handoff complete" }));

  expect(toast.message).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});
