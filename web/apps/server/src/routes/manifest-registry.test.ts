import { describe, expect, it } from "vitest";
import { parseRegistryIndex } from "./manifest.js";

describe("parseRegistryIndex", () => {
  it("parses complete entries regardless of YAML field order", () => {
    const registry = parseRegistryIndex(`
entries:
  - title: "LDO 2.4: Stealthburner"
    status: proposed
    manifest_file: ldo/manifest.yaml
    slug: ldo-2.4
    target_repo: LDOVoron2
`);

    expect(registry).toEqual({
      entries: [
        {
          slug: "ldo-2.4",
          target_repo: "LDOVoron2",
          title: "LDO 2.4: Stealthburner",
          manifest_file: "ldo/manifest.yaml",
          status: "proposed",
        },
      ],
    });
  });

  it("rejects malformed or incomplete registry documents", () => {
    expect(() => parseRegistryIndex("entries: nope")).toThrow(/entries array/i);
    expect(() => parseRegistryIndex("entries:\n  - slug: incomplete\n")).toThrow(
      /target_repo/i,
    );
  });
});
