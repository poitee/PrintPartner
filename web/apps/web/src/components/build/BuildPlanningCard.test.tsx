// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BuildPlanningCard from "./BuildPlanningCard";

const fetchBuildPlanningState = vi.hoisted(() => vi.fn());
vi.mock("../../api/endpoints/planManifests", async (loadOriginal) => ({
  ...(await loadOriginal<typeof import("../../api/endpoints/planManifests")>()),
  fetchBuildPlanningState,
}));
vi.mock("../../queries/buildWorkflow", () => ({
  useBuildWorkflowQuery: () => ({ data: undefined }),
}));

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BuildPlanningCard planId={12} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("BuildPlanningCard", () => {
  beforeEach(() => fetchBuildPlanningState.mockReset());
  afterEach(() => cleanup());

  it("summarises the proposal in human words and lists its decisions", async () => {
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

    renderCard();

    expect(
      await screen.findByRole("heading", { name: "AI MCP Server changes" }),
    ).toBeTruthy();
    expect(screen.getByText("1 decision needed")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Decisions the AI MCP Server needs" }),
    ).toBeTruthy();
    expect(screen.queryByText(/the assistant/i)).toBeNull();
    expect(
      screen.getByText(/2 file choices and 1 requirement to confirm/),
    ).toBeTruthy();
    expect(screen.getByText(/project\.3mf/)).toBeTruthy();
    expect(screen.getAllByText("size: 350")).toHaveLength(2);
  });

  it("names an accepted revision instead of a second kind of draft", async () => {
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

    renderCard();

    expect(await screen.findByText("Applied")).toBeTruthy();
    expect(screen.getByText(/Accepted as Plan revision 4/)).toBeTruthy();
    expect(screen.queryByText("Ready for Plan review")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Open Plan to review the Working Plan" })
        .getAttribute("href"),
    ).toBe("/plan?profile=12");
  });

  it("keeps missing-draft copy on the AI MCP Server", async () => {
    fetchBuildPlanningState.mockResolvedValue({
      planning_phase: { kind: "missing_draft", draft_id: 11 },
      brief: {
        special_request: "",
        requirements: [],
        evidence: [],
        contributions: [],
        role_filaments: [],
      },
      readiness: { ready: true, blockers: [] },
      grouped_difference_count: 0,
      difference_count: 0,
    });

    renderCard();

    expect(await screen.findByText("Working Plan unavailable")).toBeTruthy();
    expect(
      screen.getByText(/Working Plan from the connected AI MCP Server is no longer available/),
    ).toBeTruthy();
    expect(screen.queryByText(/the assistant/i)).toBeNull();
  });
});
