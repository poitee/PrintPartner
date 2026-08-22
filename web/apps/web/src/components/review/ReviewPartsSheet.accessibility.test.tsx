// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { PlanReview } from "../../api/engine";
import { REVIEW_PARTS_UI_STORAGE_KEY } from "../../lib/persistedReviewPartsUi";
import ReviewPartsSheet from "./ReviewPartsSheet";

const queryMocks = vi.hoisted(() => ({
  usePlanReviewQuery: vi.fn(() => ({ data: null })),
  usePlanWorkspace: vi.fn(),
}));

vi.mock("../../context/ProfileContext", () => ({
  useProfileSelection: () => ({ profiles: [] }),
}));
vi.mock("../../context/PlanWorkspaceContext", () => ({
  usePlanWorkspace: queryMocks.usePlanWorkspace,
}));
vi.mock("../../queries/planReview", () => ({
  usePlanReviewQuery: queryMocks.usePlanReviewQuery,
}));
vi.mock("../../queries/roleFilaments", () => ({
  useRoleFilamentsQuery: () => ({ data: [] }),
}));
vi.mock("../../hooks/useSpoolmanEnabled", () => ({
  useSpoolmanEnabled: () => ({ configured: false, integrationId: null }),
}));
vi.mock("../../hooks/useMediaQuery", () => ({
  useMediaQuery: () => false,
}));
vi.mock("../parts/PartThumbExpandButton", () => ({
  default: () => null,
}));

const review: PlanReview = {
  profile_id: 7,
  accepted_basis: null,
  plan_name: "Voron",
  layers: [],
  totals: {
    included_parts: 0,
    total_print_units: 0,
    by_role: {},
    by_filament: {},
  },
  issues: [],
  has_blockers: false,
  part_groups: [],
};

describe("ReviewPartsSheet accessibility", () => {
  beforeEach(() => {
    localStorage.clear();
    queryMocks.usePlanReviewQuery.mockClear();
    queryMocks.usePlanWorkspace.mockReturnValue({
      draftWorkspace: null,
      setQuantity: vi.fn(),
      setIncluded: vi.fn(),
      setSpoolmanSpool: vi.fn(),
      toggleUnit: vi.fn(),
      busyPartId: null,
    });
  });

  it("gives the parts search control a persistent accessible name", () => {
    render(
      <MemoryRouter>
        <ReviewPartsSheet review={review} planName="Voron" />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("searchbox", { name: "Search review parts" }).tagName,
    ).toBe("INPUT");
  });

  it("requests excluded parts without changing the workspace projection", () => {
    localStorage.setItem(
      REVIEW_PARTS_UI_STORAGE_KEY,
      JSON.stringify({ includedFilter: "excluded" }),
    );

    render(
      <MemoryRouter>
        <ReviewPartsSheet review={review} planName="Voron" />
      </MemoryRouter>,
    );

    expect(queryMocks.usePlanReviewQuery).toHaveBeenCalledWith(7, {
      includeExcluded: true,
      enabled: true,
    });
  });

  it("labels edit controls as proposed and renders saved draft values", () => {
    localStorage.setItem(
      REVIEW_PARTS_UI_STORAGE_KEY,
      JSON.stringify({ layoutMode: "table", viewMode: "edit" }),
    );
    const acceptedReview: PlanReview = {
      ...review,
      totals: { ...review.totals, included_parts: 1, total_print_units: 2 },
      part_groups: [{
        folder: "frame",
        source_layer: "base:Voron",
        parts: [{
          id: 42,
          match_key: "frame/bracket.stl",
          relative_path: "frame/bracket.stl",
          filename: "bracket.stl",
          source_layer: "base:Voron",
          status: "ok",
          role: "structural",
          requirement: null,
          option_group_id: null,
          included: true,
          filament_color_id: null,
          quantity_auto: 2,
          quantity_override: null,
          quantity_effective: 2,
          printed_count: 0,
          print_units: [false, false],
          missing: false,
          filament_display: "",
        }],
      }],
    };
    queryMocks.usePlanWorkspace.mockReturnValue({
      draftWorkspace: {
        profile_id: 7,
        draft: {
          draft_id: 9,
          state: "open",
          lifecycle_version: 0,
          snapshot_digest: "a".repeat(64),
          base: { revision_id: 3, plan_version: 1 },
        },
        parts: [{
          draft_part_id: 17,
          base_revision_part_id: 42,
          part_key: "frame/bracket.stl",
          filename: "bracket.stl",
          relative_path: "frame/bracket.stl",
          source_layer: "base:Voron",
          role: "structural",
          quantity_inferred: 2,
          quantity_override: 4,
          quantity_effective: 4,
          included: true,
        }],
        diff: { base_is_current: true, added: [], removed: [], changed: [] },
        reconciliation: { kind: "ready", reused_units: 0, new_units: 0, surplus_units: 0 },
      },
      setQuantity: vi.fn(),
      setIncluded: vi.fn(),
      setSpoolmanSpool: vi.fn(),
      toggleUnit: vi.fn(),
      busyPartId: null,
    });

    render(
      <MemoryRouter>
        <ReviewPartsSheet review={acceptedReview} planName="Voron" />
      </MemoryRouter>,
    );

    expect(screen.getByText(/controls show proposed draft values/i)).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Proposed qty" })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "Quantity for bracket.stl" }).getAttribute("value")).toBe("4");
    expect(screen.getByText(/Accepted: qty 2, included/)).toBeTruthy();
  });
});
