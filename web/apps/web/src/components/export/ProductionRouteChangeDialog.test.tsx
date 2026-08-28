// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductionRouteChange } from "../../lib/workPackageProjection";
import ProductionRouteChangeDialog from "./ProductionRouteChangeDialog";

afterEach(cleanup);

const platesToStl: ProductionRouteChange = {
  from: "plates",
  to: "stl",
  setAside: [
    "Plate revision 3, 4 Plates",
    "Printer assignments for 12 Required units",
    "1 exported 3MF file",
  ],
  kept: ["Your 12 chosen Required units"],
  confirm: true,
};

function renderDialog(overrides: Partial<Parameters<typeof ProductionRouteChangeDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ProductionRouteChangeDialog
      change={platesToStl}
      saving={false}
      error={null}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel };
}

describe("ProductionRouteChangeDialog", () => {
  it("stays closed when no switch is waiting", () => {
    renderDialog({ change: null });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names both routes in the question", () => {
    renderDialog();
    expect(
      screen.getByRole("heading", {
        name: 'Change route from "Make Plates for my printers" to "Download the unit files"?',
      }),
    ).toBeTruthy();
  });

  it("names what the work package steps away from, in text", () => {
    renderDialog();
    expect(screen.getByText("This work package will stop using:")).toBeTruthy();
    for (const line of platesToStl.setAside) expect(screen.getByText(line)).toBeTruthy();
    expect(screen.getByText("It will keep:")).toBeTruthy();
    expect(screen.getByText("Your 12 chosen Required units")).toBeTruthy();
    expect(screen.getByText("Verified units in Checkoff are not affected.")).toBeTruthy();
  });

  it("says the work is recoverable, because it is", () => {
    renderDialog();
    expect(
      screen.getByText(
        /Nothing is deleted\. Change back to .Make Plates for my printers. and this work is still here\./,
      ),
    ).toBeTruthy();
  });

  it("names the destination in the button the operator presses", () => {
    const { onConfirm } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: 'Change to "Download the unit files"' }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("offers a way out that changes nothing", () => {
    const { onCancel, onConfirm } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Keep this route" }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows a failed change inline and keeps the dialog open", () => {
    renderDialog({ error: "Could not save: engine offline." });
    expect(screen.getByRole("alert").textContent).toContain("engine offline");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("drops the stop-using list when there is nothing to step away from", () => {
    renderDialog({
      change: { from: "stl", to: "plates", setAside: [], kept: ["Your 4 chosen Required units"], confirm: false },
    });
    expect(screen.queryByText("This work package will stop using:")).toBeNull();
    expect(screen.getByText("Your 4 chosen Required units")).toBeTruthy();
  });
});
