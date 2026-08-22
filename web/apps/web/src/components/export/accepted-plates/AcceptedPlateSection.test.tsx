// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  parseAcceptedPlateWorkspace,
  type AcceptedPlateWorkspace,
} from "@print-partner/contracts";
import AcceptedPlateSection from "./AcceptedPlateSection";

const digest = "a".repeat(64);
const token = `ppu_${"b".repeat(32)}`;
const otherToken = `ppu_${"c".repeat(32)}`;
const placedToken = `ppu_${"d".repeat(32)}`;
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

function setupWorkspace(
  nextBasis = basis,
  expectedPlateRevisionId: number | null = null,
): AcceptedPlateWorkspace {
  return parseAcceptedPlateWorkspace({
    kind: "setup",
    basis: nextBasis,
    expected_plate_revision_id: expectedPlateRevisionId,
    printers: [printer],
    units: [{
      token,
      object_name: `bracket__${token}`,
      filename: "bracket.stl",
      source_layer: "Hardware",
      role: "primary",
      filament_color_id: null,
    }],
  });
}

function readyWorkspace(): AcceptedPlateWorkspace {
  return parseAcceptedPlateWorkspace({
    kind: "ready",
    basis,
    plate_revision_id: 19,
    plate_revision_number: 2,
    printers: [printer],
    plates: [
      {
        plate_id: "plate_11111111111111111111111111111111",
        ordinal: 1,
        printer,
        units: [
          {
            token: placedToken,
            object_name: `placed__${placedToken}`,
            filename: "placed.stl",
            source_layer: "Hardware",
            role: "primary",
            filament_color_id: null,
            x_um: 4_000,
            y_um: 4_000,
            width_um: 20_000,
            depth_um: 20_000,
            height_um: 10_000,
          },
        ],
      },
    ],
    unassigned: [
      {
        token,
        object_name: `bracket__${token}`,
        filename: "bracket.stl",
        source_layer: "Hardware",
        role: "primary",
        filament_color_id: null,
      },
      {
        token: otherToken,
        object_name: `clip__${otherToken}`,
        filename: "clip.stl",
        source_layer: "Hardware",
        role: "primary",
        filament_color_id: null,
      },
    ],
  });
}

let mockWorkspace = setupWorkspace();

vi.mock("../../../queries/acceptedPlates", () => ({
  invalidateAcceptedPlateWorkspace: vi.fn(() => Promise.resolve()),
  useAcceptedPlateRevisionPending: () => false,
  useAcceptedPlateWorkspaceQuery: () => ({
    data: mockWorkspace,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useInitializeAcceptedPlatesMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(() => Promise.resolve()),
  }),
  useAcceptedPlateActionMutation: () => ({ mutateAsync: vi.fn() }),
  useMoveAcceptedPlateUnitMutation: () => ({ mutateAsync: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  mockWorkspace = setupWorkspace();
});

describe("AcceptedPlateSection assignment draft identity", () => {
  it("limits an existing workspace to the selected unassigned units", () => {
    mockWorkspace = readyWorkspace();
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <AcceptedPlateSection profileId={7} enabled selectedTokens={new Set([otherToken])} />
      </QueryClientProvider>,
    );

    expect(screen.getByText(`clip__${otherToken}`)).toBeTruthy();
    expect(screen.queryByText(`bracket__${token}`)).toBeNull();
  });

  it("preserves equal identity and resets for every accepted-basis or Plate-head change", () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const rendered = render(<AcceptedPlateSection profileId={7} enabled />, { wrapper });
    const rowPrinter = () => {
      const select = screen.getByRole("combobox", { name: "Printer" });
      if (!(select instanceof HTMLSelectElement)) throw new Error("Expected row Printer select");
      return select;
    };
    const assign = () => fireEvent.change(rowPrinter(), { target: { value: printer.id } });

    assign();
    mockWorkspace = setupWorkspace({ ...basis });
    rendered.rerender(<AcceptedPlateSection profileId={7} enabled />);
    expect(rowPrinter().value).toBe(printer.id);

    const variants = [
      setupWorkspace({ ...basis, profile_id: 8 }),
      setupWorkspace({ ...basis, plan_version: 4 }),
      setupWorkspace({ ...basis, plan_revision_id: 12 }),
      setupWorkspace({ ...basis, plan_revision_digest: "c".repeat(64) }),
      setupWorkspace({ ...basis, required_unit_mapping_digest: "d".repeat(64) }),
      setupWorkspace(basis, 23),
    ];
    for (const variant of variants) {
      mockWorkspace = setupWorkspace({ ...basis });
      rendered.rerender(<AcceptedPlateSection profileId={7} enabled />);
      assign();
      mockWorkspace = variant;
      rendered.rerender(<AcceptedPlateSection profileId={7} enabled />);
      expect(rowPrinter().value).toBe("");
    }
  });
});
