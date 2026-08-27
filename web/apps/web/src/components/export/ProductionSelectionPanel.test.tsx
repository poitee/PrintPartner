// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAcceptedPlateWorkspace } from "@print-partner/contracts";
import {
  initialMissingSelection,
  productionSelectableUnits,
} from "../../lib/productionSelection";
import ProductionSelectionPanel from "./ProductionSelectionPanel";

const digest = "a".repeat(64);
const token = `ppu_${"b".repeat(32)}`;
const second = `ppu_${"c".repeat(32)}`;
const third = `ppu_${"d".repeat(32)}`;
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

afterEach(cleanup);

describe("ProductionSelectionPanel", () => {
  it("starts Prepare missing parts with incomplete units selected and clears a Source-layer group", () => {
    const workspace = parseAcceptedPlateWorkspace({
      kind: "setup",
      basis,
      expected_plate_revision_id: null,
      printers: [printer],
      units: [
        {
          token,
          object_name: `bracket__${token}`,
          filename: "bracket.stl",
          source_layer: "Hardware",
          role: "primary",
          filament_color_id: null,
        },
        {
          token: second,
          object_name: `clip__${second}`,
          filename: "clip.stl",
          source_layer: "Electronics",
          role: "primary",
          filament_color_id: null,
          completed: true,
        },
        {
          token: third,
          object_name: `spacer__${third}`,
          filename: "spacer.stl",
          source_layer: "Electronics",
          role: "accent",
          filament_color_id: null,
        },
      ],
    });
    const units = productionSelectableUnits(workspace);
    const onToggle = vi.fn();
    const onClearGroup = vi.fn();
    render(
      <ProductionSelectionPanel
        units={units}
        selection={initialMissingSelection(units)}
        onToggle={onToggle}
        onClearGroup={onClearGroup}
        onSelectAll={vi.fn()}
        onSelectIncomplete={vi.fn()}
        onClearAll={vi.fn()}
      />,
    );

    expect(screen.getByRole("checkbox", { name: `bracket__${token}` })).toHaveProperty("checked", true);
    expect(screen.getByRole("checkbox", { name: `clip__${second}` })).toHaveProperty("checked", false);
    expect(screen.getByRole("checkbox", { name: `spacer__${third}` })).toHaveProperty("checked", true);
    fireEvent.click(screen.getByRole("button", { name: "Clear Electronics" }));
    expect(onClearGroup).toHaveBeenCalledWith("source_layer", "Electronics");
    fireEvent.click(screen.getByRole("checkbox", { name: `bracket__${token}` }));
    expect(onToggle).toHaveBeenCalledWith(token);
  });

  it("keeps large part sets compact and reveals them in bounded pages", () => {
    const workspace = parseAcceptedPlateWorkspace({
      kind: "setup",
      basis,
      expected_plate_revision_id: null,
      printers: [printer],
      units: Array.from({ length: 60 }, (_, index) => {
        const unitToken = `ppu_${index.toString(16).padStart(32, "0")}`;
        return {
          token: unitToken,
          object_name: `part-${index + 1}__${unitToken}`,
          filename: `part-${index + 1}.stl`,
          source_layer: "Hardware",
          role: "primary",
          filament_color_id: null,
        };
      }),
    });
    const units = productionSelectableUnits(workspace);
    render(
      <ProductionSelectionPanel
        units={units}
        selection={initialMissingSelection(units)}
        onToggle={vi.fn()}
        onClearGroup={vi.fn()}
        onSelectAll={vi.fn()}
        onSelectIncomplete={vi.fn()}
        onClearAll={vi.fn()}
      />,
    );

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText("Units in this Plate build")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit individual selection (60)" }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(50);
    expect(screen.getByRole("button", { name: "Show 10 more" })).toBeTruthy();
  });
});
