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
  };
}

describe("buildSummaryLine", () => {
  it("reports only printed and remaining counts", () => {
    expect(buildSummaryLine(workspace())).toEqual({
      facts: ["11 of 18 printed", "7 remaining"],
    });
  });

  it("keeps internal working changes out of the progress summary", () => {
    const summary = buildSummaryLine(
      workspace({ working_plan: { kind: "ready", draft_id: 9, change_count: 7 } }),
    );
    expect(summary.facts).toEqual([
      "11 of 18 printed",
      "7 remaining",
    ]);
  });

  it("does not turn internal draft issues into a production status report", () => {
    const summary = buildSummaryLine(
      workspace({
        working_plan: { kind: "needs_attention", draft_id: 9, change_count: 7, issue_count: 2 },
      }),
    );
    expect(summary.facts).toEqual(["11 of 18 printed", "7 remaining"]);
  });

  it("omits the empty revision report", () => {
    const summary = buildSummaryLine(
      workspace({
        accepted_plan: { kind: "none" },
        active_work: { ...workspace().active_work, total_units: 0, remaining_units: 0 },
      }),
    );
    expect(summary.facts).toEqual([]);
  });

  it("uses singular wording for one unit", () => {
    const summary = buildSummaryLine(
      workspace({
        active_work: { ...workspace().active_work, total_units: 1, remaining_units: 0 },
      }),
    );
    expect(summary.facts).toContain("1 of 1 printed");
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

  it("keeps source bookkeeping out of active print work", () => {
    const chips = buildActiveWorkChips(
      workspace({
        sources: { kind: "stale", attached_count: 2, issue_count: 1 },
      }),
    );
    expect(chips).toEqual([]);
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
