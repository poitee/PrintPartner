// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnattributedPrint } from "@print-partner/contracts";
import UnattributedPrintCard from "./UnattributedPrintCard";

const api = vi.hoisted(() => ({
  fetchProfiles: vi.fn(),
  claimUnattributedPrint: vi.fn(),
  dismissUnattributedPrint: vi.fn(),
}));

vi.mock("../../api/endpoints/plans", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/endpoints/plans")>()),
  fetchProfiles: api.fetchProfiles,
}));

vi.mock("../../api/endpoints/checkoff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/endpoints/checkoff")>()),
  claimUnattributedPrint: api.claimUnattributedPrint,
  dismissUnattributedPrint: api.dismissUnattributedPrint,
}));

vi.mock("../ui/select", () => ({
  Select: ({ value, onValueChange, children, disabled }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
    disabled?: boolean;
  }) => (
    <select
      aria-label="Select a plan"
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: ({ placeholder }: { placeholder: string }) => <option value="">{placeholder}</option>,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchProfiles.mockResolvedValue([]);
  api.claimUnattributedPrint.mockResolvedValue({
    ok: true,
    link: { id: "link-one", units: [{ part_id: 9, unit_index: 0 }] },
  });
  api.dismissUnattributedPrint.mockResolvedValue(undefined);
});

afterEach(cleanup);

const print = {
  id: "17",
  integration_id: "moonraker-one",
  printer_id: "printer-one",
  host_name: "Voron Host",
  filename: "jobs/plate-one.gcode",
  completed_at: "2026-08-25T12:00:00.000Z",
  gcode_objects: ["gantry_left.stl", "idler.stl"],
  candidates: [
    {
      stl_basename: "gantry_left.stl",
      copy_count: 2,
      matching_filenames: ["printer/gantry_left.stl"],
    },
    {
      stl_basename: "idler.stl",
      copy_count: 1,
      matching_filenames: [],
    },
  ],
} satisfies UnattributedPrint;

describe("UnattributedPrintCard", () => {
  it("starts as a compact flair and opens to show detected files", () => {
    render(<UnattributedPrintCard print={print} />);

    const flair = screen.getByRole("button", { name: /Unclaimed print detected/ });
    expect(flair.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Found on plate:")).toBeNull();

    fireEvent.click(flair);

    expect(flair.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Found on plate:")).toBeTruthy();
    expect(screen.getByText("gantry_left.stl")).toBeTruthy();
    expect(screen.getByText("idler.stl")).toBeTruthy();
    expect(screen.getByText("printer/gantry_left.stl")).toBeTruthy();
  });

  it("claims a whole plate for manual verification without confirming quantities", async () => {
    api.fetchProfiles.mockResolvedValue([{ id: 4, name: "Voron Build" }]);
    render(<UnattributedPrintCard print={print} />);

    fireEvent.click(screen.getByRole("button", { name: /Unclaimed print detected/ }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Select a plan" }), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Claim whole plate" }));

    await waitFor(() => {
      expect(api.claimUnattributedPrint).toHaveBeenCalledWith("17", 4, undefined);
    });
  });

  it("claims only selected files for a partial plate", async () => {
    api.fetchProfiles.mockResolvedValue([{ id: 4, name: "Voron Build" }]);
    render(<UnattributedPrintCard print={print} />);

    fireEvent.click(screen.getByRole("button", { name: /Unclaimed print detected/ }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Select a plan" }), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByLabelText(/idler\.stl/));
    fireEvent.click(screen.getByRole("button", { name: "Claim selected files" }));

    await waitFor(() => {
      expect(api.claimUnattributedPrint).toHaveBeenCalledWith("17", 4, {
        selected_stl_basenames: ["gantry_left.stl"],
      });
    });
  });
});
