// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startPrinterUpload } from "../../api/endpoints/productionSend";
import { fetchJob } from "../../api/endpoints/jobs";
import { JobProvider } from "../../context/JobContext";
import PrinterSendPanel from "./PrinterSendPanel";
vi.mock("../../queries/printerFleet", () => ({
  usePrintersQuery: () => ({ data: [{ id: "printer-1", name: "Printer", model: "Voron", integration_id: "host-1", bed_width_mm: 300, bed_depth_mm: 300, bed_height_mm: 300, margin_mm: 4, max_filament_slots: 1, loaded_filaments: [] }], isPending: false }),
  useIntegrationsQuery: () => ({ data: [{ id: "host-1", name: "Host", type: "moonraker", config: {} }], isPending: false }),
}));
vi.mock("../../queries/printerStatuses", () => ({ usePrinterStatuses: () => ({ statusByIntegration: {} }) }));
vi.mock("../../api/endpoints/productionSend", () => ({ startPrinterUpload: vi.fn(), startBambuConnectHandoff: vi.fn(), bambuConnectDownloadUrl: vi.fn() }));
vi.mock("../../lib/parseSlicedObjects", () => ({ parseSlicedObjectsFile: vi.fn(() => Promise.resolve({ objects: [], names: [], format: "gcode", unlabeled: true })) }));
vi.mock("../../api/endpoints/jobs", () => ({ fetchJob: vi.fn() }));
vi.mock("../../api/jobWebSocket", () => ({ connectJobWebSocket: vi.fn(() => vi.fn()) }));
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); });
afterEach(cleanup);
it("keeps a start failure recoverable and sends the same file on Retry", async () => {
  vi.mocked(startPrinterUpload).mockRejectedValueOnce(new Error("Printer request offline")).mockResolvedValueOnce("upload-1");
  vi.mocked(fetchJob).mockResolvedValue({ job_id: "upload-1", kind: "printer-upload", status: "done", message: "Sent", error: null, result: null, progress: 100 });
  const queryClient = new QueryClient();
  const view = render(<QueryClientProvider client={queryClient}><JobProvider><MemoryRouter><PrinterSendPanel profileId={7} planName="A" remainingParts={[]} engineReady /></MemoryRouter></JobProvider></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const input = view.container.querySelector<HTMLInputElement>('input[accept^=".gcode"]');
  if (!input) throw new Error("Print file input absent");
  const file = new File(["G28"], "probe.gcode");
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Printer request offline"));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry" })); });
  expect(startPrinterUpload).toHaveBeenCalledTimes(2);
  expect(startPrinterUpload).toHaveBeenNthCalledWith(2, expect.objectContaining({ file, profile_id: 7, printer_id: "printer-1", start: false }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
