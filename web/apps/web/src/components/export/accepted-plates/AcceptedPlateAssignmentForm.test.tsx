// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAcceptedPlateWorkspace } from "@print-partner/contracts";
import AcceptedPlateAssignmentForm from "./AcceptedPlateAssignmentForm";

const digest = "a".repeat(64);
const token = `ppu_${"b".repeat(32)}`;
const plateId = `plate_${"c".repeat(32)}`;
const basis = {
  profile_id: 7,
  plan_version: 3,
  plan_revision_id: 11,
  plan_revision_digest: digest,
  required_unit_mapping_digest: digest,
};
const printer = {
  id: "printer-one",
  name: "Printer One",
  model: "Model One",
  bed_width_um: 250_000,
  bed_depth_um: 210_000,
  bed_height_um: 200_000,
  margin_um: 4_000,
};
const unit = {
  token,
  object_name: `bracket__${token}`,
  filename: "bracket.stl",
  source_layer: "Hardware",
  role: "primary",
  filament_color_id: null,
};

afterEach(cleanup);

function reviewIndividualParts() {
  fireEvent.click(screen.getByRole("button", { name: /Review individual parts/ }));
}

describe("AcceptedPlateAssignmentForm", () => {
  it("starts setup rows unassigned and sends one explicit assignment per token", async () => {
    const workspace = parseAcceptedPlateWorkspace({
      kind: "setup",
      basis,
      expected_plate_revision_id: null,
      printers: [printer],
      units: [unit],
    });
    if (workspace.kind !== "setup") throw new Error("Expected setup workspace");
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onAssignmentsChange = vi.fn();
    render(
      <AcceptedPlateAssignmentForm
        workspace={workspace}
        submitting={false}
        onSubmit={onSubmit}
        onAssignmentsChange={onAssignmentsChange}
      />,
    );

    reviewIndividualParts();
    const select = screen.getByRole("combobox", { name: "Printer" });
    if (!(select instanceof HTMLSelectElement)) throw new Error("Expected Printer select");
    const arrange = screen.getByRole("button", { name: "Build Plates" });
    if (!(arrange instanceof HTMLButtonElement)) throw new Error("Expected Build Plates button");
    expect(select.value).toBe("");
    expect(arrange.disabled).toBe(true);
    fireEvent.change(select, { target: { value: printer.id } });
    expect(onAssignmentsChange).toHaveBeenLastCalledWith([{ token, printer_id: printer.id }]);
    fireEvent.click(screen.getByRole("button", { name: "Build Plates" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      expected: basis,
      expected_plate_revision_id: null,
      assignments: [{ token, printer_id: printer.id }],
    }));
  });

  it("turns a captured missing Printer into Unassigned during reassignment", () => {
    const workspace = parseAcceptedPlateWorkspace({
      kind: "ready",
      basis,
      plate_revision_id: 19,
      plate_revision_number: 2,
      printers: [printer],
      plates: [{
        plate_id: plateId,
        ordinal: 1,
        printer: { ...printer, id: "removed-printer" },
        units: [{
          ...unit,
          x_um: 4_000,
          y_um: 5_000,
          width_um: 30_000,
          depth_um: 20_000,
          height_um: 10_000,
        }],
      }],
    });
    if (workspace.kind !== "ready") throw new Error("Expected ready workspace");
    render(
      <AcceptedPlateAssignmentForm
        workspace={workspace}
        submitting={false}
        onSubmit={vi.fn()}
      />,
    );

    reviewIndividualParts();
    const select = screen.getByRole("combobox", { name: "Printer" });
    const rearrange = screen.getByRole("button", { name: "Save and rebuild Plates" });
    if (!(select instanceof HTMLSelectElement)) throw new Error("Expected Printer select");
    if (!(rearrange instanceof HTMLButtonElement)) throw new Error("Expected rebuild Plates button");
    expect(select.value).toBe("");
    expect(rearrange.disabled).toBe(true);
    expect(screen.getByText("Rebuilding Plates replaces all manual Plate positions.")).toBeDefined();
  });

  it("fills only the chosen Source-layer or role group and still submits every token", async () => {
    const secondToken = `ppu_${"d".repeat(32)}`;
    const thirdToken = `ppu_${"e".repeat(32)}`;
    const workspace = parseAcceptedPlateWorkspace({
      kind: "setup",
      basis,
      expected_plate_revision_id: null,
      printers: [printer, { ...printer, id: "printer-two", name: "Printer Two" }],
      units: [
        unit,
        { ...unit, token: secondToken, object_name: `clip__${secondToken}` },
        {
          ...unit,
          token: thirdToken,
          object_name: `knob__${thirdToken}`,
          source_layer: "Controls",
          role: "secondary",
        },
      ],
    });
    if (workspace.kind !== "setup") throw new Error("Expected setup workspace");
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onAssignmentsChange = vi.fn();
    render(
      <AcceptedPlateAssignmentForm
        workspace={workspace}
        submitting={false}
        onSubmit={onSubmit}
        onAssignmentsChange={onAssignmentsChange}
      />,
    );

    const hardwareGroup = screen.getByRole("combobox", { name: "Assign Hardware Source layer" });
    fireEvent.change(hardwareGroup, {
      target: { value: "printer-one" },
    });
    if (!(hardwareGroup instanceof HTMLSelectElement)) throw new Error("Expected Source-layer select");
    expect(hardwareGroup.value).toBe("printer-one");
    reviewIndividualParts();
    const rowSelects = screen.getAllByRole("combobox", { name: "Printer" });
    expect(rowSelects.map((select) => select instanceof HTMLSelectElement ? select.value : null)).toEqual([
      "printer-one",
      "printer-one",
      "",
    ]);
    expect(onAssignmentsChange).toHaveBeenLastCalledWith([
      { token, printer_id: "printer-one" },
      { token: secondToken, printer_id: "printer-one" },
      { token: thirdToken, printer_id: null },
    ]);
    fireEvent.change(screen.getByRole("combobox", { name: "Bulk assign by" }), {
      target: { value: "role" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Assign secondary role" }), {
      target: { value: "printer-two" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Build Plates" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      assignments: [
        { token, printer_id: "printer-one" },
        { token: secondToken, printer_id: "printer-one" },
        { token: thirdToken, printer_id: "printer-two" },
      ],
    })));
  });

  it("keeps bulk groups stable while filters narrow individual parts", () => {
    const secondToken = `ppu_${"d".repeat(32)}`;
    const workspace = parseAcceptedPlateWorkspace({
      kind: "setup",
      basis,
      expected_plate_revision_id: null,
      printers: [printer],
      units: [
        unit,
        {
          ...unit,
          token: secondToken,
          object_name: `clip__${secondToken}`,
          source_layer: "Controls",
        },
      ],
    });
    if (workspace.kind !== "setup") throw new Error("Expected setup workspace");
    render(
      <AcceptedPlateAssignmentForm
        workspace={workspace}
        savedAssignments={[{ token, printer_id: printer.id }]}
        submitting={false}
        onSubmit={vi.fn()}
      />,
    );

    reviewIndividualParts();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Plate assignments" }), {
      target: { value: "Controls" },
    });

    expect(screen.getByRole("combobox", { name: "Assign Controls Source layer" })).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Assign Hardware Source layer" })).toBeDefined();
    expect(screen.getByText(`clip__${secondToken}`)).toBeDefined();
    expect(screen.queryByText(unit.object_name)).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search Plate assignments" }), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter Plate assignments" }), {
      target: { value: "assigned" },
    });

    expect(screen.getByRole("combobox", { name: "Assign Hardware Source layer" })).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Assign Controls Source layer" })).toBeDefined();
    expect(screen.getByText(unit.object_name)).toBeDefined();
    expect(screen.queryByText(`clip__${secondToken}`)).toBeNull();
  });

  it("submits only selected Required units", async () => {
    const secondToken = `ppu_${"d".repeat(32)}`;
    const omittedToken = `ppu_${"e".repeat(32)}`;
    const workspace = parseAcceptedPlateWorkspace({
      kind: "setup",
      basis,
      expected_plate_revision_id: null,
      printers: [printer],
      units: [
        unit,
        { ...unit, token: secondToken, object_name: `clip__${secondToken}` },
        { ...unit, token: omittedToken, object_name: `knob__${omittedToken}` },
      ],
    });
    if (workspace.kind !== "setup") throw new Error("Expected setup workspace");
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <AcceptedPlateAssignmentForm
        workspace={workspace}
        submitting={false}
        selectedTokens={new Set([unit.token, secondToken])}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.queryByText(`knob__${omittedToken}`)).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Assign Hardware Source layer" }), {
      target: { value: printer.id },
    });
    fireEvent.click(screen.getByRole("button", { name: "Build Plates" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      assignments: [
        { token: unit.token, printer_id: printer.id },
        { token: secondToken, printer_id: printer.id },
      ],
    })));
  });

  it("assigns an Unassigned unit without replacing existing Plate rows", async () => {
    const leftover = `ppu_${"d".repeat(32)}`;
    const workspace = parseAcceptedPlateWorkspace({
      kind: "ready",
      basis,
      plate_revision_id: 19,
      plate_revision_number: 2,
      printers: [printer],
      plates: [{
        plate_id: plateId,
        ordinal: 1,
        printer,
        units: [{
          ...unit,
          x_um: 4_000,
          y_um: 5_000,
          width_um: 30_000,
          depth_um: 20_000,
          height_um: 10_000,
        }],
      }],
      unassigned: [{
        ...unit,
        token: leftover,
        object_name: `clip__${leftover}`,
      }],
    });
    if (workspace.kind !== "ready") throw new Error("Expected ready workspace");
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <AcceptedPlateAssignmentForm
        workspace={workspace}
        submitting={false}
        selectedTokens={new Set([leftover])}
        onSubmit={onSubmit}
      />,
    );

    reviewIndividualParts();
    expect(screen.getByText(`clip__${leftover}`)).toBeTruthy();
    expect(screen.queryByText(unit.object_name)).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Printer" }), {
      target: { value: printer.id },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and rebuild Plates" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      expected: basis,
      expected_plate_revision_id: 19,
      assignments: [{ token: leftover, printer_id: printer.id }],
    }));
  });

  it("keeps unplaced Required units in full printer reassignment", async () => {
    const unplacedToken = `ppu_${"d".repeat(32)}`;
    const workspace = parseAcceptedPlateWorkspace({
      kind: "ready",
      basis,
      plate_revision_id: 19,
      plate_revision_number: 2,
      printers: [printer],
      plates: [{
        plate_id: plateId,
        ordinal: 1,
        printer,
        units: [{
          ...unit,
          x_um: 4_000,
          y_um: 5_000,
          width_um: 30_000,
          depth_um: 20_000,
          height_um: 10_000,
        }],
      }],
      unplaced: [{
        ...unit,
        token: unplacedToken,
        object_name: `clip__${unplacedToken}`,
        plate_id: plateId,
        printer_id: printer.id,
        width_um: 30_000,
        depth_um: 20_000,
        height_um: 10_000,
      }],
    });
    if (workspace.kind !== "ready") throw new Error("Expected ready workspace");
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AcceptedPlateAssignmentForm workspace={workspace} submitting={false} onSubmit={onSubmit} />);

    reviewIndividualParts();
    expect(screen.getByText(`clip__${unplacedToken}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save and rebuild Plates" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      expected: basis,
      expected_plate_revision_id: 19,
      assignments: [
        { token, printer_id: printer.id },
        { token: unplacedToken, printer_id: printer.id },
      ],
    }));
  });
});
