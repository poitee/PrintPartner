// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import MobileNavDrawer from "./MobileNavDrawer";

vi.mock("../CreatePlanButton", () => ({
  default: () => <button type="button">Create</button>,
}));
vi.mock("../PlanPicker", () => ({
  default: () => <button type="button">Plan</button>,
}));
vi.mock("../SupportCta", () => ({ default: () => null }));
vi.mock("../ThemePreferenceControl", () => ({ default: () => null }));
vi.mock("../../context/ProfileContext", () => ({
  useProfileSelection: () => ({ selectedProfileId: null }),
}));

describe("MobileNavDrawer Board link", () => {
  afterEach(() => {
    cleanup();
  });

  it("stays selected on a post path when the invite Board is on", async () => {
    render(
      <MemoryRouter initialEntries={["/board/p1"]}>
        <MobileNavDrawer
          onNavigate={() => undefined}
          sourceUpdateCount={0}
          inviteBoard
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    const link = await screen.findByRole("link", { name: "Board" });
    expect(link.getAttribute("aria-current")).toBe("page");
  });
});
