// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlanDraftWorkspace } from "@print-partner/contracts";
import { EngineHttpError } from "../api/engineTransport";
import PlanDraftApplyButton from "../components/build/PlanDraftApplyButton";
import {
  planDraftProductionBlockFromError,
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

describe("Working Plan acceptance control", () => {
  it("recognizes a production block that can be retried with remapping", () => {
    expect(planDraftProductionBlockFromError(new EngineHttpError(
      "Production is active",
      423,
      { code: "production_active", checkoff_link_count: 2, send_queue_item_count: 1 },
    ))).toEqual({ checkoffLinkCount: 2, sendQueueItemCount: 1 });
    expect(planDraftProductionBlockFromError(new EngineHttpError(
      "Draft changed",
      409,
      { code: "stale_draft" },
    ))).toBeNull();
  });

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

  it("is disabled for unresolved reconciliation and a stale accepted base", () => {
    const onApply = vi.fn();
    const onRebase = vi.fn();
    const unresolved: PlanDraftWorkspace = {
      ...readyWorkspace,
      reconciliation: { kind: "unresolved", conflicts: [] },
    };
    const first = render(
      <PlanDraftApplyButton
        workspace={unresolved}
        busy={false}
        onApply={onApply}
        onRebase={onRebase}
      />,
    );
    expect(screen.getByRole("button", { name: "Accept Working Plan" }).hasAttribute("disabled")).toBe(true);
    first.unmount();

    const stale: PlanDraftWorkspace = {
      ...readyWorkspace,
      diff: { ...readyWorkspace.diff, base_is_current: false },
    };
    render(
      <PlanDraftApplyButton
        workspace={stale}
        busy={false}
        onApply={onApply}
        onRebase={onRebase}
      />,
    );
    expect(screen.getByRole("button", { name: "Accept Working Plan" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh Working Plan" }));
    expect(onRebase).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
  });
});
