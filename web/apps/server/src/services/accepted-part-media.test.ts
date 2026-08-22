import { describe, expect, it } from "vitest";
import type { AcceptedOperationalPart } from "../db/accepted-plan-operational.js";
import {
  ACCEPTED_PART_MESH_MAX_BYTES,
  acceptedPartMediaIdentity,
} from "./accepted-part-media.js";

function part(
  overrides: Partial<
    Pick<
      AcceptedOperationalPart,
      "artifact" | "effectiveRole" | "filamentColorId" | "filamentCustomHex"
    >
  > = {},
): Pick<
  AcceptedOperationalPart,
  "artifact" | "effectiveRole" | "filamentColorId" | "filamentCustomHex"
> {
  return {
    artifact: {
      kind: "tracked",
      sourceId: 1,
      sourceRevisionId: 2,
      snapshotRoot: "/accepted/source",
      relativePath: "part.stl",
      expectedSha256: "a".repeat(64),
    },
    effectiveRole: " Primary ",
    filamentColorId: null,
    filamentCustomHex: null,
    ...overrides,
  };
}

describe("acceptedPartMediaIdentity", () => {
  it("owns the accepted mesh byte limit", () => {
    expect(ACCEPTED_PART_MESH_MAX_BYTES).toBe(15 * 1024 * 1024);
  });

  it("returns the normalized accepted custom color and full derivative basis", () => {
    expect(
      acceptedPartMediaIdentity(
        part({ filamentCustomHex: " #AbCdEf " }),
        "thumbnail",
      ),
    ).toEqual({
      hex: "#abcdef",
      basis: "45845a1f88700fea820122a66735163f0553d932bb688ecf0a0242cd55239c6e",
    });
  });

  it("falls back to the bundled catalog only when the custom color is invalid", () => {
    const identity = acceptedPartMediaIdentity(
      part({
        filamentCustomHex: "not-a-color",
        filamentColorId: "abs-matte::black-pantone-7c",
      }),
      "preview",
    );

    expect(identity.hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(identity.basis).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses no color when neither accepted color source resolves", () => {
    expect(
      acceptedPartMediaIdentity(
        part({ filamentCustomHex: "bad", filamentColorId: "missing-color" }),
        "mesh",
      ).hex,
    ).toBeNull();
  });

  it("rejects accepted Parts without tracked artifact identity", () => {
    expect(() =>
      acceptedPartMediaIdentity(
        part({ artifact: { kind: "unavailable", reason: "legacy" } }),
        "mesh",
      ),
    ).toThrow("Accepted Part artifact is unavailable");
  });
});
