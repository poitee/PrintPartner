// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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

  function EditableQuantity() {
    const [quantity, setQuantity] = useState(2);
    return <QuantityStepper part={part({ quantity_override: quantity })} onChange={setQuantity} />;
  }

  it("commits a typed number once on Enter, not while typing", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<QuantityStepper part={part()} onChange={onChange} />);
    const input = screen.getByRole("spinbutton", { name: "Quantity for gear.stl" });
    await user.clear(input);
    await user.type(input, "25");
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(onChange.mock.calls).toEqual([[25]]);
  });

  it("keeps typing and both step buttons synchronized", async () => {
    const user = userEvent.setup();
    render(<EditableQuantity />);
    const input = screen.getByRole("spinbutton");
    await user.clear(input);
    await user.type(input, "25");
    await user.click(screen.getByRole("button", { name: "Increase quantity for gear.stl" }));
    expect(input).toHaveProperty("value", "26");
    await user.click(screen.getByRole("button", { name: "Decrease quantity for gear.stl" }));
    expect(input).toHaveProperty("value", "25");
    await user.clear(input);
    await user.type(input, "12");
    await user.tab();
    expect(input).toHaveProperty("value", "12");
  });

  it.each(["", "0", "-1", "1.5", "10001"])("does not save invalid input %s", async (value) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<QuantityStepper part={part()} onChange={onChange} />);
    const input = screen.getByRole("spinbutton");
    await user.clear(input);
    if (value) await user.type(input, value);
    await user.tab();
    expect(onChange).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("Enter a whole number from 1 to 10,000.");
  });

  it("preserves unfinished typing across updates and lets Escape cancel it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<QuantityStepper part={part()} onChange={onChange} />);
    const input = screen.getByRole("spinbutton");
    await user.clear(input);
    await user.type(input, "25");
    rerender(<QuantityStepper part={part({ quantity_override: 3 })} onChange={onChange} />);
    expect(input).toHaveProperty("value", "25");
    await user.keyboard("{Escape}");
    await user.tab();
    expect(input).toHaveProperty("value", "3");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("honors quantity bounds and disabled controls", () => {
    const { rerender } = render(<QuantityStepper part={part({ quantity_override: 1 })} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Decrease quantity for gear.stl" }).hasAttribute("disabled")).toBe(true);
    rerender(<QuantityStepper part={part({ quantity_override: 10000 })} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Increase quantity for gear.stl" }).hasAttribute("disabled")).toBe(true);
    rerender(<QuantityStepper part={part()} onChange={vi.fn()} disabled />);
    expect(screen.getByRole("spinbutton").hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByRole("button").every((button) => button.hasAttribute("disabled"))).toBe(true);
  });

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
