// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewPart } from "../../api/endpoints/planManifests";
import QuantityStepper from "./QuantityStepper";

function part(overrides: Partial<ReviewPart> = {}): ReviewPart {
  return {
    id: 1,
    match_key: "gear.stl",
    relative_path: "parts/gear.stl",
    filename: "gear.stl",
    source_layer: null,
    status: "active",
    role: "part",
    requirement: null,
    option_group_id: null,
    included: true,
    filament_color_id: null,
    quantity_auto: 2,
    quantity_override: null,
    quantity_effective: 2,
    print_units: [false, false],
    printed_count: 0,
    missing: true,
    filament_display: "PLA",
    ...overrides,
  };
}

describe("QuantityStepper", () => {
  afterEach(cleanup);

  it("increments and decrements from the effective quantity", () => {
    const onChange = vi.fn();

    render(<QuantityStepper part={part()} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Increase quantity for gear.stl" }));
    fireEvent.click(screen.getByRole("button", { name: "Decrease quantity for gear.stl" }));

    expect(onChange).toHaveBeenNthCalledWith(1, 3);
    expect(onChange).toHaveBeenNthCalledWith(2, 1);
  });

  it("shows when printed units exceed the edited quantity", () => {
    render(
      <QuantityStepper
        part={part({ quantity_override: 1, printed_count: 2 })}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText("2 units already printed")).toBeTruthy();
  });
});
