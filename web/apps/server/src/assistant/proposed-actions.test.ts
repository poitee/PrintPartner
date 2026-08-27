import { describe, expect, it } from "vitest";
import { proposeAssistantAction } from "./proposed-actions.js";

describe("proposed actions", () => {
  it("constructs the action and response from one named input", () => {
    const result = proposeAssistantAction({
      type: "propose_update_source",
      planId: 7,
      label: "update Plan",
      summary: "Apply the reviewed Plan changes.",
      params: { name: "Revised" },
      extras: { source: "assistant" },
    });

    expect(result.proposedAction).toMatchObject({
      type: "propose_update_source",
      plan_id: 7,
      label: "update Plan",
      summary: "Apply the reviewed Plan changes.",
      params: { name: "Revised" },
    });
    expect(JSON.parse(result.content)).toMatchObject({
      status: "proposed",
      source: "assistant",
      action: { plan_id: 7 },
    });
  });
});
