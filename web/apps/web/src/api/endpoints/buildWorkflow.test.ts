import { describe, expect, it } from "vitest";
import { createEndpointTestHttp, jsonResponse } from "../endpointTestHttp";
import { fetchBuildWorkflowWorkspace } from "./buildWorkflow";

const workspace = {
  build: { id: 7, name: "Clockwork Dragon" },
  sources: { kind: "ready", attached_count: 2 },
  accepted_plan: {
    kind: "ready",
    revision_id: 11,
    plan_version: 3,
    total_units: 4,
    remaining_units: 4,
  },
  working_plan: { kind: "none" },
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
      status: { kind: "complete", summary: "Plan revision 3 accepted." },
    },
    {
      id: "production",
      group: "make",
      label: "Production",
      status: { kind: "ready", summary: "Production plates are ready." },
    },
    {
      id: "checkoff",
      group: "make",
      label: "Checkoff",
      status: { kind: "not_started", summary: "Waiting for print results." },
    },
  ],
  next_action: {
    kind: "prepare_production",
    stage_id: "production",
    unit_count: 4,
    label: "Prepare Production",
    reason: "4 required units remain in the Accepted Plan.",
  },
  active_work: {
    queued_jobs: 0,
    sending_jobs: 0,
    printing_jobs: 0,
    failed_jobs: 0,
    awaiting_verification: 0,
    failed_verifications: 0,
    total_units: 4,
    remaining_units: 4,
  },
};

const http = createEndpointTestHttp();

describe("Build Workflow endpoint", () => {
  it("reads and validates the shared workflow projection", async () => {
    http.respond(jsonResponse(workspace));

    await expect(fetchBuildWorkflowWorkspace(7)).resolves.toEqual(workspace);
    expect(http.calls[0]?.[0]).toBe("/plans/7/workflow");
  });

  it("rejects a response that changes the workflow order", async () => {
    http.respond(
      jsonResponse({
        ...workspace,
        stages: [...workspace.stages].reverse(),
      }),
    );

    await expect(fetchBuildWorkflowWorkspace(7)).rejects.toThrow();
  });
});
