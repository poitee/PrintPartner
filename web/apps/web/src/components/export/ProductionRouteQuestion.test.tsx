// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProductionRouteQuestion from "./ProductionRouteQuestion";

afterEach(cleanup);

function renderQuestion(overrides: Partial<Parameters<typeof ProductionRouteQuestion>[0]> = {}) {
  const onSubmit = vi.fn();
  render(
    <ProductionRouteQuestion
      value={null}
      saving={false}
      error={null}
      onSubmit={onSubmit}
      {...overrides}
    />,
  );
  return { onSubmit };
}

const radio = (name: string | RegExp) => screen.getByRole("radio", { name });
/**
 * The routes are ARIA radios rather than `<input type="radio">`, so the answer
 * is read the way an assistive technology reads it.
 */
const isChosen = (name: string | RegExp) =>
  screen.getByRole("radio", { name, checked: true });

describe("ProductionRouteQuestion", () => {
  it("groups the routes under one legend and pre-selects nothing", () => {
    renderQuestion();
    expect(screen.getByText("What should PrintPartner prepare?").tagName).toBe("LEGEND");
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(screen.queryAllByRole("radio", { checked: true })).toHaveLength(0);
  });

  it("names each route with a one-line description", () => {
    renderQuestion();
    expect(radio(/Generate 3MF plates/)).toBeTruthy();
    expect(screen.getByText(/using each printer's build volume/)).toBeTruthy();
    expect(radio(/Download sorted STL files/)).toBeTruthy();
    expect(screen.getByText(/organized by color, material, part type/)).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /Add manually prepared prints/ })).toBeNull();
  });

  it("presents both preparation methods as equal choices", () => {
    renderQuestion();
    expect(screen.queryByText("or")).toBeNull();
  });

  it("uses no tabs and no step count", () => {
    renderQuestion();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByText(/step \d/i)).toBeNull();
    expect(screen.queryByText(/\bof 3\b/)).toBeNull();
  });

  it("refuses to continue with no answer and says exactly what to do", () => {
    const { onSubmit } = renderQuestion();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Select what PrintPartner should prepare")).toBeTruthy();
  });

  it("clears the error and reports the answer once a route is picked", () => {
    const { onSubmit } = renderQuestion();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(radio(/Download sorted STL files/));
    expect(screen.queryByText("Select what PrintPartner should prepare")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).toHaveBeenCalledWith("stl");
  });

  it("brings the previous answer back pre-selected on a change", () => {
    renderQuestion({ value: "plates", onCancel: vi.fn() });
    expect(isChosen(/Generate 3MF plates/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep this route" })).toBeTruthy();
  });

  it("offers no way back when there is no answer to go back to", () => {
    renderQuestion();
    expect(screen.queryByRole("button", { name: "Keep this route" })).toBeNull();
  });

  it("keeps the answer on screen after a failed save and retries in place", () => {
    const onRetry = vi.fn();
    renderQuestion({ error: { message: "Engine offline.", onRetry } });
    fireEvent.click(radio(/Generate 3MF plates/));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
    expect(isChosen(/Generate 3MF plates/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Engine offline.");
  });
});
