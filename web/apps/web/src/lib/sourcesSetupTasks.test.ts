import { describe, expect, it } from "vitest";
import {
  assistantChangeSummary,
  sourcesSetupTasks,
  workingPlanUpdateReason,
  type SourcesSetupInput,
  type SourcesSetupTaskId,
} from "./sourcesSetupTasks";

const baseSource = {
  id: 1,
  name: "Voron 2.4 LDO Kit",
  layerType: "base",
  synced: true,
  updatesAvailable: false,
} as const;

function input(overrides: Partial<SourcesSetupInput> = {}): SourcesSetupInput {
  return {
    buildId: 1,
    specialRequest: null,
    sources: [baseSource],
    partCount: 6,
    reviewIssues: [],
    mergeConflictCount: 0,
    roleFilaments: [],
    freshness: { status: "current" },
    planning: null,
    syncing: false,
    updatingWorkingPlan: false,
    ...overrides,
  };
}

function ids(setup: ReturnType<typeof sourcesSetupTasks>): SourcesSetupTaskId[] {
  return setup.tasks.map((task) => task.id);
}

describe("sourcesSetupTasks", () => {
  it("routes to Plan review when every input is ready", () => {
    const setup = sourcesSetupTasks(input());

    expect(setup.ready).toBe(true);
    expect(setup.primary).toEqual({
      label: "Review Working Plan",
      reason: "The inputs are ready. Review and accept the Plan.",
      action: { kind: "route", label: "Review Working Plan", to: "/plan?profile=1" },
    });
  });

  it("keeps the listed setup order and drops tasks that do not apply", () => {
    const setup = sourcesSetupTasks(
      input({
        sources: [baseSource, { ...baseSource, id: 2, name: "Mods", layerType: "addon" }],
        roleFilaments: [{ role: "primary", part_count: 3, filament_color_id: null }],
        planning: {
          planning_phase: { kind: "preparing" },
          readiness: { ready: false, blockers: [{ code: "source_role", detail: "pick a role" }] },
          grouped_difference_count: 3,
        },
        freshness: {
          status: "untracked",
          reasons: [{ kind: "source_revision_untracked", source_name: "Mods" }],
        },
      }),
    );

    expect(ids(setup)).toEqual([
      "confirm-request",
      "attach-base",
      "attach-optional",
      "sync-sources",
      "resolve-differences",
      "assign-colors",
      "review-assistant",
      "update-working-plan",
    ]);
  });

  it("hides the optional-source and difference tasks before a base source exists", () => {
    const setup = sourcesSetupTasks(input({ sources: [], partCount: 0 }));

    expect(ids(setup)).toEqual(["confirm-request", "attach-base"]);
    expect(setup.primary.label).toBe("Attach a base source");
    expect(setup.ready).toBe(false);
  });

  it("makes an unsynced source the one primary action", () => {
    const setup = sourcesSetupTasks(
      input({
        sources: [{ ...baseSource, synced: false }],
        reviewIssues: [
          { code: "unsynced_source", severity: "blocker", message: "Source is not synced." },
          { code: "missing_stl", severity: "blocker", message: "STL not found on disk: a.stl" },
        ],
        roleFilaments: [{ role: "primary", part_count: 3, filament_color_id: null }],
      }),
    );

    expect(setup.primary.action).toEqual({
      kind: "handler",
      label: "Sync sources",
      handler: "sync_sources",
    });
    const sync = setup.tasks.find((task) => task.id === "sync-sources");
    expect(sync?.state).toBe("needs_attention");
    expect(sync?.statusLabel).toBe("Not synced");
    // The sync task owns the unsynced blocker; differences report the rest.
    expect(setup.tasks.find((task) => task.id === "resolve-differences")?.statusLabel).toBe(
      "1 file problem",
    );
  });

  it("reports a running sync as background work with no action", () => {
    const setup = sourcesSetupTasks(
      input({ sources: [{ ...baseSource, synced: false }], syncing: true }),
    );
    const sync = setup.tasks.find((task) => task.id === "sync-sources");

    expect(sync?.state).toBe("in_progress");
    expect(sync?.statusLabel).toBe("Syncing sources");
    expect(sync?.action).toBeUndefined();
    expect(setup.primary.label).toBe("Review Working Plan");
  });

  it("puts name conflicts ahead of other file problems", () => {
    const setup = sourcesSetupTasks(
      input({
        mergeConflictCount: 2,
        reviewIssues: [
          { code: "missing_stl", severity: "blocker", message: "STL not found on disk: a.stl" },
        ],
      }),
    );

    expect(setup.primary.action).toEqual({
      kind: "handler",
      label: "Review differences",
      handler: "resolve_differences",
    });
    expect(
      setup.tasks.find((task) => task.id === "resolve-differences")?.statusLabel,
    ).toBe("Needs your decision");
  });

  it("names the roles that still need a filament", () => {
    const setup = sourcesSetupTasks(
      input({
        roleFilaments: [
          { role: "primary", part_count: 3, filament_color_id: "pla-black" },
          { role: "accent", part_count: 2, filament_color_id: null, filament_custom_hex: null },
          { role: "opaque", part_count: 0, filament_color_id: null },
        ],
      }),
    );
    const colors = setup.tasks.find((task) => task.id === "assign-colors");

    expect(colors?.statusLabel).toBe("1 role unset");
    expect(colors?.hint).toBe("accent has no filament yet.");
    expect(setup.primary.label).toBe("Assign colors");
  });

  it("asks for a Working Plan update instead of a rebuild button", () => {
    const setup = sourcesSetupTasks(
      input({
        freshness: {
          status: "stale",
          reasons: [{ kind: "source_revision_changed", source_name: "Voron 2.4 LDO Kit" }],
          untracked_sources: [],
        },
      }),
    );
    const update = setup.tasks.find((task) => task.id === "update-working-plan");

    expect(update?.label).toBe("Update Working Plan");
    expect(update?.statusLabel).toBe("Out of date");
    expect(update?.hint).toBe("Voron 2.4 LDO Kit has newer files.");
    expect(setup.primary.action).toEqual({
      kind: "handler",
      label: "Update Working Plan",
      handler: "update_working_plan",
    });
  });

  it("gives every pending assistant state an action", () => {
    for (const phase of [
      { kind: "preparing" },
      { kind: "draft", draft_id: 4 },
      { kind: "abandoned", draft_id: 4 },
      { kind: "missing_draft", draft_id: 4 },
      { kind: "applied", draft_id: 4, revision_id: 2 },
    ] as const) {
      const setup = sourcesSetupTasks(
        input({
          planning: {
            planning_phase: phase,
            readiness: { ready: true, blockers: [] },
            grouped_difference_count: 1,
          },
        }),
      );
      const assistant = setup.tasks.find((task) => task.id === "review-assistant");
      expect(assistant?.action, `${phase.kind} has no action`).toBeDefined();
    }
  });

  it("summarises assistant proposals in human words", () => {
    expect(
      assistantChangeSummary({
        planning_phase: { kind: "draft", draft_id: 2 },
        readiness: {
          ready: false,
          blockers: [
            { code: "source_role_unset", detail: "base role" },
            { code: "source_role_unset", detail: "addon role" },
            { code: "requirement_unverified", detail: "size: 350" },
          ],
        },
        grouped_difference_count: 3,
      }),
    ).toBe("2 source roles, 3 file choices and 1 requirement to confirm");
  });

  it("returns no summary when the assistant proposed nothing", () => {
    expect(
      assistantChangeSummary({
        planning_phase: { kind: "preparing" },
        readiness: { ready: true, blockers: [] },
        grouped_difference_count: 0,
      }),
    ).toBeNull();
  });

  it("explains why the Working Plan is out of date", () => {
    expect(workingPlanUpdateReason({ status: "current" })).toBeNull();
    expect(
      workingPlanUpdateReason({
        status: "untracked",
        reasons: [{ kind: "source_revision_untracked", source_name: "Kit" }],
      }),
    ).toBe("The Working Plan does not record which revision of Kit it used.");
    expect(
      workingPlanUpdateReason({
        status: "stale",
        reasons: [{ kind: "naming_rules_changed", source_name: "Kit" }],
        untracked_sources: [],
      }),
    ).toBe("Part naming rules changed since the Working Plan was built.");
  });
});
