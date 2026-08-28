// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrinterCheckoffLink } from "../../api/endpoints/checkoff";
import PrinterTrackedView from "./PrinterTrackedView";
import { build, printer } from "./testFixtures";

const api = vi.hoisted(() => ({ completeManualPrinterFile: vi.fn() }));

vi.mock("../../api/endpoints/checkoff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/endpoints/checkoff")>()),
  completeManualPrinterFile: api.completeManualPrinterFile,
}));

const manualLink: PrinterCheckoffLink = {
  id: "link-manual",
  profile_id: build.id,
  integration_id: `manual:${printer.id}`,
  printer_id: printer.id,
  host_name: "Manual",
  filename: "bracket.gcode",
  units: [{ part_id: 41, unit_index: 0 }],
  state: "watching",
  saw_active: false,
  created_at: "2026-08-27T00:00:00.000Z",
};

const watchedLink: PrinterCheckoffLink = {
  ...manualLink,
  id: "link-watched",
  integration_id: "moonraker-one",
  filename: "panel.gcode",
  state: "awaiting_verify",
};

describe("PrinterTrackedView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.completeManualPrinterFile.mockResolvedValue({ link: manualLink });
  });

  afterEach(cleanup);

  it("names the owner of every pending print in words, not a state name", () => {
    render(
      <PrinterTrackedView
        printer={printer}
        profiles={[build]}
        links={[manualLink, watchedLink]}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByText("Waiting for you to mark it finished")).toBeTruthy();
    expect(screen.getByText("Ready for Checkoff")).toBeTruthy();
    expect(screen.queryByText("awaiting verify")).toBeNull();
    expect(screen.queryByText("awaiting_verify")).toBeNull();
  });

  it("offers Mark finished only for a print no host reports on", () => {
    render(
      <PrinterTrackedView
        printer={printer}
        profiles={[build]}
        links={[manualLink, watchedLink]}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("button", { name: "Mark finished" })).toHaveLength(1);
  });

  it("keeps a failed finish on screen with a Retry that reruns it", async () => {
    api.completeManualPrinterFile.mockRejectedValueOnce(new Error("Link already closed"));
    const onChanged = vi.fn();
    render(
      <PrinterTrackedView
        printer={printer}
        profiles={[build]}
        links={[manualLink]}
        onChanged={onChanged}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark finished" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not finish bracket.gcode");
    expect(alert.textContent).toContain("Link already closed");
    expect(onChanged).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Mark finished again" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("guides the operator when nothing is tracked yet", () => {
    render(
      <PrinterTrackedView printer={printer} profiles={[build]} links={[]} onChanged={vi.fn()} />,
    );

    expect(screen.getByText("No print file is assigned to Voron One yet.")).toBeTruthy();
    expect(screen.getByText(/Pick a file in the Files tab/)).toBeTruthy();
  });
});
