import { describe, expect, it } from "vitest";
import {
  recordedPrintsLockProductionMethod,
  requiredUnitTokensInObjectNames,
} from "./production-unit-identity.js";

const TOKEN_A = `ppu_${"a".repeat(32)}`;
const TOKEN_B = `ppu_${"b".repeat(32)}`;
const PLAIN_A = `bracket__${TOKEN_A}`;

const wrappedA = [
  `${PLAIN_A}_id_0_copy_0`,
  `${PLAIN_A}_instance_1`,
  `${PLAIN_A} (Instance 2)`,
] as const;

describe("requiredUnitTokensInObjectNames", () => {
  it("reads a canonical token and the same token from supported slicer wrappers", () => {
    expect(requiredUnitTokensInObjectNames([PLAIN_A])).toEqual([TOKEN_A]);
    expect(requiredUnitTokensInObjectNames([wrappedA[0]])).toEqual([TOKEN_A]);
    expect(requiredUnitTokensInObjectNames([wrappedA[1]])).toEqual([TOKEN_A]);
    expect(requiredUnitTokensInObjectNames([wrappedA[2]])).toEqual([TOKEN_A]);
    expect(requiredUnitTokensInObjectNames([`'${PLAIN_A}'`])).toEqual([TOKEN_A]);
    expect(
      requiredUnitTokensInObjectNames([`${PLAIN_A}_id_0_copy_0`, `${PLAIN_A}_id_1_copy_3`]),
    ).toEqual([TOKEN_A]);
  });

  it("reads nothing from a bare filename or a name the slicer normalizer does not unwrap", () => {
    expect(requiredUnitTokensInObjectNames(["shop-floor.gcode", "bracket.stl"])).toEqual([]);
    expect(requiredUnitTokensInObjectNames([`${PLAIN_A}_not_a_wrapper`])).toEqual([]);
    expect(requiredUnitTokensInObjectNames([null, undefined, ""])).toEqual([]);
  });
});

describe("recordedPrintsLockProductionMethod", () => {
  const packageTokens = [TOKEN_A, TOKEN_B];

  it("locks when any current-package unit is named, including through a slicer wrapper", () => {
    for (const objectName of wrappedA) {
      expect(recordedPrintsLockProductionMethod({
        profileId: 7,
        packageTokens,
        records: [{ profileId: 7, state: "watching", objectNames: [objectName] }],
      })).toBe(true);
    }
  });

  it("does not lock for a bare filename, another Build, a dismissed record, or an unselected unit", () => {
    expect(recordedPrintsLockProductionMethod({
      profileId: 7,
      packageTokens,
      records: [{ profileId: 7, state: "watching", objectNames: ["shop-floor.gcode"] }],
    })).toBe(false);
    expect(recordedPrintsLockProductionMethod({
      profileId: 7,
      packageTokens,
      records: [{ profileId: 8, state: "watching", objectNames: [wrappedA[0]] }],
    })).toBe(false);
    expect(recordedPrintsLockProductionMethod({
      profileId: 7,
      packageTokens,
      records: [{ profileId: 7, state: "dismissed", objectNames: [wrappedA[0]] }],
    })).toBe(false);
    expect(recordedPrintsLockProductionMethod({
      profileId: 7,
      packageTokens: [TOKEN_B],
      records: [{ profileId: 7, state: "verified", objectNames: [wrappedA[1]] }],
    })).toBe(false);
  });

  it("does not lock when the current package has no Required units", () => {
    expect(recordedPrintsLockProductionMethod({
      profileId: 7,
      packageTokens: [],
      records: [{ profileId: 7, state: "watching", objectNames: [PLAIN_A] }],
    })).toBe(false);
  });
});
