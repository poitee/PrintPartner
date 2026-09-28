// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { PlanDraftWorkspace } from "@print-partner/contracts";
import {
  planDraftRevisionPartLabels,
} from "../lib/planDraftUi";

const readyWorkspace: PlanDraftWorkspace = {
  profile_id: 7,
  draft: {
    draft_id: 9,
    state: "open",
    lifecycle_version: 0,
    snapshot_digest: "a".repeat(64),
    base: { revision_id: 3, plan_version: 1 },
  },
  parts: [],
  diff: { base_is_current: true, added: [], removed: [], changed: [] },
  reconciliation: { kind: "ready", reused_units: 0, new_units: 0, surplus_units: 0 },
};

/**
 * Sources no longer owns Working Plan acceptance — Plan does. What remains here
 * are the pure helpers that read a Working Plan for either workspace.
 */
describe("Working Plan helpers", () => {

  it("labels reconciliation candidates by accepted revision Part identity", () => {
    const changedAfter = {
      draft_part_id: 10,
      base_revision_part_id: 31,
      part_key: "renamed.stl",
      filename: "draft-renamed.stl",
      relative_path: "draft-renamed.stl",
      source_layer: "base:Source",
      role: "primary",
      quantity_inferred: 1,
      quantity_override: null,
      quantity_effective: 1,
      included: true,
    };
    const workspace: PlanDraftWorkspace = {
      ...readyWorkspace,
      parts: [changedAfter],
      diff: {
        base_is_current: true,
        added: [],
        changed: [{
          before: {
            revision_part_id: 31,
            filename: "accepted-before.stl",
            relative_path: "accepted-before.stl",
            source_layer: "base:Source",
          },
          after: changedAfter,
          fields: ["filename"],
        }],
        removed: [{
          revision_part_id: 32,
          filename: "accepted-removed.stl",
          relative_path: "accepted-removed.stl",
          source_layer: "base:Source",
        }],
      },
    };

    expect(planDraftRevisionPartLabels(workspace)).toEqual(new Map([
      [31, "accepted-before.stl"],
      [32, "accepted-removed.stl"],
    ]));
  });
});
