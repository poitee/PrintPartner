// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultProductionSetup, parseAcceptedPlateWorkspace } from "@print-partner/contracts";
import ProductionRulesPanel from "./ProductionRulesPanel";

const digest = "a".repeat(64);
const token = `ppu_${"b".repeat(32)}`;
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
    plate_id: plateId,
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
      y_um: 4_000,
      width_um: 20_000,
      depth_um: 20_000,
      height_um: 10_000,
    }],
  }],
});
if (workspace.kind !== "ready") throw new Error("Expected a ready Plate workspace");

const mutateAsync = vi.fn(() => Promise.resolve(workspace));

vi.mock("../../api/engine", () => ({
  fetchPrinters: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../queries/productionSetup", () => ({
  useProductionSetup: () => ({
    data: defaultProductionSetup(7),
    isPending: false,
    saving: false,
    save: vi.fn(() => Promise.resolve(defaultProductionSetup(7))),
  }),
}));

vi.mock("../../queries/acceptedPlates", () => ({
  useAcceptedPlateRevisionPending: () => false,
  useAcceptedPlateWorkspaceQuery: () => ({ data: workspace }),
  useInitializeAcceptedPlatesMutation: () => ({ isPending: false, mutateAsync }),
}));

afterEach(() => {
  mutateAsync.mockClear();
});

describe("ProductionRulesPanel", () => {
  it("offers to regenerate assigned Plates after rules change", async () => {
    render(<ProductionRulesPanel profileId={7} />);

    const button = await screen.findByRole("button", { name: "Regenerate plates" });
    fireEvent.click(button);

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({
      expected: workspace.basis,
      expected_plate_revision_id: workspace.plate_revision_id,
      assignments: [{ token, printer_id: printer.id }],
    }));
  });
});
