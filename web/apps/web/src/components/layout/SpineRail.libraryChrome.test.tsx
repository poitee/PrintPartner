// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import SpineRail from "./SpineRail";

vi.mock("../CreatePlanButton", () => ({
  default: () => <button type="button">Create</button>,
}));
vi.mock("../PlanPicker", () => ({
  default: () => <button type="button">Plan</button>,
}));
vi.mock("../SupportCta", () => ({ default: () => null }));
vi.mock("../WorkflowProgress", () => ({ default: () => null }));
vi.mock("../../context/ProfileContext", () => ({
  useProfileSelection: () => ({ selectedProfileId: null }),
}));

function renderRail(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SpineRail
        collapsed={false}
        onToggleCollapsed={() => undefined}
        stages={[]}
        activeId={null}
        onStageNavigate={() => undefined}
        sourceUpdateCount={0}
      />
    </MemoryRouter>,
  );
}

describe("SpineRail Source Library chrome", () => {
  afterEach(() => {
    cleanup();
  });

  it("uses carrier raised chrome when Library is off-route", () => {
    renderRail("/plan");
    const link = screen.getByRole("link", { name: "Source Library" });
    expect(link.className).toContain("bg-card");
    expect(link.className).toContain("border-border");
    expect(link.className).not.toContain("bg-primary-soft");
    expect(link.className).not.toContain("border-primary");
  });

  it("applies primary selected chrome only when Library matches the route", () => {
    renderRail("/library");
    const link = screen.getByRole("link", { name: "Source Library" });
    expect(link.className).toContain("bg-primary-soft");
    expect(link.className).toContain("text-primary");
    expect(link.className).not.toContain("border-primary");
    expect(link.className).not.toContain("bg-card");
  });
});
