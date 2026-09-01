import { describe, expect, it } from "vitest";
import type { BuildWorkflowWorkspace } from "@print-partner/contracts";
import { buildActiveWorkChips, buildSummaryLine } from "./buildSummaryModel";

function workspace(
  overrides: Partial<BuildWorkflowWorkspace> = {},
): BuildWorkflowWorkspace {
  return {
    build: { id: 1, name: "Voron 2.4 Workshop" },
    sources: { kind: "ready", attached_count: 1 },
    accepted_plan: {
      kind: "ready",
      revision_id: 4,
      plan_version: 4,
      total_units: 18,
      remaining_units: 7,
    },
    working_plan: { kind: "none" },
    stages: [
      { id: "sources", group: "prepare", label: "Sources", status: { kind: "complete", summary: "1 Source attached." } },
      { id: "plan", group: "prepare", label: "Plan", status: { kind: "complete", summary: "Plan revision 4 accepted." } },
      { id: "production", group: "make", label: "Production", status: { kind: "ready", summary: "7 required units ready for Production." } },
      { id: "checkoff", group: "make", label: "Checkoff", status: { kind: "in_progress", summary: "11 of 18 required units checked off.", active_count: 11 } },
    ],
    next_action: {
      kind: "prepare_production",
      stage_id: "production",
      unit_count: 7,
      label: "Prepare Production",
      reason: "7 required units remain in the Accepted Plan.",
    },
    active_work: {
      queued_jobs: 0,
      sending_jobs: 0,
      printing_jobs: 0,
      failed_jobs: 0,
      awaiting_verification: 0,
      failed_verifications: 0,
      total_units: 18,
      remaining_units: 7,
    },
    ...overrides,
  } as BuildWorkflowWorkspace;
}

describe("buildSummaryLine", () => {
  it("reports the accepted revision with unit counts", () => {
    expect(buildSummaryLine(workspace())).toEqual({
      facts: ["Plan revision 4 accepted", "18 Required units", "11 verified"],
      hasUnacceptedChanges: false,
    });
  });

  it("replaces unit counts with the working change count", () => {
    const summary = buildSummaryLine(
      workspace({ working_plan: { kind: "ready", draft_id: 9, change_count: 7 } }),
    );
    expect(summary.facts).toEqual([
      "Plan revision 4 accepted",
      "7 working changes not yet accepted",
    ]);
    expect(summary.hasUnacceptedChanges).toBe(true);
  });

  it("names an unresolved working Plan without claiming it is ready", () => {
    const summary = buildSummaryLine(
      workspace({
        working_plan: { kind: "needs_attention", draft_id: 9, change_count: 7, issue_count: 2 },
      }),
    );
    expect(summary.facts[1]).toBe("2 working Plan issues to resolve");
    expect(summary.hasUnacceptedChanges).toBe(false);
  });

  it("says when no Plan revision is accepted yet", () => {
    const summary = buildSummaryLine(
      workspace({
        accepted_plan: { kind: "none" },
        active_work: { ...workspace().active_work, total_units: 0, remaining_units: 0 },
      }),
    );
    expect(summary.facts).toEqual(["No accepted Plan revision"]);
  });

  it("uses singular wording for one unit", () => {
    const summary = buildSummaryLine(
      workspace({
        active_work: { ...workspace().active_work, total_units: 1, remaining_units: 0 },
      }),
    );
    expect(summary.facts).toContain("1 Required unit");
  });
});

describe("buildActiveWorkChips", () => {
  it("is empty when nothing is running", () => {
    expect(buildActiveWorkChips(workspace())).toEqual([]);
  });

  it("orders failures before waiting work and queued work", () => {
    const chips = buildActiveWorkChips(
      workspace({
        active_work: {
          queued_jobs: 3,
          sending_jobs: 1,
          printing_jobs: 2,
          failed_jobs: 1,
          awaiting_verification: 4,
          failed_verifications: 2,
          total_units: 18,
          remaining_units: 7,
        },
      }),
    );
    expect(chips.map((chip) => chip.id)).toEqual([
      "failed_verifications",
      "failed_jobs",
      "awaiting_verification",
      "printing_jobs",
      "sending_jobs",
      "queued_jobs",
    ]);
    expect(chips[0]).toEqual({
      id: "failed_verifications",
      label: "2 failed prints",
      tone: "error",
    });
  });

  it("names Source updates as next-Plan context, not as a current-Plan warning", () => {
    const chips = buildActiveWorkChips(
      workspace({
        sources: { kind: "stale", attached_count: 2, issue_count: 1 },
      }),
    );
    expect(chips).toEqual([
      {
        id: "source_changes",
        label: "Source updates available for the next Plan",
        tone: "neutral",
      },
    ]);
  });

  it("carries its own text so tone never stands alone", () => {
    const chips = buildActiveWorkChips(
      workspace({
        active_work: { ...workspace().active_work, printing_jobs: 1 },
      }),
    );
    expect(chips).toEqual([{ id: "printing_jobs", label: "1 printing", tone: "info" }]);
  });
});
