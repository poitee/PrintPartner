// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAcceptedPlateWorkspace } from "@print-partner/contracts";
import AcceptedPlatePositionEditor from "./AcceptedPlatePositionEditor";

const digest = "a".repeat(64);
const token = `ppu_${"b".repeat(32)}`;
const printer = {
  id: "printer-one",
  name: "Printer One",
  model: "Model One",
  bed_width_um: 250_000,
  bed_depth_um: 210_000,
  bed_height_um: 200_000,
  margin_um: 4_000,
};
const workspace = parseAcceptedPlateWorkspace({
  kind: "ready",
  basis: {
    profile_id: 7,
    plan_version: 3,
    plan_revision_id: 11,
    plan_revision_digest: digest,
    required_unit_mapping_digest: digest,
  },
  plate_revision_id: 19,
  plate_revision_number: 2,
  printers: [printer],
  plates: [{
    plate_id: `plate_${"c".repeat(32)}`,
    ordinal: 1,
    printer,
    units: [{
      token,
      object_name: `bracket__${token}`,
      filename: "bracket.stl",
      source_layer: "Hardware",
      role: "primary",
      filament_color_id: null,
      x_um: 4_000,
      y_um: 5_000,
      width_um: 30_000,
      depth_um: 20_000,
      height_um: 10_000,
    }],
  }],
});
if (workspace.kind !== "ready") throw new Error("Expected ready workspace");
const placedUnit = workspace.plates[0]?.units[0];
if (!placedUnit) throw new Error("Expected placed unit");

afterEach(cleanup);

describe("AcceptedPlatePositionEditor", () => {
  it("submits exact millimetre fields as integer micrometres", async () => {
    const onMove = vi.fn().mockResolvedValue(true);
    render(
      <AcceptedPlatePositionEditor
        unit={placedUnit}
        printer={printer}
        disabled={false}
        onMove={onMove}
        onStaleMove={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("X position (mm)"), { target: { value: "12.345" } });
    fireEvent.change(screen.getByLabelText("Y position (mm)"), { target: { value: "22" } });
    fireEvent.click(screen.getByRole("button", { name: "Save position" }));
    await waitFor(() => expect(onMove).toHaveBeenCalledWith(12_345, 22_000));
  });

  it("restores persisted coordinates and focus after a stale move", async () => {
    const calls: string[] = [];
    const onMove = vi.fn().mockResolvedValue(false);
    const onStaleMove = vi.fn().mockImplementation(() => {
      calls.push("refresh");
      return Promise.resolve();
    });
    render(
      <AcceptedPlatePositionEditor
        unit={placedUnit}
        printer={printer}
        disabled={false}
        onMove={onMove}
        onStaleMove={onStaleMove}
      />,
    );
    const x = screen.getByLabelText("X position (mm)");
    fireEvent.change(x, { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save position" }));

    await waitFor(() => expect(onStaleMove).toHaveBeenCalledOnce());
    if (!(x instanceof HTMLInputElement)) throw new Error("Expected X input");
    expect(x.value).toBe("4");
    expect(document.activeElement).toBe(x);
    expect(calls).toEqual(["refresh"]);
  });
});
