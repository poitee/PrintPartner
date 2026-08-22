// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAcceptedPlateWorkspace } from "@print-partner/contracts";
import AcceptedPlateGallery from "./AcceptedPlateGallery";

const digest = "a".repeat(64);
const firstToken = `ppu_${"b".repeat(32)}`;
const secondToken = `ppu_${"d".repeat(32)}`;
const plateId = `plate_${"c".repeat(32)}`;
const printer = {
  id: "printer-one",
  name: "Printer One",
  model: "Model One",
  bed_width_um: 250_000,
  bed_depth_um: 210_000,
  bed_height_um: 200_000,
  margin_um: 4_000,
};
const initial = parseAcceptedPlateWorkspace({
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
    plate_id: plateId,
    ordinal: 1,
    printer,
    units: [{
      token: firstToken,
      object_name: `bracket__${firstToken}`,
      filename: "bracket.stl",
      source_layer: "Hardware",
      role: "primary",
      filament_color_id: null,
      x_um: 4_000,
      y_um: 5_000,
      width_um: 30_000,
      depth_um: 20_000,
      height_um: 10_000,
    }, {
      token: secondToken,
      object_name: `clip__${secondToken}`,
      filename: "clip.stl",
      source_layer: "Hardware",
      role: "secondary",
      filament_color_id: null,
      x_um: 40_000,
      y_um: 5_000,
      width_um: 20_000,
      depth_um: 20_000,
      height_um: 10_000,
    }],
  }],
});
if (initial.kind !== "ready") throw new Error("Expected ready workspace");
const ready = initial;
const editable = parseAcceptedPlateWorkspace({
  ...ready,
  arrange_undo_revision_id: 17,
  plates: ready.plates.map((plate) => ({
    ...plate,
    units: plate.units.filter((unit) => unit.token !== secondToken),
  })),
  unplaced: [{
    token: secondToken,
    object_name: `clip__${secondToken}`,
    filename: "clip.stl",
    source_layer: "Hardware",
    role: "secondary",
    filament_color_id: null,
    plate_id: plateId,
    printer_id: printer.id,
    width_um: 20_000,
    depth_um: 20_000,
    height_um: 10_000,
  }],
});
if (editable.kind !== "ready") throw new Error("Expected editable workspace");

afterEach(cleanup);

describe("AcceptedPlateGallery successor revisions", () => {
  it("shows unplaced units and keeps both arrangement modes plus append-only Undo actionable", () => {
    const onArrange = vi.fn(() => Promise.resolve());
    const onRestore = vi.fn(() => Promise.resolve());
    render(
      <AcceptedPlateGallery
        workspace={editable}
        disabled={false}
        onMove={() => Promise.resolve(true)}
        onStaleMove={() => Promise.resolve()}
        onPin={() => Promise.resolve()}
        onUnplace={() => Promise.resolve()}
        onTransfer={() => Promise.resolve()}
        onArrange={onArrange}
        onRestore={onRestore}
      />,
    );

    expect(screen.getByRole("heading", { name: "Unplaced" })).toBeTruthy();
    expect(screen.getByText(`clip__${secondToken}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Arrange unplaced" }));
    fireEvent.click(screen.getByRole("button", { name: "Arrange all" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo arrange all" }));
    expect(onArrange.mock.calls).toEqual([["unplaced"], ["all"]]);
    expect(onRestore).toHaveBeenCalledWith(17);
  });

  it("allows constrained arrangement to rerun when no units are explicitly unplaced", () => {
    const onArrange = vi.fn(() => Promise.resolve());
    render(
      <AcceptedPlateGallery
        workspace={ready}
        disabled={false}
        onMove={() => Promise.resolve(true)}
        onStaleMove={() => Promise.resolve()}
        onPin={() => Promise.resolve()}
        onUnplace={() => Promise.resolve()}
        onTransfer={() => Promise.resolve()}
        onArrange={onArrange}
        onRestore={() => Promise.resolve()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Arrange unplaced" }));
    expect(onArrange).toHaveBeenCalledWith("unplaced");
  });

  it("preserves the selected unit and exact-field focus after a saved move publishes a successor", async () => {
    const onMove = vi.fn();
    function Harness() {
      const [workspace, setWorkspace] = useState(ready);
      const move = async (movedPlateId: string, movedToken: string, xUm: number, yUm: number) => {
        onMove(movedPlateId, movedToken, xUm, yUm);
        setWorkspace((current) => ({
          ...current,
          plate_revision_id: current.plate_revision_id + 1,
          plate_revision_number: current.plate_revision_number + 1,
          plates: current.plates.map((plate) => ({
            ...plate,
            units: plate.units.map((unit) => unit.token === movedToken
              ? { ...unit, x_um: xUm, y_um: yUm }
              : unit),
          })),
        }));
        return true;
      };
      return (
        <AcceptedPlateGallery
          workspace={workspace}
          disabled={false}
          onMove={move}
          onStaleMove={() => Promise.resolve()}
          onPin={() => Promise.resolve()}
          onUnplace={() => Promise.resolve()}
          onTransfer={() => Promise.resolve()}
          onArrange={() => Promise.resolve()}
          onRestore={() => Promise.resolve()}
        />
      );
    }
    render(<Harness />);
    fireEvent.focus(screen.getByRole("button", { name: `clip__${secondToken}` }));
    const x = screen.getByLabelText("X position (mm)");
    fireEvent.change(x, { target: { value: "45" } });
    x.focus();
    fireEvent.submit(screen.getByRole("form", { name: "Exact Plate position" }));

    await waitFor(() => expect(onMove).toHaveBeenCalledWith(plateId, secondToken, 45_000, 5_000));
    expect(screen.getByLabelText("X position (mm)")).toBe(x);
    expect(document.activeElement).toBe(x);
    if (!(x instanceof HTMLInputElement)) throw new Error("Expected X input");
    expect(x.value).toBe("45");
  });
});
