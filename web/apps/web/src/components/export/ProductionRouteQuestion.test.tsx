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

describe("ProductionRouteQuestion", () => {
  it("groups the routes under one legend and pre-selects nothing", () => {
    renderQuestion();
    expect(screen.getByText("How do you want to make these units?").tagName).toBe("LEGEND");
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    for (const option of radios) expect((option as HTMLInputElement).checked).toBe(false);
  });

  it("names each route with a one-line description", () => {
    renderQuestion();
    expect(radio(/Make Plates for my printers/)).toBeTruthy();
    expect(screen.getByText(/Choose printers, group the Required units/)).toBeTruthy();
    expect(radio(/Download the unit files/)).toBeTruthy();
    expect(screen.getByText(/No Plates, no printers/)).toBeTruthy();
    expect(radio(/Record a print made elsewhere/)).toBeTruthy();
    expect(screen.getByText(/upload G-code, binary G-code or a 3MF file/)).toBeTruthy();
  });

  it("separates the differently phrased route with an or divider", () => {
    renderQuestion();
    expect(screen.getByText("or")).toBeTruthy();
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
    expect(screen.getByText("Select how you want to make these units")).toBeTruthy();
  });

  it("clears the error and reports the answer once a route is picked", () => {
    const { onSubmit } = renderQuestion();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(radio(/Download the unit files/));
    expect(screen.queryByText("Select how you want to make these units")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).toHaveBeenCalledWith("stl");
  });

  it("brings the previous answer back pre-selected on a change", () => {
    renderQuestion({ value: "external", onCancel: vi.fn() });
    expect((radio(/Record a print made elsewhere/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "Keep this route" })).toBeTruthy();
  });

  it("offers no way back when there is no answer to go back to", () => {
    renderQuestion();
    expect(screen.queryByRole("button", { name: "Keep this route" })).toBeNull();
  });

  it("keeps the answer on screen after a failed save and retries in place", () => {
    const onRetry = vi.fn();
    renderQuestion({ error: { message: "Engine offline.", onRetry } });
    fireEvent.click(radio(/Make Plates for my printers/));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
    expect((radio(/Make Plates for my printers/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("Engine offline.");
  });
});
