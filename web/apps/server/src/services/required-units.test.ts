import { describe, expect, it } from "vitest";
import {
  digestRequiredUnitMap,
  generateRequiredUnitToken,
  parseRequiredUnitToken,
  requiredUnitObjectName,
  validateRequiredUnitObjectName,
} from "./required-units.js";

const token = "ppu_8f10c9db66c14e84b24633979fce9134";

describe("Required-unit identity", () => {
  it("creates and parses only canonical 128-bit tokens", () => {
    expect(
      generateRequiredUnitToken(() =>
        Uint8Array.from([143, 16, 201, 219, 102, 193, 78, 132, 178, 70, 51, 151, 159, 206, 145, 52]),
      ),
    ).toBe(token);
    expect(parseRequiredUnitToken(token)).toBe(token);
    for (const invalid of [
      token.toUpperCase(),
      token.slice(0, -1),
      `${token}0`,
      "ppu_8f10c9db66c14e84b24633979fce913g",
      "8f10c9db66c14e84b24633979fce9134",
    ]) {
      expect(() => parseRequiredUnitToken(invalid)).toThrow(/token/i);
    }
  });

  it("builds bounded Object names with the complete terminal token", () => {
    expect(requiredUnitObjectName("parts/front<bracket>.STL", token)).toBe(
      `front_bracket___${token}`,
    );
    expect(requiredUnitObjectName(".stl", token)).toBe(`part__${token}`);
    const exact = requiredUnitObjectName(`${"a".repeat(162)}.stl`, token);
    expect(exact).toHaveLength(200);
    expect(exact.endsWith(`__${token}`)).toBe(true);
    const long = requiredUnitObjectName(`${"b".repeat(500)}.stl`, token);
    expect(long).toHaveLength(200);
    expect(long.endsWith(token)).toBe(true);
  });

  it("replaces non-ASCII and control whitespace and rejects stored corruption", () => {
    for (const unsafeWhitespace of ["\t", "\n", "\r", "\u00a0", "\u2003"]) {
      const sanitized = requiredUnitObjectName(`left${unsafeWhitespace}right.stl`, token);
      expect(sanitized).toBe(`left_right__${token}`);
      expect(() =>
        validateRequiredUnitObjectName(`left${unsafeWhitespace}right__${token}`, token),
      ).toThrow(/Object name/i);
    }
    const ordinarySpace = `left right__${token}`;
    expect(requiredUnitObjectName("left right.stl", token)).toBe(ordinarySpace);
    expect(() => validateRequiredUnitObjectName(ordinarySpace, token)).not.toThrow();
  });

  it("digests canonical mapping order and Object names", () => {
    const rows = [
      { revisionPartId: 9, unitIndex: 1, token, objectName: `bracket__${token}` },
      {
        revisionPartId: 8,
        unitIndex: 0,
        token: "ppu_00000000000000000000000000000001",
        objectName: "frame__ppu_00000000000000000000000000000001",
      },
    ];
    const left = digestRequiredUnitMap({ revisionId: 4, expectedUnitCount: 2, rows });
    const right = digestRequiredUnitMap({
      revisionId: 4,
      expectedUnitCount: 2,
      rows: [...rows].reverse(),
    });
    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(right).toBe(left);
    expect(
      digestRequiredUnitMap({
        revisionId: 4,
        expectedUnitCount: 2,
        rows: [{ ...rows[0]!, objectName: `changed__${token}` }, rows[1]!],
      }),
    ).not.toBe(left);
  });
});
