import { describe, expect, it } from "vitest";
import {
  PARTS_CONFLICT_CTA,
  PARTS_CONFLICT_HINT,
  PLAN_CONFLICT_HINT,
} from "./mergeConflictCopy";

describe("mergeConflictCopy", () => {
  it("keeps Plan and Parts conflict copy short and Review-free", () => {
    expect(PLAN_CONFLICT_HINT).toBe("Exclude duplicates on the source cards below.");
    expect(PARTS_CONFLICT_HINT).toBe("Exclude duplicates on the Plan source cards.");
    expect(PARTS_CONFLICT_CTA).toBe("Resolve in Plan");
    expect(PLAN_CONFLICT_HINT.toLowerCase()).not.toContain("review");
    expect(PARTS_CONFLICT_HINT.toLowerCase()).not.toContain("review");
    expect(PARTS_CONFLICT_CTA.toLowerCase()).not.toContain("review");
  });
});
