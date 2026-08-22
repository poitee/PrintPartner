import { describe, expect, it } from "vitest";
import type { PlanReview } from "../api/engine";
import {
  countEmptyThumbs,
  countMissingStls,
  projectIdsForStlSync,
  shouldAutoStartStlSync,
  stlAutoSyncWorkKey,
  stlSyncBannerMode,
} from "./stlAutoSync";
import type { ReviewPart } from "../api/engine";

function part(overrides: Partial<ReviewPart> & { id: number }): ReviewPart {
  return {
    match_key: "k",
    relative_path: "folder/a.stl",
    filename: "a.stl",
    source_layer: "base:main",
    status: "ok",
    role: "primary",
    requirement: null,
    option_group_id: null,
    included: true,
    filament_color_id: null,
    quantity_auto: 1,
    quantity_override: null,
    quantity_effective: 1,
    print_units: [false],
    printed_count: 0,
    missing: true,
    stl_missing: false,
    thumb_empty: false,
    filament_display: "PLA",
    ...overrides,
  };
}

const baseReview = {
  profile_id: 1,
  accepted_basis: null,
  plan_name: "T",
  layers: [
    {
      id: 1,
      layer_type: "base",
      project_id: 10,
      project_name: "A",
      local_path: "/tmp/a",
      synced: false,
      last_synced_at: null,
    },
    {
      id: 2,
      layer_type: "addon",
      project_id: 10,
      project_name: "A",
      local_path: "/tmp/a",
      synced: true,
      last_synced_at: null,
    },
    {
      id: 3,
      layer_type: "addon",
      project_id: 20,
      project_name: "B",
      local_path: null,
      synced: false,
      last_synced_at: null,
    },
  ],
  totals: {
    included_parts: 1,
    total_print_units: 1,
    by_role: {},
    by_filament: {},
  },
  issues: [],
  has_blockers: false,
  part_groups: [],
} satisfies PlanReview;

describe("countMissingStls / empty thumbs", () => {
  it("uses stl_missing, not checkoff missing", () => {
    const parts = [
      part({ id: 1, missing: true, stl_missing: false }),
      part({ id: 2, missing: false, stl_missing: true, filename: "b.stl" }),
      part({ id: 3, included: false, stl_missing: true, filename: "c.stl" }),
    ];
    expect(countMissingStls(parts)).toBe(1);
  });

  it("counts empty thumbs only when STL is present", () => {
    const parts = [
      part({ id: 1, thumb_empty: true, stl_missing: false }),
      part({ id: 2, thumb_empty: true, stl_missing: true, filename: "b.stl" }),
      part({ id: 3, thumb_empty: false, filename: "c.stl" }),
    ];
    expect(countEmptyThumbs(parts)).toBe(1);
  });
});

describe("stlAutoSyncWorkKey + shouldAutoStartStlSync", () => {
  it("dedupes plan-select then Parts-open for the same work", () => {
    const key = stlAutoSyncWorkKey(7, [3, 1], [9]);
    expect(key).toBe(stlAutoSyncWorkKey(7, [1, 3], [9]));

    expect(
      shouldAutoStartStlSync({
        profileId: 7,
        trigger: "plan_select",
        missingStlCount: 2,
        emptyThumbCount: 1,
        alreadyRunning: false,
        attemptedWorkKey: null,
        workKey: key,
      }),
    ).toBe(true);

    expect(
      shouldAutoStartStlSync({
        profileId: 7,
        trigger: "parts_open",
        missingStlCount: 2,
        emptyThumbCount: 1,
        alreadyRunning: false,
        attemptedWorkKey: key,
        workKey: key,
      }),
    ).toBe(false);
  });

  it("does not auto-start on Library with no plan or Progress ticks", () => {
    const key = stlAutoSyncWorkKey(1, [1], []);
    expect(
      shouldAutoStartStlSync({
        profileId: null,
        trigger: "library_no_plan",
        missingStlCount: 5,
        emptyThumbCount: 5,
        alreadyRunning: false,
        attemptedWorkKey: null,
        workKey: key,
      }),
    ).toBe(false);
    expect(
      shouldAutoStartStlSync({
        profileId: 1,
        trigger: "progress_tick",
        missingStlCount: 5,
        emptyThumbCount: 0,
        alreadyRunning: false,
        attemptedWorkKey: null,
        workKey: key,
      }),
    ).toBe(false);
  });

  it("starts when plan selected and something is missing or thumb empty", () => {
    expect(
      shouldAutoStartStlSync({
        profileId: 1,
        trigger: "compose_apply",
        missingStlCount: 0,
        emptyThumbCount: 2,
        alreadyRunning: false,
        attemptedWorkKey: null,
        workKey: stlAutoSyncWorkKey(1, [], [4, 5]),
      }),
    ).toBe(true);
  });

  it("skips when already running", () => {
    expect(
      shouldAutoStartStlSync({
        profileId: 1,
        trigger: "parts_open",
        missingStlCount: 1,
        emptyThumbCount: 0,
        alreadyRunning: true,
        attemptedWorkKey: null,
        workKey: stlAutoSyncWorkKey(1, [1], []),
      }),
    ).toBe(false);
  });
});

describe("stlSyncBannerMode", () => {
  it("running hides missing nag", () => {
    expect(stlSyncBannerMode({ running: true, failed: false, missingCount: 3 })).toEqual({
      kind: "running",
    });
  });

  it("done + files here hides banner", () => {
    expect(stlSyncBannerMode({ running: false, failed: false, missingCount: 0 })).toEqual({
      kind: "hidden",
    });
  });

  it("done + still gone shows N STL missing", () => {
    expect(stlSyncBannerMode({ running: false, failed: false, missingCount: 4 })).toEqual({
      kind: "missing",
      count: 4,
    });
  });

  it("fail shows Sync failed", () => {
    expect(stlSyncBannerMode({ running: true, failed: true, missingCount: 2 })).toEqual({
      kind: "running",
    });
    expect(stlSyncBannerMode({ running: false, failed: true, missingCount: 2 })).toEqual({
      kind: "failed",
    });
  });
});

describe("projectIdsForStlSync", () => {
  it("dedupes layer project ids", () => {
    expect(projectIdsForStlSync(baseReview)).toEqual([10, 20]);
  });
});
