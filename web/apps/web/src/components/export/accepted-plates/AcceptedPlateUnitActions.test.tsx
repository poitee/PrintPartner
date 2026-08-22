// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAcceptedPlateWorkspace } from "@print-partner/contracts";
import AcceptedPlateUnitActions from "./AcceptedPlateUnitActions";

const digest = "a".repeat(64);
const token = `ppu_${"b".repeat(32)}`;
const sourcePlateId = `plate_${"c".repeat(32)}`;
const targetPlateId = `plate_${"d".repeat(32)}`;
const printer = {
  id: "printer-one",
  name: "Printer One",
  model: "Model One",
  bed_width_um: 250_000,
  bed_depth_um: 210_000,
  bed_height_um: 200_000,
  margin_um: 4_000,
};
const secondPrinter = { ...printer, id: "printer-two", name: "Printer Two" };
const smallPrinter = {
  ...printer,
  id: "printer-small",
  name: "Printer Small",
  bed_width_um: 20_000,
  bed_depth_um: 20_000,
};
const parsed = parseAcceptedPlateWorkspace({
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
  printers: [printer, secondPrinter, smallPrinter],
  plates: [{
    plate_id: sourcePlateId,
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
      placement: "auto",
      pinned: false,
    }],
  }, {
    plate_id: targetPlateId,
    ordinal: 2,
    printer: secondPrinter,
    units: [],
  }],
});
if (parsed.kind !== "ready") throw new Error("Expected ready workspace");
const workspace = parsed;
const sourcePlate = workspace.plates[0];
if (!sourcePlate) throw new Error("Expected source Plate");
const unit = sourcePlate.units[0];
if (!unit) throw new Error("Expected placed unit");

afterEach(cleanup);

describe("AcceptedPlateUnitActions", () => {
  it("offers exact Plates and a new Plate on every dimension-eligible Printer", () => {
    render(
      <AcceptedPlateUnitActions
        workspace={workspace}
        sourcePlateId={sourcePlate.plate_id}
        state={{ kind: "placed", unit }}
        disabled={false}
        onPin={() => Promise.resolve()}
        onUnplace={() => Promise.resolve()}
        onTransfer={() => Promise.resolve()}
      />,
    );

    expect(screen.getByRole("option", { name: "Plate 2 · Printer Two" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "New Plate · Printer One" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "New Plate · Printer Two" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "New Plate · Printer Small" })).toBeNull();
  });

  it("pins, returns to unplaced, and parses a selected new-Plate target", () => {
    const onPin = vi.fn(() => Promise.resolve());
    const onUnplace = vi.fn(() => Promise.resolve());
    const onTransfer = vi.fn(() => Promise.resolve());
    render(
      <AcceptedPlateUnitActions
        workspace={workspace}
        sourcePlateId={sourcePlate.plate_id}
        state={{ kind: "placed", unit }}
        disabled={false}
        onPin={onPin}
        onUnplace={onUnplace}
        onTransfer={onTransfer}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    fireEvent.click(screen.getByRole("button", { name: "Return to unplaced" }));
    fireEvent.change(screen.getByLabelText("Transfer to"), { target: { value: "printer:printer-two" } });
    fireEvent.click(screen.getByRole("button", { name: "Transfer" }));

    expect(onPin).toHaveBeenCalledWith(sourcePlate.plate_id, unit.token, true);
    expect(onUnplace).toHaveBeenCalledWith(sourcePlate.plate_id, unit.token);
    expect(onTransfer).toHaveBeenCalledWith(
      sourcePlate.plate_id,
      unit.token,
      { kind: "printer", printerId: "printer-two" },
    );
  });
});
