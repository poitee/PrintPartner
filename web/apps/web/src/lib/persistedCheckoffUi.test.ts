import { describe, expect, it } from "vitest";
import {
  CHECKOFF_UI_STORAGE_KEY,
  getBagBarsForPlan,
  getPartOrderForPlan,
  getProgressRowsForPlan,
  parsePersistedCheckoffUi,
  serializePersistedCheckoffUi,
  withPartOrderForPlan,
  withProgressRowsForPlan,
} from "./persistedCheckoffUi";

describe("persistedCheckoffUi", () => {
  it("returns defaults for empty input", () => {
    expect(parsePersistedCheckoffUi(null)).toEqual({
      filter: "missing",
      compactMode: false,
      continuousPrintLayout: false,
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

  it("get/withPartOrderForPlan helpers", () => {
    const base = parsePersistedCheckoffUi(null);
    expect(getPartOrderForPlan(base, 7)).toEqual([]);
    const next = withPartOrderForPlan(base, 7, [9, 8]);
    expect(getPartOrderForPlan(next, 7)).toEqual([9, 8]);
    expect(getPartOrderForPlan(next, null)).toEqual([]);
  });

  it("migrates legacy part+bag into progress rows", () => {
    const state = parsePersistedCheckoffUi(
      JSON.stringify({
        partOrderByPlanId: { "5": [2, 1] },
        bagBarsByPlanId: { "5": [{ id: "b", label: "Bag 1" }] },
      }),
    );
    expect(getProgressRowsForPlan(state, 5)).toEqual([
      { kind: "part", id: 2 },
      { kind: "part", id: 1 },
      { kind: "bag", id: "b", label: "Bag 1" },
    ]);
    expect(getBagBarsForPlan(state, 5)).toEqual([{ id: "b", label: "Bag 1" }]);
  });

  it("withProgressRowsForPlan syncs legacy fields", () => {
    const base = parsePersistedCheckoffUi(null);
    const next = withProgressRowsForPlan(base, 3, [
      { kind: "bag", id: "b1", label: "Bag 1" },
      { kind: "part", id: 10 },
    ]);
    expect(getProgressRowsForPlan(next, 3)).toEqual([
      { kind: "bag", id: "b1", label: "Bag 1" },
      { kind: "part", id: 10 },
    ]);
    expect(getPartOrderForPlan(next, 3)).toEqual([10]);
    expect(getBagBarsForPlan(next, 3)).toEqual([{ id: "b1", label: "Bag 1" }]);
  });

  it("uses stable storage key", () => {
    expect(CHECKOFF_UI_STORAGE_KEY).toBe("print-partner.checkoff.ui.v1");
  });
});
