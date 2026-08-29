import { describe, expect, it } from "vitest";
import {
  resolveBuildWorkflow,
  type BuildWorkflowFacts,
} from "./build-workflow.js";

const emptyFacts = {
  build: { id: 17, name: "Clockwork Dragon" },
  sources: { kind: "empty" },
  acceptedPlan: { kind: "none" },
  workingPlan: { kind: "none" },
  production: {
    plateState: "not_started",
    queuedJobs: 0,
    sendingJobs: 0,
    printingJobs: 0,
    failedJobs: 0,
  },
  checkoff: {
    awaitingVerification: 0,
    failedVerifications: 0,
  },
} satisfies BuildWorkflowFacts;

function stageStatus(
  workspace: ReturnType<typeof resolveBuildWorkflow>,
  stageId: "sources" | "plan" | "production" | "checkoff",
): string {
  const stage = workspace.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new Error(`Missing ${stageId} stage`);
  return stage.status.kind;
}

describe("resolveBuildWorkflow", () => {
  it("separates Preparation from the repeating Making loop", () => {
    const workspace = resolveBuildWorkflow(emptyFacts);

    expect(workspace.stages.map(({ id, group }) => ({ id, group }))).toEqual([
      { id: "sources", group: "prepare" },
      { id: "plan", group: "prepare" },
      { id: "production", group: "make" },
      { id: "checkoff", group: "make" },
    ]);
  });

  it("requires Sources before a Working Plan", () => {
    const workspace = resolveBuildWorkflow(emptyFacts);

    expect(workspace.next_action).toEqual({
      kind: "attach_sources",
      stage_id: "sources",
      label: "Attach Sources",
      reason: "This Build has no Sources yet.",
    });
    expect(stageStatus(workspace, "sources")).toBe("not_started");
    expect(stageStatus(workspace, "plan")).toBe("not_started");
  });

  it("keeps a Working Plan distinct until Plan acceptance", () => {
    const workspace = resolveBuildWorkflow({
      ...emptyFacts,
      sources: { kind: "ready", attachedCount: 3 },
      workingPlan: { kind: "ready", draftId: 41, changeCount: 6 },
    });

    expect(workspace.accepted_plan).toEqual({ kind: "none" });
    expect(workspace.working_plan).toEqual({
      kind: "ready",
      draft_id: 41,
      change_count: 6,
    });
    expect(workspace.next_action).toEqual({
      kind: "accept_working_plan",
      stage_id: "plan",
      draft_id: 41,
      label: "Review and accept Working Plan",
      reason: "The Working Plan is ready for acceptance.",
    });
  });

  it("does not stop Production for Source changes once a Plan is accepted", () => {
    const workspace = resolveBuildWorkflow({
      ...emptyFacts,
      sources: { kind: "stale", attachedCount: 3, issueCount: 2 },
      acceptedPlan: {
        kind: "ready",
        revisionId: 12,
        planVersion: 3,
        totalUnits: 8,
        remainingUnits: 3,
      },
    });

    expect(workspace.next_action).toEqual({
      kind: "prepare_production",
      stage_id: "production",
      unit_count: 3,
      label: "Prepare Production",
      reason: "3 required units remain in the Accepted Plan.",
    });
    expect(workspace.stages.find((stage) => stage.id === "sources")?.status).toEqual({
      kind: "stale",
      summary: "Sources have changed since this Plan was accepted.",
      task_count: 2,
    });
  });

  it("asks for Source review only before the first Accepted Plan", () => {
    const workspace = resolveBuildWorkflow({
      ...emptyFacts,
      sources: { kind: "stale", attachedCount: 3, issueCount: 1 },
    });

    expect(workspace.next_action).toEqual({
      kind: "review_source_changes",
      stage_id: "sources",
      issue_count: 1,
      label: "Review Source changes",
      reason: "Sources have changed. Review them before you write a Working Plan.",
    });
  });

  it("moves Source changes forward through a reviewed Working Plan", () => {
    const workspace = resolveBuildWorkflow({
      ...emptyFacts,
      sources: { kind: "stale", attachedCount: 3, issueCount: 1 },
      workingPlan: { kind: "ready", draftId: 41, changeCount: 6 },
    });

    expect(workspace.next_action.kind).toBe("accept_working_plan");
  });

  it("prioritizes verification while physical work is active", () => {
    const workspace = resolveBuildWorkflow({
      ...emptyFacts,
      sources: { kind: "ready", attachedCount: 3 },
      acceptedPlan: {
        kind: "ready",
        revisionId: 12,
        planVersion: 3,
        totalUnits: 8,
        remainingUnits: 3,
      },
      workingPlan: { kind: "ready", draftId: 41, changeCount: 2 },
      production: {
        plateState: "ready",
        queuedJobs: 0,
        sendingJobs: 0,
        printingJobs: 0,
        failedJobs: 0,
      },
      checkoff: {
        awaitingVerification: 2,
        failedVerifications: 0,
      },
    });

    expect(workspace.next_action).toEqual({
      kind: "verify_prints",
      stage_id: "checkoff",
      item_count: 2,
      label: "Verify print results",
      reason: "2 print results are waiting for verification.",
    });
  });

  it("does not call Production complete just because a Plan has required units", () => {
    const workspace = resolveBuildWorkflow({
      ...emptyFacts,
      sources: { kind: "ready", attachedCount: 3 },
      acceptedPlan: {
        kind: "ready",
        revisionId: 12,
        planVersion: 3,
        totalUnits: 4,
        remainingUnits: 4,
      },
      production: {
        plateState: "ready",
        queuedJobs: 0,
        sendingJobs: 0,
        printingJobs: 0,
        failedJobs: 0,
      },
    });

    expect(stageStatus(workspace, "production")).toBe("ready");
    expect(stageStatus(workspace, "checkoff")).toBe("not_started");
    expect(workspace.next_action).toEqual({
      kind: "prepare_production",
      stage_id: "production",
      unit_count: 4,
      label: "Prepare Production",
      reason: "4 required units remain in the Accepted Plan.",
    });
  });

  it("finishes only after all Accepted Plan units are checked off", () => {
    const workspace = resolveBuildWorkflow({
      ...emptyFacts,
      sources: { kind: "ready", attachedCount: 3 },
      acceptedPlan: {
        kind: "ready",
        revisionId: 12,
        planVersion: 3,
        totalUnits: 4,
        remainingUnits: 0,
      },
      production: {
        plateState: "ready",
        queuedJobs: 0,
        sendingJobs: 0,
        printingJobs: 0,
        failedJobs: 0,
      },
    });

    expect(stageStatus(workspace, "production")).toBe("complete");
    expect(stageStatus(workspace, "checkoff")).toBe("complete");
    expect(workspace.next_action).toEqual({
      kind: "view_completed_build",
      stage_id: "checkoff",
      label: "View completed Build",
      reason: "Every required unit in the Accepted Plan is checked off.",
    });
  });
});
