// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DirectExportCard from "./DirectExportCard";

afterEach(cleanup);

describe("DirectExportCard", () => {
  it("exports an unarranged 3MF for selected units", () => {
    const onExport = vi.fn();
    render(<DirectExportCard tokenCount={2} busy={false} onExport={onExport} />);
    expect(screen.getByText("Direct export")).toBeTruthy();
    expect(screen.getByText(/unarranged named-object 3MF/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Direct 3MF" }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it("hides the download action when no Required units are selected", () => {
    render(<DirectExportCard tokenCount={0} busy={false} onExport={() => undefined} />);
    expect(screen.getByRole("button", { name: "Direct 3MF" })).toHaveProperty("disabled", true);
  });
});
