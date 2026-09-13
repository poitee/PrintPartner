import { describe, expect, it } from "vitest";
import type { ReferenceShare } from "@print-partner/contracts";
import {
  BOARD_CAPTION_MAX,
  BOARD_COMMENT_MAX,
  coverUrlFromSnapshot,
  freezeBuildSnapshot,
  normalizeBoardCaption,
  normalizeBoardComment,
} from "./board-model.js";

function buildSnapshot(overrides: Partial<ReferenceShare> = {}): ReferenceShare {
  return {
    format: "printpartner-reference-share",
    version: 1,
    kind: "build",
    title: "Voron 2.4",
    sources: [
      {
        key: "source-1",
        name: "Voron",
        location: { kind: "publisher", url: "https://github.com/VoronDesign/Voron-2" },
        revision: { branch: "main", tag: null, commit: null },
        file_rules: [],
      },
    ],
    layers: [{ source: "source-1", role: "base" }],
    selections: {},
    include: [],
    exclude: [],
    replacements: {},
    parts: [],
    ...overrides,
  };
}

describe("board-model", () => {
  it("trims captions and rejects empty or oversized text", () => {
    expect(normalizeBoardCaption("  First print  ")).toBe("First print");
    expect(normalizeBoardCaption("")).toBeNull();
    expect(normalizeBoardCaption("  ")).toBeNull();
    expect(normalizeBoardCaption("x".repeat(BOARD_CAPTION_MAX))).toHaveLength(BOARD_CAPTION_MAX);
    expect(normalizeBoardCaption("x".repeat(BOARD_CAPTION_MAX + 1))).toBeNull();
  });

  it("trims comments and caps them at 2000 characters", () => {
    expect(normalizeBoardComment("  nice  ")).toBe("nice");
    expect(normalizeBoardComment("")).toBeNull();
    expect(normalizeBoardComment("x".repeat(BOARD_COMMENT_MAX + 1))).toBeNull();
  });

  it("freezes a build snapshot as compact JSON and rejects collections", () => {
    const frozen = freezeBuildSnapshot(buildSnapshot());
    expect(frozen?.title).toBe("Voron 2.4");
    expect(JSON.parse(frozen!.json)).toMatchObject({ kind: "build", title: "Voron 2.4" });
    expect(freezeBuildSnapshot({ ...buildSnapshot(), kind: "collection" })).toBeNull();
  });

  it("takes a GitHub OpenGraph cover from the first publisher URL", () => {
    expect(coverUrlFromSnapshot(buildSnapshot())).toBe(
      "https://opengraph.githubassets.com/1/VoronDesign/Voron-2",
    );
    const printablesFirst = buildSnapshot({
      sources: [
        {
          key: "source-1",
          name: "Printables model",
          location: { kind: "publisher", url: "https://www.printables.com/model/1" },
          revision: { branch: null, tag: null, commit: null },
          file_rules: [],
        },
        {
          key: "source-2",
          name: "GitHub",
          location: { kind: "publisher", url: "https://github.com/a/b" },
          revision: { branch: "main", tag: null, commit: null },
          file_rules: [],
        },
      ],
      layers: [
        { source: "source-1", role: "base" },
        { source: "source-2", role: "mods" },
      ],
    });
    expect(coverUrlFromSnapshot(printablesFirst)).toBe(
      "https://opengraph.githubassets.com/1/a/b",
    );
    expect(
      coverUrlFromSnapshot(
        buildSnapshot({
          sources: [
            {
              key: "source-1",
              name: "Zip only",
              location: { kind: "manual" },
              revision: { branch: null, tag: null, commit: null },
              file_rules: [],
            },
          ],
        }),
      ),
    ).toBeNull();
  });
});
