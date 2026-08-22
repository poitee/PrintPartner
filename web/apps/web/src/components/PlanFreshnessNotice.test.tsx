// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PlanFreshness } from "@print-partner/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import PlanFreshnessNotice from "./PlanFreshnessNotice";

const stale = {
  status: "stale" as const,
  accepted_input_set_id: 4,
  accepted_at: "2026-08-20T12:00:00.000Z",
  reasons: [
    {
      kind: "source_revision_changed" as const,
      source_id: 2,
      source_name: "Voron Trident",
      accepted_revision_id: 7,
      current_revision_id: 8,
    },
  ],
  untracked_sources: [],
} satisfies PlanFreshness;

describe("PlanFreshnessNotice", () => {
  afterEach(cleanup);

  it("offers an intentional rebuild only on Plan", () => {
    const onRebuild = vi.fn();
    render(
      <MemoryRouter>
        <PlanFreshnessNotice freshness={stale} action={{ kind: "rebuild", onRebuild }} />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Voron Trident has a newer synced revision/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rebuild plan" }));
    expect(onRebuild).toHaveBeenCalledTimes(1);
  });

  it("links downstream surfaces to Plan and cannot rebuild", () => {
    render(
      <MemoryRouter>
        <PlanFreshnessNotice
          freshness={stale}
          action={{ kind: "review", href: "/build/4/plan" }}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("button", { name: "Rebuild plan" })).toBeNull();
    expect(screen.getByRole("link", { name: "Review in Plan" }).getAttribute("href")).toBe(
      "/build/4/plan",
    );
  });
});
