import { describe, expect, it } from "vitest";
import { acceptedStateDetail } from "./accepted-state-detail.js";

describe("acceptedStateDetail", () => {
  it("presents compatibility repair failures", () => {
    expect(acceptedStateDetail("compatibility_dirty")).toBe(
      "Accepted Plan requires compatibility repair",
    );
  });

  it("presents uninitialized state failures", () => {
    expect(acceptedStateDetail("uninitialized")).toBe(
      "Accepted Plan operational state is not initialized",
    );
  });
});
