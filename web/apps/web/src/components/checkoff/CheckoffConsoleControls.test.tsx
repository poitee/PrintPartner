// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCheckoffAttentionItems } from "../../lib/checkoffConsoleModel";
import CheckoffAttentionSummary from "./CheckoffAttentionSummary";
import CheckoffCompletionCard from "./CheckoffCompletionCard";
import CheckoffCorrectionDialog from "./CheckoffCorrectionDialog";
import CheckoffPrintSheetButton from "./CheckoffPrintSheetButton";
import CheckoffViewTabs from "./CheckoffViewTabs";

describe("CheckoffPrintSheetButton", () => {
  afterEach(cleanup);

  it("keeps the paper layout inside the Print sheet action", () => {
    const onPrint = vi.fn();
    render(
      <CheckoffPrintSheetButton
        layout={{ compactMode: false, continuousPrintLayout: false, textOnlyPrint: false }}
        onLayoutChange={vi.fn()}
        onPrint={onPrint}
      />,
    );

    expect(screen.queryByLabelText("Compact rows")).toBeNull();
    expect(screen.queryByLabelText("Text only, no thumbnails")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Print sheet" }));
    expect(onPrint).toHaveBeenCalledOnce();
  });
});

describe("CheckoffViewTabs", () => {
  afterEach(cleanup);

  it("states each view count in text", () => {
    const onValueChange = vi.fn();
    render(
      <CheckoffViewTabs
        value="attention"
        counts={{ attention: 2, remaining: 20, completed: 2 }}
        onValueChange={onValueChange}
      />,
    );

    const attention = screen.getByRole("button", { name: /^Needs attention/ });
    expect(attention.getAttribute("aria-pressed")).toBe("true");
    expect(attention.textContent).toContain("2");

    fireEvent.click(screen.getByRole("button", { name: /^Remaining/ }));
    expect(onValueChange).toHaveBeenCalledWith("remaining");
  });
});

describe("CheckoffCorrectionDialog", () => {
  afterEach(cleanup);

  it("blocks the correction until a reason explains the printer history", () => {
    const onConfirm = vi.fn();
    render(
      <CheckoffCorrectionDialog
        target={{
          partId: 1,
          filename: "gantry.stl",
          printedCount: 2,
          impact: { printerHistory: true, materialDeduction: false },
        }}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(
      "Choose why you are correcting this unit",
    );

    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "recount" } });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    expect(onConfirm).toHaveBeenCalledWith({ reason: "recount", note: "" });
  });

  it("lets a plain mis-tap be undone with no form", () => {
    const onConfirm = vi.fn();
    render(
      <CheckoffCorrectionDialog
        target={{
          partId: 1,
          filename: "gantry.stl",
          printedCount: 1,
          impact: { printerHistory: false, materialDeduction: false },
        }}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    expect(onConfirm).toHaveBeenCalledWith({ reason: null, note: "" });
  });
});

describe("CheckoffAttentionSummary", () => {
  afterEach(cleanup);

  it("names the state and the printer for every waiting result", () => {
    render(
      <CheckoffAttentionSummary
        items={buildCheckoffAttentionItems({
          awaitingLinks: [
            {
              id: "link-1",
              host_name: "Core One",
              filename: "gantry.bgcode",
              units: [{ part_id: 1, unit_index: 0 }],
            },
          ],
          failedLinks: [],
          unattributedPrints: [
            { id: "print-1", host_name: "Voron A", filename: "cube.gcode" },
          ],
        })}
      />,
    );

    expect(screen.getByText("Needs verification")).toBeTruthy();
    expect(screen.getByText("Needs your decision")).toBeTruthy();
    expect(screen.getByText(/Core One finished 1 unit/)).toBeTruthy();
  });
});

describe("CheckoffCompletionCard", () => {
  afterEach(cleanup);

  it("gives the reference and the next actions of a finished Build", () => {
    render(
      <MemoryRouter>
        <CheckoffCompletionCard
          buildName="Voron 2.4 Workshop"
          totalUnits={22}
          partCount={6}
          completedAt="2026-08-27T10:00:00.000Z"
          planVersion={4}
          revisionId={12}
          planHref="/plan?profile=1"
          productionHref="/export?profile=1"
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: "Voron 2.4 Workshop is fully checked off" }),
    ).toBeTruthy();
    expect(screen.getByText("Plan revision 4 accepted")).toBeTruthy();
    expect(screen.getByText(/^Completed /)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review the Accepted Plan" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Print more units" })).toBeTruthy();
  });
});
