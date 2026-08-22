// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PlateApprovalCard from "./PlateApprovalCard";

describe("nested Export card headings", () => {
  afterEach(cleanup);

  it("uses h3 for the approval card nested inside Send to printer", () => {
    render(
      <PlateApprovalCard
        printerName="Workshop"
        plateIndex={1}
        plateTotal={1}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { level: 3, name: /Workshop/ }).tagName,
    ).toBe("H3");
  });
});
