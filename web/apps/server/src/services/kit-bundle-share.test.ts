import { describe, expect, it } from "vitest";
import {
  collectKitBundleSourceRefs,
  kitSourceRefFromRecord,
  kitSourceRefToExportRecord,
  kitUnmatchedSourceFromRef,
} from "./kit-bundle-share.js";

describe("kit-bundle-share", () => {
  it("merges sources array with layer project refs", () => {
    const refs = collectKitBundleSourceRefs({
      sources: [
        {
          name: "Voron",
          url: "https://github.com/a/voron",
          branch: "main",
          import_rules: ["STLs/"],
        },
      ],
      layers: [
        {
          layer_type: "addon",
          project: {
            name: "SB",
            url: "https://github.com/a/sb",
            branch: "main",
            import_rules: ["parts/"],
            manifest_community_slug: "voron-stealthburner",
          },
        },
      ],
    });
    expect(refs).toHaveLength(2);
    const sb = refs.find((r) => r.url.includes("/sb"));
    expect(sb?.import_rules).toEqual(["parts/"]);
    expect(sb?.manifest_community_slug).toBe("voron-stealthburner");
  });

  it("merges duplicate source entries by url", () => {
    const refs = collectKitBundleSourceRefs({
      sources: [
        {
          url: "https://github.com/a/voron",
          name: "Voron",
          import_rules: ["STLs/"],
        },
      ],
      layers: [
        {
          project: {
            url: "https://github.com/a/voron",
            name: "Voron 2.4",
            import_rules: ["STLs/frame/"],
            category: "frame",
          },
        },
      ],
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]?.name).toBe("Voron");
    expect(refs[0]?.import_rules).toEqual(["STLs/", "STLs/frame/"]);
    expect(refs[0]?.category).toBe("frame");
  });

  it("exports manifest community slug when present", () => {
    const exported = kitSourceRefToExportRecord(
      kitSourceRefFromRecord({
        name: "Repo",
        url: "https://github.com/a/b",
        manifest_community_slug: "ldo-2.4-sb-tap",
      })!,
    );
    expect(exported.manifest_community_slug).toBe("ldo-2.4-sb-tap");
  });

  it("preserves tag through export and unmatched-source records", () => {
    const ref = kitSourceRefFromRecord({
      name: "Pinned",
      url: "https://github.com/a/pinned",
      branch: "main",
      tag: "v1.2.3",
      import_rules: ["STLs/"],
    })!;
    expect(ref.tag).toBe("v1.2.3");

    const exported = kitSourceRefToExportRecord(ref);
    expect(exported.tag).toBe("v1.2.3");

    const unmatched = kitUnmatchedSourceFromRef(ref);
    expect(unmatched.tag).toBe("v1.2.3");
    expect(unmatched.branch).toBe("main");

    const roundTrip = kitSourceRefFromRecord(exported)!;
    expect(roundTrip.tag).toBe("v1.2.3");
  });

  it("merges tag when one source entry has it", () => {
    const refs = collectKitBundleSourceRefs({
      sources: [
        {
          url: "https://github.com/a/voron",
          name: "Voron",
          branch: "main",
          tag: "v2.4.3",
        },
      ],
      layers: [
        {
          project: {
            url: "https://github.com/a/voron",
            name: "Voron",
            branch: "main",
          },
        },
      ],
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]?.tag).toBe("v2.4.3");
  });
});
