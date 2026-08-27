import { describe, expect, it } from "vitest";
import { acceptedProfileProgress } from "./accepted-profile-progress.js";

describe("acceptedProfileProgress", () => {
  it("maps a ready progress read without leaking profile id", () => {
    expect(
      acceptedProfileProgress({
        kind: "ready",
        profileId: 7,
        totalUnits: 12,
        remainingUnits: 3,
      }),
    ).toEqual({ kind: "ready", totalUnits: 12, remainingUnits: 3 });
  });

  it("maps unavailable and integrity states", () => {
    expect(
      acceptedProfileProgress({
        kind: "unavailable",
        profileId: 7,
        reason: "compatibility_dirty",
      }),
    ).toEqual({ kind: "unavailable", reason: "compatibility_dirty" });

    expect(
      acceptedProfileProgress({
        kind: "integrity_failure",
        profileId: 7,
        code: "progress",
      }),
    ).toEqual({ kind: "integrity_failure", code: "progress" });
  });

  it("maps empty and concurrent update reads", () => {
    expect(acceptedProfileProgress({ kind: "empty", profileId: 7 })).toEqual({ kind: "empty" });
    expect(acceptedProfileProgress({ kind: "concurrent_update", profileId: 7 })).toEqual({
      kind: "concurrent_update",
    });
  });
});
