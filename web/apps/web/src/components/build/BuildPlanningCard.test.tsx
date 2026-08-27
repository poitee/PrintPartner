// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BuildPlanningCard from "./BuildPlanningCard";

const fetchBuildPlanningState = vi.hoisted(() => vi.fn());
vi.mock("../../api/endpoints/planManifests", async (loadOriginal) => ({
  ...(await loadOriginal<typeof import("../../api/endpoints/planManifests")>()),
  fetchBuildPlanningState,
}));

describe("BuildPlanningCard", () => {
  beforeEach(() => fetchBuildPlanningState.mockReset());

  it("shows planning provenance, uploaded artifacts, and blockers", async () => {
    fetchBuildPlanningState.mockResolvedValue({
      planning_phase: { kind: "preparing" },
      brief: {
        special_request: "Print this linked project",
        requirements: [{ key: "size", value: "350", status: "unverified" }],
        evidence: [
          {
            id: "upload",
            normalized_url: "printpartner:source:4",
            kind: "model_source",
            input_kind: "upload",
            sync_status: "synced",
            artifacts: [{ path: "project.3mf", format: "3mf", byte_size: 200 }],
          },
        ],
        contributions: [],
        role_filaments: [],
      },
      readiness: {
        ready: false,
        blockers: [{ code: "requirement_unverified", detail: "size: 350" }],
      },
      grouped_difference_count: 2,
      difference_count: 7,
    });

    render(<BuildPlanningCard planId={12} />);
    expect(
      await screen.findByRole("heading", { name: "AI Build planning" }),
    ).toBeTruthy();
    expect(screen.getByText("1 blockers")).toBeTruthy();
    expect(screen.getByText(/project\.3mf/)).toBeTruthy();
    expect(screen.getAllByText("size: 350")).toHaveLength(2);
  });

  it("shows a consumed MCP Working Plan as an Accepted Plan revision", async () => {
    fetchBuildPlanningState.mockResolvedValue({
      planning_phase: { kind: "applied", draft_id: 11, revision_id: 4 },
      brief: {
        special_request: "Print this linked project",
        requirements: [],
        evidence: [],
        contributions: [],
        role_filaments: [],
        draft_id: 11,
      },
      readiness: { ready: true, blockers: [] },
      grouped_difference_count: 0,
      difference_count: 0,
    });

    render(<BuildPlanningCard planId={12} />);
    expect(await screen.findByText("Accepted")).toBeTruthy();
    expect(screen.getByText(/Accepted as Plan revision 4/)).toBeTruthy();
    expect(screen.queryByText("Ready for Plan review")).toBeNull();
  });
});
