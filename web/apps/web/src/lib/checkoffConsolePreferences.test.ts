// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  CHECKOFF_CONSOLE_STORAGE_KEY,
  CHECKOFF_CORRECTION_LIMIT,
  getCheckoffCompletedAt,
  getCheckoffCorrections,
  getCheckoffSearch,
  latestCorrectionsByPart,
  loadCheckoffConsolePreferences,
  parseCheckoffConsolePreferences,
  saveCheckoffConsolePreferences,
  withCheckoffCompletedAt,
  withCheckoffCorrection,
  withCheckoffSearch,
} from "./checkoffConsolePreferences";
import type { CheckoffCorrectionRecord } from "./checkoffConsoleCorrection";

const record: CheckoffCorrectionRecord = {
  partId: 11,
  unitIndex: 0,
  reason: "recount",
  note: "bin was short",
  at: "2026-08-27T10:00:00.000Z",
};

describe("parseCheckoffConsolePreferences", () => {
  it("returns empty state for missing or broken storage", () => {
    expect(parseCheckoffConsolePreferences(null).view).toBeNull();
    expect(parseCheckoffConsolePreferences("{").searchByPlanId).toEqual({});
  });

  it("drops unknown views and malformed corrections", () => {
    const parsed = parseCheckoffConsolePreferences(
      JSON.stringify({
        view: "nope",
        searchByPlanId: { "1": "gantry", "2": 4 },
        correctionsByPlanId: { "1": [record, { partId: "x" }, { ...record, reason: "bogus" }] },
      }),
    );
    expect(parsed.view).toBeNull();
    expect(parsed.searchByPlanId).toEqual({ "1": "gantry" });
    expect(parsed.correctionsByPlanId["1"]).toEqual([record]);
  });

  it("keeps a stored view", () => {
    expect(parseCheckoffConsolePreferences(JSON.stringify({ view: "completed" })).view).toBe(
      "completed",
    );
  });
});

describe("search continuity", () => {
  it("round-trips a per-plan search and clears an empty one", () => {
    let state = parseCheckoffConsolePreferences(null);
    state = withCheckoffSearch(state, 1, "gantry");
    expect(getCheckoffSearch(state, 1)).toBe("gantry");
    state = withCheckoffSearch(state, 1, "");
    expect(getCheckoffSearch(state, 1)).toBe("");
    expect(getCheckoffSearch(state, null)).toBe("");
  });
});

describe("completion receipt", () => {
  it("keeps the first completion time", () => {
    let state = parseCheckoffConsolePreferences(null);
    state = withCheckoffCompletedAt(state, 1, "2026-08-27T10:00:00.000Z");
    state = withCheckoffCompletedAt(state, 1, "2026-08-28T10:00:00.000Z");
    expect(getCheckoffCompletedAt(state, 1)).toBe("2026-08-27T10:00:00.000Z");
  });

  it("clears the receipt when work reopens", () => {
    let state = withCheckoffCompletedAt(parseCheckoffConsolePreferences(null), 1, "2026-08-27T10:00:00.000Z");
    state = withCheckoffCompletedAt(state, 1, null);
    expect(getCheckoffCompletedAt(state, 1)).toBeNull();
  });
});

describe("corrections", () => {
  it("stores newest first and caps the history", () => {
    let state = parseCheckoffConsolePreferences(null);
    for (let i = 0; i < CHECKOFF_CORRECTION_LIMIT + 5; i += 1) {
      state = withCheckoffCorrection(state, 1, { ...record, unitIndex: i });
    }
    const stored = getCheckoffCorrections(state, 1);
    expect(stored).toHaveLength(CHECKOFF_CORRECTION_LIMIT);
    expect(stored[0]?.unitIndex).toBe(CHECKOFF_CORRECTION_LIMIT + 4);
    expect(getCheckoffCorrections(state, null)).toEqual([]);
  });

  it("keeps the latest correction per part", () => {
    const map = latestCorrectionsByPart([
      { ...record, at: "2026-08-27T10:00:00.000Z" },
      { ...record, at: "2026-08-27T12:00:00.000Z", note: "newer" },
      { ...record, partId: 12 },
    ]);
    expect(map.get(11)?.note).toBe("newer");
    expect(map.get(12)?.partId).toBe(12);
  });
});

describe("storage", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips through localStorage", () => {
    const state = withCheckoffSearch(
      { ...parseCheckoffConsolePreferences(null), view: "completed" },
      3,
      "belt",
    );
    saveCheckoffConsolePreferences(state);
    expect(localStorage.getItem(CHECKOFF_CONSOLE_STORAGE_KEY)).toBeTruthy();
    const loaded = loadCheckoffConsolePreferences();
    expect(loaded.view).toBe("completed");
    expect(getCheckoffSearch(loaded, 3)).toBe("belt");
  });
});
