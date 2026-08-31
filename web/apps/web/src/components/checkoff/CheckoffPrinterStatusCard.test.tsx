// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import CheckoffPrinterStatusCard from "./CheckoffPrinterStatusCard";

afterEach(cleanup);

describe("CheckoffPrinterStatusCard", () => {
  it("keeps printer context and recovery actions visible", () => {
    const onAddPastPrint = vi.fn();
    render(
      <MemoryRouter>
        <CheckoffPrinterStatusCard
          printingJobs={2}
          queuedJobs={1}
          failedJobs={0}
          printersRoute="/printers"
          onAddPastPrint={onAddPastPrint}
        >
          <p>Voron is printing bracket.gcode</p>
        </CheckoffPrinterStatusCard>
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Printer activity" })).toBeTruthy();
    expect(screen.getByText(/missed or printed elsewhere/)).toBeTruthy();
    expect(screen.getByText("Voron is printing bracket.gcode")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open all printers" }).getAttribute("href"))
      .toBe("/printers");

    fireEvent.click(screen.getByRole("button", { name: "Add a past print" }));
    expect(onAddPastPrint).toHaveBeenCalledOnce();
  });
});
