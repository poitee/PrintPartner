import { describe, expect, it } from "vitest";
import {
  DEFAULT_NAMING_PROFILE,
  mergeNamingProfiles,
  namingProfileFromDict,
  resolveNamingProfile,
  validateNamingProfile,
} from "./stl-naming.js";
import { parseStlPath } from "./parsers.js";

describe("stl-naming", () => {
  it("default profile matches legacy parser", () => {
    const p = parseStlPath("parts/[a]_foo_x4.stl");
    expect(p.role).toBe("accent");
    expect(p.quantity).toBe(4);
  });

  it("supports custom accent marker", () => {
    const base = structuredClone(DEFAULT_NAMING_PROFILE);
    base.roles = [
      { id: "primary", label: "Primary", markers: [] },
      { id: "accent", label: "Accent", markers: ["[accent]"] },
      { id: "clear", label: "Clear", markers: ["[c]"] },
      { id: "opaque", label: "Opaque", markers: ["[o]"] },
    ];
    const profile = namingProfileFromDict(validateNamingProfile(base));
    expect(parseStlPath("parts/[accent]_bracket.stl", profile).role).toBe("accent");
  });

  it("resolves source override quantity", () => {
    const global = validateNamingProfile(DEFAULT_NAMING_PROFILE);
    const metadata = {
      naming: {
        use_defaults: false,
        override: { quantity: { regex: String.raw`_qty([0-9]+)\.stl$`, default: 1 } },
      },
    };
    const resolved = resolveNamingProfile(global, metadata);
    expect(parseStlPath("widget_qty3.stl", resolved).quantity).toBe(3);
  });

  it("keeps a complete Source profile independent of later global changes", () => {
    const sourceProfile = structuredClone(DEFAULT_NAMING_PROFILE);
    sourceProfile.roles = [{ id: "primary", label: "Primary", markers: [] }];
    const changedGlobal = structuredClone(DEFAULT_NAMING_PROFILE);
    changedGlobal.roles.find((role) => role.id === "accent")!.markers = ["[new-accent]"];

    const resolved = resolveNamingProfile(validateNamingProfile(changedGlobal), {
      naming: { use_defaults: false, override: validateNamingProfile(sourceProfile) },
    });

    expect(resolved.roles).toEqual(sourceProfile.roles);
  });

  it("rejects bad regex", () => {
    const bad = structuredClone(DEFAULT_NAMING_PROFILE);
    bad.quantity = { regex: "(invalid[", default: 1 };
    expect(() => validateNamingProfile(bad)).toThrow(/invalid/i);
  });

  it("requires capture group", () => {
    const bad = structuredClone(DEFAULT_NAMING_PROFILE);
    bad.quantity = { regex: String.raw`\.stl$`, default: 1 };
    expect(() => validateNamingProfile(bad)).toThrow(/capture group/i);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["not finite", Number.POSITIVE_INFINITY],
    ["a string", "2"],
    ["null", null],
  ])("rejects %s default quantity", (_label, defaultQuantity) => {
    const bad = {
      ...structuredClone(DEFAULT_NAMING_PROFILE),
      quantity: {
        ...DEFAULT_NAMING_PROFILE.quantity,
        default: defaultQuantity,
      },
    };

    expect(() => validateNamingProfile(bad)).toThrow(/quantity\.default/i);
  });

  it.each([
    ["a non-object rule", "accent"],
    ["a blank path", { path_contains: "  ", role_id: "accent" }],
    ["an unknown role", { path_contains: "mods", role_id: "other" }],
    [
      "an unknown functional class",
      { path_contains: "mods", role_id: "accent", functional_class: "structural" },
    ],
  ])("rejects folder_rules containing %s", (_label, rule) => {
    const bad = {
      ...structuredClone(DEFAULT_NAMING_PROFILE),
      folder_rules: [rule],
    };

    expect(() => validateNamingProfile(bad)).toThrow(/folder_rules/i);
  });

  it("merges partial profiles", () => {
    const merged = mergeNamingProfiles(DEFAULT_NAMING_PROFILE, {
      roles: [{ id: "accent", markers: ["[accent]"] }],
      quantity: { regex: String.raw`_n([0-9]+)\.stl$`, default: 1 },
    });
    const profile = namingProfileFromDict(merged);
    expect(parseStlPath("part_n5.stl", profile).quantity).toBe(5);
    expect(parseStlPath("[accent]_part.stl", profile).role).toBe("accent");
  });
});
