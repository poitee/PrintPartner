import { describe, expect, it } from "vitest";
import { acceptedPlanRevisionIdentity } from "./accepted-plan-revision-model.js";

describe("acceptedPlanRevisionIdentity", () => {
  it("keeps tracked revisions with an input set", () => {
    expect(
      acceptedPlanRevisionIdentity({
        id: 12,
        provenanceKind: "tracked",
        inputSetId: 34,
      }),
    ).toEqual({ id: 12, provenanceKind: "tracked", inputSetId: 34 });
  });

  it("keeps legacy revisions without an input set", () => {
    expect(
      acceptedPlanRevisionIdentity({
        id: 12,
        provenanceKind: "legacy",
        inputSetId: null,
      }),
    ).toEqual({ id: 12, provenanceKind: "legacy", inputSetId: null });
  });

  it("rejects mixed provenance", () => {
    expect(() =>
      acceptedPlanRevisionIdentity({ id: 12, provenanceKind: "tracked", inputSetId: null }),
    ).toThrow("Accepted Plan revision provenance is invalid");

    expect(() =>
      acceptedPlanRevisionIdentity({ id: 12, provenanceKind: "legacy", inputSetId: 34 }),
    ).toThrow("Accepted Plan revision provenance is invalid");
  });
});
