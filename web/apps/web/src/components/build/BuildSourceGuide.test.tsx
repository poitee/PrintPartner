// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import BuildSourceGuide from "./BuildSourceGuide";

afterEach(cleanup);

describe("BuildSourceGuide", () => {
  it("explains the Library, Build, and Plan handoff with working destinations", () => {
    render(
      <MemoryRouter>
        <BuildSourceGuide profileId={7} />
      </MemoryRouter>,
    );

    expect(screen.getByText("1 · Library")).toBeTruthy();
    expect(screen.getByText("2 · This Build")).toBeTruthy();
    expect(screen.getByText("3 · Plan")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Manage Source Library/ }).getAttribute("href")).toBe(
      "/library",
    );
    expect(screen.getByRole("link", { name: /Continue to Plan/ }).getAttribute("href")).toBe(
      "/plan?profile=7",
    );
  });
});
