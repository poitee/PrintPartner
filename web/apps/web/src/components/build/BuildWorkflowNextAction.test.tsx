// @vitest-environment jsdom

import type { BuildWorkflowWorkspace } from "@print-partner/contracts";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import BuildWorkflowNextAction from "./BuildWorkflowNextAction";

const workspace = {
  build: { id: 7, name: "Clockwork Dragon" },
  sources: { kind: "ready", attached_count: 2 },
  accepted_plan: { kind: "none" },
  working_plan: { kind: "ready", draft_id: 9, change_count: 4 },
  stages: [
    {
      id: "sources",
      group: "prepare",
      label: "Sources",
      status: { kind: "complete", summary: "2 Sources attached." },
    },
    {
      id: "plan",
      group: "prepare",
      label: "Plan",
      status: { kind: "ready", summary: "Working Plan has 4 changes to review." },
    },
    {
      id: "production",
      group: "make",
      label: "Production",
      status: {
        kind: "not_started",
        summary: "Accept a Working Plan before Production.",
      },
    },
    {
      id: "checkoff",
      group: "make",
      label: "Checkoff",
      status: {
        kind: "not_started",
        summary: "Accept a Working Plan before Checkoff.",
      },
    },
  ],
  next_action: {
    kind: "accept_working_plan",
    stage_id: "plan",
    draft_id: 9,
    label: "Review and accept Working Plan",
    reason: "The Working Plan is ready for acceptance.",
  },
  active_work: {
    queued_jobs: 0,
    sending_jobs: 0,
    printing_jobs: 0,
    failed_jobs: 0,
    awaiting_verification: 0,
    failed_verifications: 0,
    total_units: 0,
    remaining_units: 0,
  },
} satisfies BuildWorkflowWorkspace;

vi.mock("../../context/ProfileContext", () => ({
  useProfileSelection: () => ({ selectedProfileId: 7 }),
}));

vi.mock("../../queries/buildWorkflow", () => ({
  useBuildWorkflowQuery: () => ({ data: workspace }),
}));

describe("BuildWorkflowNextAction", () => {
  it("uses the shared action and links to its owning workspace", () => {
    render(
      <MemoryRouter>
        <BuildWorkflowNextAction currentStageId="sources" />
      </MemoryRouter>,
    );

    expect(screen.getByText("Review and accept Working Plan")).toBeTruthy();
    expect(screen.getByText("The Working Plan is ready for acceptance.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Plan" }).getAttribute("href")).toBe(
      "/plan?profile=7",
    );
  });
});
