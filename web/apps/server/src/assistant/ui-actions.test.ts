import { describe, expect, it } from "vitest";
import { isAssistantUiAction } from "@print-partner/contracts";

describe("isAssistantUiAction", () => {
  it("detects ui_* types", () => {
    expect(isAssistantUiAction("ui_navigate")).toBe(true);
    expect(isAssistantUiAction("ui_open_docs")).toBe(true);
    expect(isAssistantUiAction("ui_highlight_part")).toBe(true);
    expect(isAssistantUiAction("ui_focus_kit_option")).toBe(true);
    expect(isAssistantUiAction("set_base")).toBe(false);
    expect(isAssistantUiAction("start_sync")).toBe(false);
  });

  it("filters proposed_actions for Apply cards (onDone contract)", () => {
    const proposed = [
      { type: "ui_open_docs" },
      { type: "set_base" },
      { type: "ui_navigate" },
      { type: "start_sync" },
    ];
    const forCards = proposed.filter((a) => !isAssistantUiAction(a.type));
    expect(forCards.map((a) => a.type)).toEqual(["set_base", "start_sync"]);
  });
});
