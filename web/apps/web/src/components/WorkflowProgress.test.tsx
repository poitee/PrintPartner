// @vitest-environment jsdom

import type { BuildWorkflowWorkspace } from "@print-partner/contracts";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { buildWorkflowStages } from "../lib/workflowStages";
import WorkflowProgress from "./WorkflowProgress";

const workspace = {
  build: { id: 5, name: "Voron Trident" },
  sources: { kind: "ready", attached_count: 2 },
  accepted_plan: { kind: "none" },
  working_plan: { kind: "needs_attention", draft_id: 9, change_count: 102, issue_count: 5 },
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
      status: {
        kind: "needs_attention",
        summary: "5 Plan choices to finish before publishing.",
        task_count: 5,
      },
    },
    {
      id: "production",
      group: "make",
      label: "Production",
      status: {
        kind: "not_started",
        summary: "Publish a Plan to create Production's required units.",
      },
    },
    {
      id: "checkoff",
      group: "make",
      label: "Checkoff",
      status: {
        kind: "not_started",
        summary: "Publish a Plan to define the units Checkoff will verify.",
      },
    },
  ],
  next_action: {
    kind: "resolve_plan_issues",
    stage_id: "plan",
    draft_id: 9,
    issue_count: 5,
    label: "Review 5 Plan choices",
    reason: "Complete these choices before publishing the Plan for Production.",
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

describe("WorkflowProgress", () => {
  it("shows contextual stage summaries and keeps every stage navigable", () => {
    render(
      <MemoryRouter>
        <WorkflowProgress
          stages={buildWorkflowStages(workspace, 5)}
          activeId="plan"
        />
      </MemoryRouter>,
    );

    expect(screen.queryByText("Needs attention")).toBeNull();
    expect(screen.getByText("5 Plan choices to finish before publishing.")).toBeTruthy();
    expect(screen.getAllByRole("link")).toHaveLength(4);
    expect(screen.getByRole("link", {
      name: "Plan. 5 Plan choices to finish before publishing.",
    }).getAttribute("href")).toBe("/plan?profile=5");
  });
});
