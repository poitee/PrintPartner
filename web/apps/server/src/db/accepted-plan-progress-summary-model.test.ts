import { describe, expect, it } from "vitest";
import {
  appendGrouped,
  canonicalProfileIds,
  MAX_ACCEPTED_PROGRESS_SUMMARY_BATCH,
  stableResults,
  terminalIdentityEqual,
  type AcceptedTerminalIdentity,
} from "./accepted-plan-progress-summary-model.js";
import type { AcceptedPlanProgressRead } from "./accepted-plan-progress-summary.js";

function identity(overrides: Partial<AcceptedTerminalIdentity> = {}): AcceptedTerminalIdentity {
  return {
    acceptedPlanRevisionId: 1,
    acceptedPlanVersion: 2,
    acceptedInputSetId: 3,
    acceptedInputAcceptedAt: "2026-01-01T00:00:00.000Z",
    requiredUnitMappingDigest: "digest",
    ...overrides,
  };
}

describe("accepted plan progress summary model", () => {
  it("canonicalizes profile ids while preserving first-seen order", () => {
    expect(canonicalProfileIds([3, 1, 3, 2, 1])).toEqual([3, 1, 2]);
  });

  it("rejects invalid profile ids and oversized batches", () => {
    expect(() => canonicalProfileIds([0])).toThrowError("positive safe integers");
    expect(() => canonicalProfileIds([1.5])).toThrowError("positive safe integers");
    expect(() =>
      canonicalProfileIds(
        Array.from({ length: MAX_ACCEPTED_PROGRESS_SUMMARY_BATCH + 1 }, (_, index) => index + 1),
      ),
    ).toThrowError(`at most ${MAX_ACCEPTED_PROGRESS_SUMMARY_BATCH}`);
  });

  it("compares terminal identities across all concurrency fields", () => {
    expect(terminalIdentityEqual(identity(), identity())).toBe(true);
    expect(terminalIdentityEqual(identity(), identity({ acceptedPlanVersion: 3 }))).toBe(false);
    expect(terminalIdentityEqual(identity(), identity({ requiredUnitMappingDigest: "changed" }))).toBe(false);
  });

  it("appends grouped rows", () => {
    const map = new Map<number, string[]>();
    appendGrouped(map, 1, "a");
    appendGrouped(map, 1, "b");
    appendGrouped(map, 2, "c");
    expect(map).toEqual(
      new Map([
        [1, ["a", "b"]],
        [2, ["c"]],
      ]),
    );
  });

  it("splits stable and changed reads using terminal identity", () => {
    const ready: AcceptedPlanProgressRead = {
      kind: "ready",
      profileId: 1,
      totalUnits: 2,
      remainingUnits: 1,
    };
    const missing: AcceptedPlanProgressRead = { kind: "missing", profileId: 2 };
    const result = stableResults({
      profileIds: [1, 2],
      before: new Map([
        [1, identity()],
        [2, identity()],
      ]),
      after: new Map([
        [1, identity()],
        [2, identity({ acceptedInputSetId: 4 })],
      ]),
      reads: new Map<number, AcceptedPlanProgressRead>([
        [1, ready],
        [2, missing],
      ]),
    });

    expect(result.stable).toEqual(new Map([[1, ready]]));
    expect(result.changed).toEqual([2]);
  });
});
