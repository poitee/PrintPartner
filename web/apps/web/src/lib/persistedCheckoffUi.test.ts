import { describe, expect, it } from "vitest";
import {
  CHECKOFF_UI_STORAGE_KEY,
  parsePersistedCheckoffUi,
  serializePersistedCheckoffUi,
} from "./persistedCheckoffUi";

describe("persistedCheckoffUi", () => {
  it("returns defaults for empty input", () => {
    expect(parsePersistedCheckoffUi(null)).toEqual({
      filter: "missing",
      compactMode: false,
      continuousPrintLayout: false,
      textOnlyPrint: false,
      partOrderByPlanId: {},
      bagBarsByPlanId: {},
      progressRowsByPlanId: {},
    });
  });

  it("round-trips filter, part order, bags, and progress rows", () => {
    const state = {
      filter: "done" as const,
      compactMode: true,
      continuousPrintLayout: true,
      textOnlyPrint: true,
      partOrderByPlanId: { "12": [3, 1, 2] },
      bagBarsByPlanId: { "12": [{ id: "b1", label: "Bag 1" }] },
      progressRowsByPlanId: {
        "12": [
          { kind: "bag" as const, id: "b1", label: "Bag 1" },
          { kind: "part" as const, id: 3 },
          { kind: "part" as const, id: 1 },
          { kind: "part" as const, id: 2 },
        ],
      },
    };
    expect(parsePersistedCheckoffUi(serializePersistedCheckoffUi(state))).toEqual(state);
  });

  it("ignores invalid filter and order entries", () => {
    const parsed = parsePersistedCheckoffUi(
      JSON.stringify({
        filter: "maybe",
        partOrderByPlanId: {
          "1": [1, "x", 2],
          bad: null,
        },
        bagBarsByPlanId: {
          "1": [{ id: "ok", label: "Bag" }, { id: "" }, null],
        },
      }),
    );
    expect(parsed.filter).toBe("missing");
    expect(parsed.partOrderByPlanId).toEqual({ "1": [1, 2] });
    expect(parsed.bagBarsByPlanId).toEqual({ "1": [{ id: "ok", label: "Bag" }] });
  });

  it("defaults textOnlyPrint to false when stored state predates it", () => {
    const parsed = parsePersistedCheckoffUi(
      JSON.stringify({ filter: "all", continuousPrintLayout: true }),
    );
    expect(parsed.textOnlyPrint).toBe(false);
  });

  it("uses stable storage key", () => {
    expect(CHECKOFF_UI_STORAGE_KEY).toBe("print-partner.checkoff.ui.v1");
  });
});
