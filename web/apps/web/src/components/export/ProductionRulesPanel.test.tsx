// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const secondPrinter = {
  ...printer,
  id: "printer-two",
  name: "Printer Two",
};
function parseReadyWorkspace(input: unknown) {
  const parsed = parseAcceptedPlateWorkspace(input);
  if (parsed.kind !== "ready") throw new Error("Expected a ready Plate workspace");
  return parsed;
}

const workspace = parseReadyWorkspace({
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
let mockWorkspace = workspace;

const mutateAsync = vi.fn(() => Promise.resolve(workspace));

vi.mock("../../api/endpoints/printers", () => ({
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
  useAcceptedPlateWorkspaceQuery: () => ({ data: mockWorkspace }),
  useInitializeAcceptedPlatesMutation: () => ({ isPending: false, mutateAsync }),
}));

afterEach(() => {
  cleanup();
  mutateAsync.mockClear();
  mockWorkspace = workspace;
});

describe("ProductionRulesPanel", () => {
  it("offers to regenerate assigned Plates after rules change", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProductionRulesPanel profileId={7} selectedTokens={new Set([token])} />
      </QueryClientProvider>,
    );

    const button = await screen.findByRole("button", { name: "Regenerate plates" });
    fireEvent.click(button);

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({
      expected: workspace.basis,
      expected_plate_revision_id: workspace.plate_revision_id,
      assignments: [{ token, printer_id: printer.id }],
    }));
  });

  it("regenerates only the selected batch when completed units remain unassigned", async () => {
    const selected = Array.from(
      { length: 6 },
      (_, index) => `ppu_${String(index + 1).repeat(32)}`,
    );
    const completed = [
      `ppu_${"7".repeat(32)}`,
      `ppu_${"8".repeat(32)}`,
    ];
    const placed = (unitToken: string, index: number) => ({
      token: unitToken,
      object_name: `part-${index}__${unitToken}`,
      filename: `part-${index}.stl`,
      source_layer: "Hardware",
      role: index < 5 ? "primary" : "accent",
      filament_color_id: null,
      x_um: 4_000 + index * 25_000,
      y_um: 4_000,
      width_um: 20_000,
      depth_um: 20_000,
      height_um: 10_000,
    });
    const unassigned = (unitToken: string, index: number) => ({
      token: unitToken,
      object_name: `finished-${index}__${unitToken}`,
      filename: `finished-${index}.stl`,
      source_layer: "Hardware",
      role: "primary",
      filament_color_id: null,
      completed: true,
    });
    mockWorkspace = parseReadyWorkspace({
      kind: "ready",
      basis: workspace.basis,
      plate_revision_id: workspace.plate_revision_id,
      plate_revision_number: workspace.plate_revision_number,
      printers: [printer, secondPrinter],
      plates: [
        {
          plate_id: `plate_${"d".repeat(32)}`,
          ordinal: 1,
          printer,
          units: selected.slice(0, 5).map(placed),
        },
        {
          plate_id: `plate_${"e".repeat(32)}`,
          ordinal: 2,
          printer: secondPrinter,
          units: [placed(selected[5]!, 5)],
        },
      ],
      unassigned: completed.map(unassigned),
    });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProductionRulesPanel profileId={7} selectedTokens={new Set(selected)} />
      </QueryClientProvider>,
    );

    const button = await screen.findByRole("button", { name: "Regenerate plates" });
    expect(button).toHaveProperty("disabled", false);
    expect(screen.getByText(/current printer assignments are preserved/)).toBeTruthy();
    fireEvent.click(button);

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({
      expected: mockWorkspace.basis,
      expected_plate_revision_id: mockWorkspace.plate_revision_id,
      assignments: [
        ...selected.slice(0, 5).map((unitToken) => ({
          token: unitToken,
          printer_id: printer.id,
        })),
        { token: selected[5], printer_id: secondPrinter.id },
      ],
    }));
  });

  it("keeps regeneration blocked when a selected unit is unassigned", async () => {
    mockWorkspace = parseReadyWorkspace({
      ...workspace,
      unassigned: [{
        token: `ppu_${"1".repeat(32)}`,
        object_name: `clip__ppu_${"1".repeat(32)}`,
        filename: "clip.stl",
        source_layer: "Hardware",
        role: "accent",
        filament_color_id: null,
      }],
    });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProductionRulesPanel
          profileId={7}
          selectedTokens={new Set([token, `ppu_${"1".repeat(32)}`])}
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/Assign all selected units first\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Regenerate plates" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
