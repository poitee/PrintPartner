import { describe, expect, it } from "vitest";
import {
  appendAssistantHistory,
  appendPendingProposedActions,
  clearAssistantHistory,
  loadAssistantHistory,
  removePendingProposedAction,
} from "./history.js";
import { buildSyncAction } from "./sync-action.js";
import type { AppRepository } from "../db/repository.js";
import type { AssistantProposedAction } from "@print-partner/contracts";

function memoryRepo(): AppRepository & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
    getSetting: (key: string) => store.get(key) ?? null,
    setSetting: (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as AppRepository & { _store: Map<string, string> };
}

describe("pending proposed actions in history", () => {
  it("persists Apply cards with assistant turns and strips ui_*", () => {
    const repo = memoryRepo();
    const mutate: AssistantProposedAction = {
      id: "a1",
      type: "set_base",
      plan_id: 1,
      label: "Set base",
      summary: "Set base Voron",
      params: { source_name: "Voron-Trident" },
    };
    const ui: AssistantProposedAction = {
      id: "u1",
      type: "ui_navigate",
      plan_id: 1,
      label: "Open build",
      summary: "nav",
      params: { route: "build" },
    };
    appendAssistantHistory(repo, [
      { role: "user", content: "Set Trident" },
      { role: "assistant", content: "Confirm below", proposed_actions: [mutate, ui] },
    ]);
    const hist = loadAssistantHistory(repo);
    const assistant = hist.find((m) => m.role === "assistant");
    expect(assistant?.proposed_actions?.map((a) => a.type)).toEqual(["set_base"]);
  });

  it("removes pending actions on apply/dismiss and appends follow-ups", () => {
    const repo = memoryRepo();
    appendAssistantHistory(repo, [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "ok",
        proposed_actions: [
          {
            id: "a1",
            type: "set_base",
            plan_id: 2,
            label: "Set base",
            summary: "x",
            params: {},
          },
        ],
      },
    ]);
    expect(removePendingProposedAction(repo, "a1")).toBe(true);
    expect(loadAssistantHistory(repo).at(-1)?.proposed_actions).toBeUndefined();

    const follow = buildSyncAction({
      planId: 2,
      projectIds: [9],
      sourceName: "Voron-Trident",
    });
    expect(appendPendingProposedActions(repo, [follow])).toBe(true);
    const pending = loadAssistantHistory(repo).at(-1)?.proposed_actions ?? [];
    expect(pending).toHaveLength(1);
    expect(pending[0]!.label).toBe("Sync Voron-Trident");
    expect(pending[0]!.type).toBe("start_sync");

    clearAssistantHistory(repo);
    expect(loadAssistantHistory(repo)).toHaveLength(0);
  });
});

describe("buildSyncAction", () => {
  it("builds a sync action without rebuilding the Plan", () => {
    const action = buildSyncAction({ planId: 5, sourceName: "Voron-2" });
    expect(action.type).toBe("start_sync");
    expect(action.summary).toMatch(/Review plan #5/);
  });
});
