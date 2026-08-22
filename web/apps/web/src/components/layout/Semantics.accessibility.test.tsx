// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import PageHeader from "./PageHeader";
import SpineRail from "./SpineRail";

vi.mock("../CreatePlanButton", () => ({ default: () => <button type="button">Create plan</button> }));
vi.mock("../PlanPicker", () => ({ default: () => <button type="button">Switch plan</button> }));
vi.mock("../SupportCta", () => ({ default: () => null }));
vi.mock("../ThemePreferenceControl", () => ({ default: () => null }));
vi.mock("../WorkflowProgress", () => ({ default: () => null }));
vi.mock("../../context/ProfileContext", () => ({
  useProfileSelection: () => ({ selectedProfileId: null }),
}));

describe("page heading hierarchy", () => {
  it("uses the routed page title as the only h1 instead of the shell brand", () => {
    render(
      <MemoryRouter>
        <SpineRail
          collapsed={false}
          onToggleCollapsed={vi.fn()}
          stages={[]}
          activeId={null}
          onStageNavigate={vi.fn()}
        />
        <PageHeader title="Plans" />
      </MemoryRouter>,
    );

    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe("Plans");
    expect(screen.getByText("Print Partner").tagName).not.toBe("H1");
  });
});
