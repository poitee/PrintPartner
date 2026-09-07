// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import AllCopiesCheckbox from "./AllCopiesCheckbox";

afterEach(cleanup);

it.each([0, 2, 4])("reflects %i of four copies and changes all copies", (printedCount) => {
  const onChange = vi.fn();
  render(<AllCopiesCheckbox filename="clip.stl" quantity={4} printedCount={printedCount} disabled={false} onChange={onChange} />);
  const checkbox = screen.getByRole("checkbox", { name: "All copies printed for clip.stl" });
  expect(checkbox.getAttribute("aria-checked")).toBe(printedCount === 4 ? "true" : printedCount === 0 ? "false" : "mixed");
  fireEvent.click(checkbox);
  expect(onChange).toHaveBeenCalledExactlyOnceWith(printedCount !== 4);
});

it.each([{ quantity: 4, disabled: true }, { quantity: 0, disabled: false }])("does not change unavailable quantities", ({ quantity, disabled }) => {
  const onChange = vi.fn();
  render(<AllCopiesCheckbox filename="clip.stl" quantity={quantity} printedCount={0} disabled={disabled} onChange={onChange} />);
  fireEvent.click(screen.getByRole("checkbox"));
  expect(onChange).not.toHaveBeenCalled();
});
