import { describe, expect, it } from "vitest";
import {
  currentPackageDispatchCoverage,
  recordedPrintsLockProductionMethod,
  recordedTokensForCurrentDispatch,
  requiredUnitTokensInObjectNames,
} from "./production-unit-identity.js";

const TOKEN_A = `ppu_${"a".repeat(32)}`;
const TOKEN_B = `ppu_${"b".repeat(32)}`;
const TOKEN_C = `ppu_${"c".repeat(32)}`;
const TOKEN_D = `ppu_${"d".repeat(32)}`;

describe("requiredUnitTokensInObjectNames", () => {
  it("reads a token that ends a canonical object name", () => {
    expect(requiredUnitTokensInObjectNames([`bracket__${TOKEN_A}`])).toEqual([TOKEN_A]);
  });

  it("reads tokens after the slicer parser unwraps Orca and Prusa copy suffixes", () => {
    expect(
      requiredUnitTokensInObjectNames([
        `bracket__${TOKEN_A}_id_0_copy_0`,
        `clip__${TOKEN_B}__instance_1`,
        `frame__${TOKEN_C} (instance 2)`,
      ]),
    ).toEqual([TOKEN_A, TOKEN_B, TOKEN_C]);
  });

  it("keeps a token only at the end of the unwrapped name", () => {
    expect(
      requiredUnitTokensInObjectNames([
        "shop-floor.gcode",
        `bracket__${TOKEN_A}_extra`,
        `note__${TOKEN_A}__${TOKEN_B}`,
        null,
        undefined,
      ]),
    ).toEqual([TOKEN_B]);
  });
});

describe("recordedPrintsLockProductionMethod", () => {
  it("locks when one decorated label names a unit in the current package", () => {
    expect(
      recordedPrintsLockProductionMethod({
        profileId: 1,
        packageTokens: [TOKEN_A, TOKEN_B, TOKEN_C],
        records: [
          {
            profileId: 1,
            state: "watching",
            objectNames: [`bracket__${TOKEN_A}_id_0_copy_0`],
          },
        ],
      }),
    ).toBe(true);
  });

  it("does not lock a metadata-free past file or a unit outside the package", () => {
    expect(
      recordedPrintsLockProductionMethod({
        profileId: 1,
        packageTokens: [TOKEN_B, TOKEN_C],
        records: [
          {
            profileId: 1,
            state: "verified",
            objectNames: ["shop-floor.gcode", `bracket__${TOKEN_A}__instance_1`],
          },
        ],
      }),
    ).toBe(false);
  });
});

describe("recordedTokensForCurrentDispatch", () => {
  it("drops a finished unit's verified record and keeps a later send", () => {
    expect(recordedTokensForCurrentDispatch({
      completedTokens: [TOKEN_A],
      records: [
        { state: "verified", objectNames: [`bracket__${TOKEN_A}`] },
        { state: "applied", objectNames: [`bracket__${TOKEN_A}_id_0_copy_0`] },
      ],
    })).toEqual([]);
    expect(recordedTokensForCurrentDispatch({
      completedTokens: [TOKEN_A],
      records: [
        { state: "verified", objectNames: [`bracket__${TOKEN_A}`] },
        { state: "watching", objectNames: [`bracket__${TOKEN_A}__instance_1`] },
      ],
    })).toEqual([TOKEN_A]);
  });

  it("keeps a verified record for a unit that is still open", () => {
    expect(recordedTokensForCurrentDispatch({
      completedTokens: [TOKEN_B],
      records: [
        { state: "verified", objectNames: [`bracket__${TOKEN_A}`, `clip__${TOKEN_B}`] },
        { state: "dismissed", objectNames: [`frame__${TOKEN_C}`] },
      ],
    })).toEqual([TOKEN_A]);
  });
});

describe("currentPackageDispatchCoverage", () => {
  it("is none for an empty package or a recorded token outside it", () => {
    expect(
      currentPackageDispatchCoverage({ packageTokens: [], recordedTokens: [TOKEN_A] }),
    ).toBe("none");
    expect(
      currentPackageDispatchCoverage({
        packageTokens: [TOKEN_A, TOKEN_B, TOKEN_C],
        recordedTokens: [TOKEN_D],
      }),
    ).toBe("none");
  });

  it("is partial when one of three Required units was recorded", () => {
    expect(
      currentPackageDispatchCoverage({
        packageTokens: [TOKEN_A, TOKEN_B, TOKEN_C],
        recordedTokens: [TOKEN_A],
      }),
    ).toBe("partial");
  });

  it("is full only when every current package token was recorded", () => {
    expect(
      currentPackageDispatchCoverage({
        packageTokens: [TOKEN_A, TOKEN_B, TOKEN_C],
        recordedTokens: [TOKEN_C, TOKEN_A, TOKEN_D, TOKEN_B],
      }),
    ).toBe("full");
  });
});
