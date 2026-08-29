import { describe, expect, it } from "vitest";
import {
  assistantChangeSummary,
  sourcesSetupTasks,
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
    mergeConflictCount: 0,
    roleFilaments: [],
    syncing: false,
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
      label: "Open Plan",
      reason: "Sources are ready. Create or review the Working Plan on Plan.",
      action: { kind: "route", label: "Open Plan", to: "/plan?profile=1" },
    });
  });

  it("keeps the listed setup order and drops tasks that do not apply", () => {
    const setup = sourcesSetupTasks(
      input({
        sources: [baseSource, { ...baseSource, id: 2, name: "Mods", layerType: "addon" }],
        roleFilaments: [{ role: "primary", part_count: 3, filament_color_id: null }],
      }),
    );

    expect(ids(setup)).toEqual([
      "confirm-request",
      "attach-base",
      "attach-optional",
      "sync-sources",
      "resolve-differences",
      "assign-colors",
    ]);
  });

  it("hides the optional-source and difference tasks before a base source exists", () => {
    const setup = sourcesSetupTasks(input({ sources: [] }));

    expect(ids(setup)).toEqual(["confirm-request", "attach-base"]);
    expect(setup.primary.label).toBe("Attach a base source");
    expect(setup.ready).toBe(false);
  });

  it("makes an unsynced source the one primary action", () => {
    const setup = sourcesSetupTasks(
      input({
        sources: [{ ...baseSource, synced: false }],
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
    expect(setup.tasks.find((task) => task.id === "resolve-differences")).toBeUndefined();
  });

  it("reports a running sync as background work with no action", () => {
    const setup = sourcesSetupTasks(
      input({ sources: [{ ...baseSource, synced: false }], syncing: true }),
    );
    const sync = setup.tasks.find((task) => task.id === "sync-sources");

    expect(sync?.state).toBe("in_progress");
    expect(sync?.statusLabel).toBe("Syncing sources");
    expect(sync?.action).toBeUndefined();
    expect(setup.primary.label).toBe("Open Plan");
  });

  it("puts name conflicts ahead of other file problems", () => {
    const setup = sourcesSetupTasks(
      input({
        mergeConflictCount: 2,
      }),
    );

    expect(setup.primary.action).toEqual({
      kind: "handler",
      label: "Choose files",
      handler: "resolve_differences",
    });
    expect(
      setup.tasks.find((task) => task.id === "resolve-differences")?.statusLabel,
    ).toBe("2 choices");
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

  it("does not invent Plan or file work from an otherwise-ready first build", () => {
    const setup = sourcesSetupTasks(input());
    const text = setup.tasks
      .flatMap((task) => [task.label, task.hint ?? "", task.statusLabel])
      .join(" ");

    expect(text).not.toContain("file problem");
    expect(text).not.toContain("No parts yet");
    expect(ids(setup)).not.toContain("update-working-plan");
    expect(ids(setup)).not.toContain("review-assistant");
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

});
