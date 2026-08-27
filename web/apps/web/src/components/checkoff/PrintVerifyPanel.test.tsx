// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrinterCheckoffLink } from "../../api/endpoints/checkoff";
import type { ReviewPart } from "../../api/endpoints/planManifests";
import PrintVerifyPanel from "./PrintVerifyPanel";

const api = vi.hoisted(() => ({
  verifyPrinterCheckoff: vi.fn(),
  dismissPrinterCheckoff: vi.fn(),
  fetchPrinterCheckoffLinks: vi.fn().mockResolvedValue({ links: [] }),
}));

vi.mock("../../api/endpoints/checkoff", () => ({
  verifyPrinterCheckoff: api.verifyPrinterCheckoff,
  dismissPrinterCheckoff: api.dismissPrinterCheckoff,
  fetchPrinterCheckoffLinks: api.fetchPrinterCheckoffLinks,
}));

vi.mock("../export/ObjectProposalRows", () => ({
  default: () => <div>proposal rows</div>,
}));

const part = {
  id: 11,
  filename: "gantry.stl",
  relative_path: "parts/gantry.stl",
  match_key: "gantry",
  quantity_effective: 1,
  printed_count: 0,
  print_units: [false],
  missing: true,
} as unknown as ReviewPart;

const awaiting: PrinterCheckoffLink = {
  id: "link-1",
  profile_id: 7,
  integration_id: "prusa-1",
  printer_id: "core-one",
  host_name: "Core One",
  filename: "gantry.bgcode",
  units: [{ part_id: 11, unit_index: 0 }],
  state: "awaiting_verify",
  saw_active: true,
  created_at: "2026-08-27T09:00:00.000Z",
};

function renderPanel() {
  const onActivityRefresh = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PrintVerifyPanel
        engineReady
        profileId={7}
        parts={[part]}
        activityLinks={{ watching: [], awaiting: [awaiting], failed: [] }}
        onActivityRefresh={onActivityRefresh}
      />
    </QueryClientProvider>,
  );
  return { onActivityRefresh };
}

describe("PrintVerifyPanel recovery", () => {
  beforeEach(() => {
    api.verifyPrinterCheckoff.mockReset();
    api.dismissPrinterCheckoff.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps a failed confirm on the job with a Retry that reruns it", async () => {
    api.verifyPrinterCheckoff
      .mockRejectedValueOnce(new Error("printer host offline"))
      .mockResolvedValueOnce({ units_confirmed: 1, units_rejected: 0 });

    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Confirm/ }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Could not confirm the printed units for gantry.bgcode: printer host offline",
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(api.verifyPrinterCheckoff).toHaveBeenCalledTimes(2),
    );
    expect(api.verifyPrinterCheckoff.mock.calls[1]?.[0]).toEqual({
      link_id: "link-1",
      decisions: [{ part_id: 11, unit_index: 0, result: "confirmed" }],
    });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("Confirmed 1 unit printed.")).toBeTruthy();
  });

  it("keeps the reject reason and note when the reject fails", async () => {
    api.verifyPrinterCheckoff.mockRejectedValue(new Error("409"));

    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Reject/ }));
    fireEvent.change(screen.getByLabelText("Reject reason"), {
      target: { value: "layer_shift" },
    });
    fireEvent.change(screen.getByPlaceholderText("Optional note"), {
      target: { value: "shifted at 40mm" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save reject" }));

    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain(
      "Could not save the reject for gantry.bgcode: 409",
    );
    // The operator's choices survive the failure.
    expect((screen.getByLabelText("Reject reason") as HTMLSelectElement).value).toBe(
      "layer_shift",
    );
    expect(
      (screen.getByPlaceholderText("Optional note") as HTMLInputElement).value,
    ).toBe("shifted at 40mm");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.verifyPrinterCheckoff).toHaveBeenCalledTimes(2));
    expect(api.verifyPrinterCheckoff.mock.calls[1]?.[0].decisions[0]).toMatchObject({
      result: "rejected",
      reason: "layer_shift",
      note: "shifted at 40mm",
    });
  });
});
