import { describe, expect, it } from "vitest";
import { parsePhaseManifestText } from "./phase-manifest-route-model.js";

describe("parsePhaseManifestText", () => {
  it("accepts and normalizes a bare phase array", () => {
    expect(
      parsePhaseManifestText(
        JSON.stringify([
          { name: "Frame", folders: ["frame"], depends_on: ["prep", 4] },
          { name: "Panels", folders: ["panels"], order: 8 },
        ]),
      ),
    ).toEqual([
      { name: "Frame", folders: ["frame"], depends_on: ["prep"], order: 0 },
      { name: "Panels", folders: ["panels"], depends_on: [], order: 8 },
    ]);
  });

  it("accepts a wrapped phase array", () => {
    expect(
      parsePhaseManifestText(JSON.stringify({ phases: [{ name: "Prep", folders: [] }] })),
    ).toEqual([{ name: "Prep", folders: [], order: 0, depends_on: [] }]);
  });

  it("rejects invalid phase manifests", () => {
    expect(parsePhaseManifestText("not json")).toBeNull();
    expect(parsePhaseManifestText(JSON.stringify([]))).toBeNull();
    expect(parsePhaseManifestText(JSON.stringify([{ name: "", folders: [] }]))).toBeNull();
    expect(parsePhaseManifestText(JSON.stringify([{ name: "Prep", folders: [1] }]))).toBeNull();
  });
});
