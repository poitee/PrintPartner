// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewPart } from "../../api/endpoints/planManifests";
import type { ProgressRowRef } from "../../lib/progressListOrder";
import { NO_CHECKOFF_ROW_ERRORS } from "../../lib/checkoffConsoleRowErrors";
import CheckoffWorklist from "./CheckoffWorklist";

vi.mock("../parts/PartThumbExpandButton", () => ({
  default: ({ part }: { part: { filename: string } }) => (
    <button type="button">Preview {part.filename}</button>
  ),
}));

function part(id: number, filename: string, printed = 0): ReviewPart {
  return {
    id,
    match_key: filename,
    relative_path: `parts/${filename}`,
    filename,
    source_layer: "base:kit",
    status: "ok",
    role: "primary",
    requirement: null,
    option_group_id: null,
    included: true,
    filament_color_id: null,
    filament_display: null,
    quantity_auto: 2,
    quantity_override: null,
    quantity_effective: 2,
    print_units: [printed > 0, printed > 1],
    printed_count: printed,
    missing: printed < 2,
  } as unknown as ReviewPart;
}

const parts = [part(1, "gantry.stl"), part(2, "belt.stl"), part(3, "idler.stl")];
const rows: ProgressRowRef[] = parts.map((p) => ({ kind: "part" as const, id: p.id }));
const partsById = new Map(parts.map((p) => [p.id, p]));

function renderWorklist(overrides: Partial<React.ComponentProps<typeof CheckoffWorklist>> = {}) {
  const onReorder = vi.fn();
  const props: React.ComponentProps<typeof CheckoffWorklist> = {
    rows,
    partsById,
    mobile: false,
    busyPartId: null,
    toggleBusy: false,
    assemblyTrackingEnabled: false,
    printingPartIds: new Map(),
    awaitingPartIds: new Map(),
    suggestedPartIds: new Map(),
    rowErrors: NO_CHECKOFF_ROW_ERRORS,
    correctionsByPart: new Map(),
    reorderable: true,
    emptyState: <p>Nothing here</p>,
    onReorder,
    onMoveTo: vi.fn(),
    onToggleUnit: vi.fn(),
    onIncrement: vi.fn(),
    onDecrement: vi.fn(),
    onPreview: vi.fn(),
    onClaim: vi.fn(),
    onToggleAssembled: vi.fn(),
    onRetryRow: vi.fn(),
    onBagLabelChange: vi.fn(),
    onRemoveBagBar: vi.fn(),
    ...overrides,
  };
  render(<CheckoffWorklist {...props} />);
  return props;
}

describe("CheckoffWorklist ordering without a drag", () => {
  afterEach(cleanup);

  it("moves a row down with a single click", () => {
    const props = renderWorklist();

    fireEvent.click(
      screen.getByRole("button", { name: "Move gantry.stl down. Position 1 of 3" }),
    );

    expect(props.onReorder).toHaveBeenCalledWith([
      { kind: "part", id: 2 },
      { kind: "part", id: 1 },
      { kind: "part", id: 3 },
    ]);
  });

  it("moves a row up with a single click", () => {
    const props = renderWorklist();

    fireEvent.click(
      screen.getByRole("button", { name: "Move idler.stl up. Position 3 of 3" }),
    );

    expect(props.onReorder).toHaveBeenCalledWith([
      { kind: "part", id: 1 },
      { kind: "part", id: 3 },
      { kind: "part", id: 2 },
    ]);
  });

  it("disables the move that would run off the end of the list", () => {
    renderWorklist();

    expect(
      screen.getByRole("button", { name: "Move gantry.stl up. Position 1 of 3" }),
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByRole("button", { name: "Move idler.stl down. Position 3 of 3" }),
    ).toHaveProperty("disabled", true);
  });

  it("hides the move controls where the list cannot be reordered", () => {
    renderWorklist({ reorderable: false });

    expect(screen.queryByRole("button", { name: /^Move gantry\.stl/ })).toBeNull();
  });

  it("shows the empty state when no row is visible", () => {
    renderWorklist({ rows: [] });

    expect(screen.getByText("Nothing here")).toBeTruthy();
  });

  it("leads each phone row with one large primary action and a menu", () => {
    renderWorklist({ mobile: true });

    const primary = screen.getByRole("button", {
      name: "Mark one gantry.stl printed. 0 of 2 printed",
    });
    expect(primary.className).toContain("h-12");
    expect(screen.getByRole("button", { name: "More actions for gantry.stl" })).toBeTruthy();
  });

  it("keeps a failed change on its own row with a retry", () => {
    const props = renderWorklist({
      rowErrors: {
        "part:2": {
          message: "Could not save the printed count for belt.stl: offline",
          retryLabel: "Retry",
          at: "2026-08-27T10:00:00.000Z",
        },
      },
    });

    expect(
      screen.getByText("Could not save the printed count for belt.stl: offline"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(props.onRetryRow).toHaveBeenCalledWith(2);
  });
});
