import { describe, expect, it } from "vitest";
import { completedPrefixLength } from "./completed-prefix.js";

describe("completedPrefixLength", () => {
  it("counts completed units from zero until the first gap", () => {
    expect(
      completedPrefixLength([
        { unitIndex: 0, completed: true },
        { unitIndex: 1, completed: true },
        { unitIndex: 2, completed: false },
        { unitIndex: 3, completed: true },
      ]),
    ).toBe(2);
  });

  it("sorts units before counting", () => {
    expect(
      completedPrefixLength([
        { unitIndex: 2, completed: true },
        { unitIndex: 0, completed: true },
        { unitIndex: 1, completed: true },
      ]),
    ).toBe(3);
  });

  it("returns zero when unit zero is missing or incomplete", () => {
    expect(completedPrefixLength([{ unitIndex: 1, completed: true }])).toBe(0);
    expect(completedPrefixLength([{ unitIndex: 0, completed: false }])).toBe(0);
  });
});
