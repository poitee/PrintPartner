import { describe, expect, it } from "vitest";
import { EngineHttpError } from "../api/engineTransport";
import { planAcceptanceFailureFromError, unmovedUnits } from "./planAcceptanceFailure";

describe("acceptance failures", () => {
  it("reads a block caused by live Production records", () => {
    expect(planAcceptanceFailureFromError(new EngineHttpError("locked", 423, {
      code: "production_active",
      checkoff_link_count: 2,
      send_queue_item_count: 1,
    }))).toEqual({ kind: "linked_records", checkoffLinkCount: 2, sendQueueItemCount: 1 });
  });

  it("keeps the filename and outcome of every unit that cannot move", () => {
    const failure = planAcceptanceFailureFromError(new EngineHttpError("unsafe", 422, {
      code: "checkoff_remap_unsafe",
      unmappable: [
        { linkId: "l1", filename: "skirt_panel_x6.stl", reason: "printed 6 units, new quantity is 4" },
        { linkId: "l2" },
      ],
    }));
    expect(failure).toEqual({
      kind: "unsafe_records",
      units: [
        { filename: "skirt_panel_x6.stl", outcome: "printed 6 units, new quantity is 4" },
        { filename: "Unknown file", outcome: "This printed work cannot move to the new revision." },
      ],
    });
    expect(unmovedUnits(failure)).toHaveLength(2);
  });

  it("falls back to the message of any other failure", () => {
    expect(planAcceptanceFailureFromError(new Error("engine offline"))).toEqual({
      kind: "error",
      message: "engine offline",
    });
    expect(unmovedUnits(null)).toEqual([]);
  });
});
