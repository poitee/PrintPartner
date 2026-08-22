import { describe, expect, it } from "vitest";
import { appendSyncIfNeeded } from "./tool-loop.js";
import type { ToolContext } from "./tools.js";
import type { AssistantProposedAction } from "@print-partner/contracts";

describe("appendSyncIfNeeded", () => {
  it("appends Sync after tagged set_base", () => {
    const actions: AssistantProposedAction[] = [
      {
        id: "1",
        type: "set_base",
        plan_id: 6,
        label: "Set base",
        summary: "x",
        params: { source_name: "Voron-Trident", tag: "VTr2" },
      },
      {
        id: "2",
        type: "add_addon",
        plan_id: 6,
        label: "Add LDO",
        summary: "x",
        params: { source_name: "LDOVoronTrident" },
      },
    ];
    const repo = {
      listSources: () => [
        { id: 54, name: "Voron-Trident" },
        { id: 64, name: "LDOVoronTrident" },
      ],
    };
    appendSyncIfNeeded(
      { repo, activePlanId: 6 } as unknown as ToolContext,
      actions,
    );
    expect(actions.some((action) => action.type === "start_sync")).toBe(true);
  });

  it("appends Sync after apply_stack_preset", () => {
    const actions: AssistantProposedAction[] = [
      {
        id: "1",
        type: "apply_stack_preset",
        plan_id: 6,
        label: "Apply stack",
        summary: "x",
        params: { preset_id: "ldo_trident_r2", base_tag: "VTr2" },
      },
    ];
    appendSyncIfNeeded(
      {
        repo: {
          listSources: () => [{ id: 54, name: "Voron-Trident" }],
        },
        activePlanId: 6,
      } as unknown as ToolContext,
      actions,
    );
    const sync = actions.find((action) => action.type === "start_sync");
    expect(sync).toBeTruthy();
    expect(sync?.params?.source_name ?? sync?.summary).toBeTruthy();
  });
});
