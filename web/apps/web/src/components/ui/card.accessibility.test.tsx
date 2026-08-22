// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CardTitle } from "./card";

describe("CardTitle semantics", () => {
  afterEach(cleanup);

  it("defaults card sections to the level below a page heading", () => {
    render(<CardTitle>Print settings</CardTitle>);

    expect(screen.getByRole("heading", { level: 2, name: "Print settings" }).tagName).toBe(
      "H2",
    );
  });

  it("allows nested cards to select a deeper heading level", () => {
    render(<CardTitle level={4}>Plate 1</CardTitle>);

    expect(
      screen.getByRole("heading", { level: 4, name: "Plate 1" }).tagName,
    ).toBe("H4");
  });

  it("composes CardTitle styling onto an explicit semantic heading", () => {
    render(
      <CardTitle asChild>
        <h1>Print Partner</h1>
      </CardTitle>,
    );

    const title = screen.getByRole("heading", { level: 1, name: "Print Partner" });
    expect(title.parentElement?.querySelector("h3")).toBeNull();
    expect(title.classList.contains("font-semibold")).toBe(true);
  });
});
