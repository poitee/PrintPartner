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

    const increase = onChange.mock.calls[0]?.[0] as (
      currentQuantity: number,
    ) => number;
    const decrease = onChange.mock.calls[1]?.[0] as (
      currentQuantity: number,
    ) => number;
    expect(increase(2)).toBe(3);
    expect(decrease(2)).toBe(1);
  });

  it("applies rapid steps in click order before the parent rerenders", () => {
    const onChange = vi.fn<
      (quantity: number | ((currentQuantity: number) => number)) => void
    >();

    render(<QuantityStepper part={part()} onChange={onChange} />);

    const increase = screen.getByRole("button", {
      name: "Increase quantity for gear.stl",
    });
    fireEvent.click(increase);
    fireEvent.click(increase);
    fireEvent.click(increase);

    const quantity = onChange.mock.calls.reduce((current, [update]) => {
      return typeof update === "function" ? update(current) : update;
    }, 2);
    expect(quantity).toBe(5);
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
