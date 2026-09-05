import { describe, expect, it } from "vitest";
import {
  applyOptionGroupSelections,
  loadManifestYaml,
  manifestSelectionsInputError,
  optionGroupSelectionIsComplete,
} from "./manifest-apply.js";

describe("manifest option-group selection", () => {
  it.each([
    ["- invalid", "manifest must be an object"],
    ["option_groups: []", "option_groups must be an object"],
    ["option_groups: null", "option_groups must be an object"],
    ["selections: null", "selections must be an object"],
    [
      "option_groups:\n  extras: invalid",
      "option_groups.extras must be an object",
    ],
  ])("rejects non-object manifest structures", (manifest, message) => {
    expect(() => loadManifestYaml(manifest)).toThrow(message);
  });

  it.each([
    ["optional", "pick_any", 0],
    ["required", "pick_n", 1],
  ])("rejects an empty %s repository default", (_label, rule, minimum) => {
    expect(() => loadManifestYaml(`option_groups:
  extras:
    rule: ${rule}
    min: ${minimum}
    variants: []
selections:
  extras: []
`)).toThrow("selections.extras must contain at least one variant id");
  });

  it("accepts an empty required plan override but keeps it incomplete", () => {
    const requiredGroup = {
      rule: "pick_any" as const,
      parts: [],
      variants: [],
      min: 1,
    };

    expect(
      manifestSelectionsInputError({ extras: requiredGroup }, { extras: [] }),
    ).toBeNull();
    expect(optionGroupSelectionIsComplete(requiredGroup, [])).toBe(false);
    expect(
      manifestSelectionsInputError(
        { toolhead: { ...requiredGroup, rule: "pick_one" } },
        { toolhead: [] },
      ),
    ).toBe("kit.selections.toolhead must contain at least one variant id");
    expect(manifestSelectionsInputError({}, { retired: [] })).toBeNull();
  });

  it("never lets another group's patterns overwrite explicit membership", () => {
    const selected = applyOptionGroupSelections(
      [{ partKey: "shared.stl", optionGroupId: "first", included: false }],
      {
        first: {
          rule: "pick_one",
          parts: ["shared.stl"],
          variants: [{ id: "yes", parts: ["shared.stl"] }],
        },
        second: {
          rule: "pick_one",
          parts: ["shared.stl"],
          variants: [{ id: "no", parts: ["other.stl"] }],
        },
      },
      { first: "yes", second: "no" },
    );

    expect(selected).toEqual([
      { partKey: "shared.stl", optionGroupId: "first", included: true },
    ]);
  });

  it("includes the union of variants selected from a pick_any group", () => {
    const selected = applyOptionGroupSelections(
      [
        { partKey: "mods/skirts/front.stl", optionGroupId: "extras", included: false },
        { partKey: "mods/panels/rear.stl", optionGroupId: "extras", included: false },
        { partKey: "mods/screen/mount.stl", optionGroupId: "extras", included: true },
      ],
      {
        extras: {
          rule: "pick_any",
          parts: [],
          variants: [
            { id: "skirts", parts: ["mods/skirts/**"] },
            { id: "panels", parts: ["mods/panels/**"] },
            { id: "screen", parts: ["mods/screen/**"] },
          ],
        },
      },
      { extras: ["skirts", "panels"] },
    );

    expect(selected.map((part) => [part.partKey, part.included])).toEqual([
      ["mods/skirts/front.stl", true],
      ["mods/panels/rear.stl", true],
      ["mods/screen/mount.stl", false],
    ]);
  });

  it("selects no pick_n parts until its inclusive bounds are satisfied", () => {
    const group = {
      choices: {
        rule: "pick_n" as const,
        parts: [],
        variants: [
          { id: "a", parts: ["a.stl"] },
          { id: "b", parts: ["b.stl"] },
          { id: "c", parts: ["c.stl"] },
        ],
        min: 2,
        max: 2,
      },
    };
    const parts = [
      { partKey: "a.stl", optionGroupId: "choices", included: true },
      { partKey: "b.stl", optionGroupId: "choices", included: true },
      { partKey: "c.stl", optionGroupId: "choices", included: true },
    ];

    expect(
      applyOptionGroupSelections(parts, group, { choices: ["a"] }).every(
        (part) => !part.included,
      ),
    ).toBe(true);
    expect(
      applyOptionGroupSelections(parts, group, { choices: ["a", "b"] }).map(
        (part) => part.included,
      ),
    ).toEqual([true, true, false]);
    expect(
      applyOptionGroupSelections(parts, group, { choices: ["a", "b", "c"] }).every(
        (part) => !part.included,
      ),
    ).toBe(true);
    expect(
      applyOptionGroupSelections(parts, group, { choices: ["a", "removed"] }).every(
        (part) => !part.included,
      ),
    ).toBe(true);
  });

  it("applies selected variant exclusions outside its included parts", () => {
    const selected = applyOptionGroupSelections(
      [
        { partKey: "parts/addon.stl", optionGroupId: null, included: false },
        { partKey: "parts/stock.stl", optionGroupId: null, included: true },
      ],
      {
        toolhead: {
          rule: "pick_one",
          parts: [],
          variants: [
            { id: "stock", parts: ["parts/stock.stl"] },
            {
              id: "addon",
              parts: ["parts/addon.stl"],
              excludes: ["parts/stock.stl"],
            },
          ],
        },
      },
      { toolhead: "addon" },
    );

    expect(selected.map((part) => part.included)).toEqual([true, false]);
  });

  it("preserves base parts when no variant is selected", () => {
    const selected = applyOptionGroupSelections(
      [{ partKey: "parts/base.stl", optionGroupId: null, included: true }],
      {
        toolhead: {
          rule: "pick_one",
          parts: [],
          variants: [
            {
              id: "addon",
              parts: ["parts/addon.stl"],
              excludes: ["parts/base.stl"],
            },
          ],
        },
      },
      {},
    );

    expect(selected).toEqual([
      { partKey: "parts/base.stl", optionGroupId: null, included: true },
    ]);
  });

  it("ignores exclusions from variants that were not selected", () => {
    const selected = applyOptionGroupSelections(
      [
        { partKey: "parts/base.stl", optionGroupId: null, included: true },
        { partKey: "parts/stock.stl", optionGroupId: null, included: false },
      ],
      {
        toolhead: {
          rule: "pick_one",
          parts: [],
          variants: [
            { id: "stock", parts: ["parts/stock.stl"] },
            {
              id: "addon",
              parts: ["parts/addon.stl"],
              excludes: ["parts/base.stl"],
            },
          ],
        },
      },
      { toolhead: "stock" },
    );

    expect(selected.map((part) => [part.partKey, part.included])).toEqual([
      ["parts/base.stl", true],
      ["parts/stock.stl", true],
    ]);
  });

  it.each([
    ["exclusion group first", ["remove", "keep"]],
    ["exclusion group last", ["keep", "remove"]],
  ])("gives selected exclusions global precedence with the %s", (_label, order) => {
    const removingGroup = {
      rule: "pick_one" as const,
      parts: [],
      variants: [{
        id: "replacement",
        parts: ["parts/replacement.stl"],
        excludes: ["parts/shared.stl"],
      }],
    };
    const keepingGroup = {
      rule: "pick_one" as const,
      parts: [],
      variants: [{ id: "shared", parts: ["parts/shared.stl"] }],
    };
    const groups = Object.fromEntries(order.map((groupId) => [
      groupId,
      groupId === "remove" ? removingGroup : keepingGroup,
    ]));

    const selected = applyOptionGroupSelections(
      [
        { partKey: "parts/shared.stl", optionGroupId: null, included: true },
        { partKey: "parts/replacement.stl", optionGroupId: null, included: false },
      ],
      groups,
      { remove: "replacement", keep: "shared" },
    );

    expect(selected.map((part) => [part.partKey, part.included])).toEqual([
      ["parts/shared.stl", false],
      ["parts/replacement.stl", true],
    ]);
  });

  it("preserves explicit ownership from another group's selected exclusion", () => {
    const selected = applyOptionGroupSelections(
      [{ partKey: "parts/shared.stl", optionGroupId: "keep", included: false }],
      {
        remove: {
          rule: "pick_one",
          parts: [],
          variants: [{
            id: "replacement",
            parts: ["parts/replacement.stl"],
            excludes: ["parts/shared.stl"],
          }],
        },
        keep: {
          rule: "pick_one",
          parts: ["parts/shared.stl"],
          variants: [{ id: "shared", parts: ["parts/shared.stl"] }],
        },
      },
      { remove: "replacement", keep: "shared" },
    );

    expect(selected).toEqual([
      { partKey: "parts/shared.stl", optionGroupId: "keep", included: true },
    ]);
  });

  it.each([
    ["including group first", ["include", "other"]],
    ["including group last", ["other", "include"]],
  ])("includes the union of selected groups with the %s", (_label, order) => {
    const includingGroup = {
      rule: "pick_one" as const,
      parts: [],
      variants: [{ id: "shared", parts: ["parts/shared.stl"] }],
    };
    const otherGroup = {
      rule: "pick_one" as const,
      parts: ["parts/shared.stl"],
      variants: [{ id: "other", parts: ["parts/other.stl"] }],
    };
    const groups = Object.fromEntries(order.map((groupId) => [
      groupId,
      groupId === "include" ? includingGroup : otherGroup,
    ]));

    const selected = applyOptionGroupSelections(
      [{ partKey: "parts/shared.stl", optionGroupId: null, included: false }],
      groups,
      { include: "shared", other: "other" },
    );

    expect(selected).toEqual([
      { partKey: "parts/shared.stl", optionGroupId: null, included: true },
    ]);
  });

  it("honors an explicit zero maximum on a pick_one group", () => {
    expect(() =>
      loadManifestYaml(`option_groups:
  disabled:
    rule: pick_one
    max: 0
    variants:
      - id: legacy
        parts: ["legacy/**"]
selections:
  disabled: legacy
`),
    ).toThrow("selections.disabled must contain no more than 0 variant ids");
  });
});
