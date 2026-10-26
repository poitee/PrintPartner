import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, onTestFinished } from "vitest";
import { listStlRelativePaths, scanRepo } from "./scanner.js";

/** A temp directory removed when the current test finishes, pass or fail. */
function scratchDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function makeRepo(files: Record<string, string>): string {
  const root = scratchDir("pp-scan-");
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe("scanRepo", () => {
  it("imports all when rules null", () => {
    const root = makeRepo({
      "parts/a.stl": "solid",
      "b.stl": "solid",
    });
    expect(scanRepo(root, "base", null)).toHaveLength(2);
  });

  it("filters by import rules", () => {
    const root = makeRepo({
      "parts/keep.stl": "solid",
      "parts/skip.stl": "solid",
      "other.stl": "solid",
    });
    const parts = scanRepo(root, "base", ["parts/keep.stl"]);
    expect(parts).toHaveLength(1);
    expect(parts[0].relativePath).toBe("parts/keep.stl");
  });

  it("returns empty for empty rules", () => {
    const root = makeRepo({ "a.stl": "solid" });
    expect(scanRepo(root, "base", [])).toEqual([]);
  });

  it("does not follow directory symlinks outside or back into the source", () => {
    const root = makeRepo({ "inside.stl": "solid" });
    const outside = scratchDir("pp-scan-outside-");
    writeFileSync(join(outside, "outside.stl"), "solid");
    symlinkSync(outside, join(root, "linked-outside"), "dir");
    symlinkSync(root, join(root, "loop"), "dir");

    expect(scanRepo(root).map((part) => part.relativePath)).toEqual(["inside.stl"]);
  });

  it("does not follow a symbolic link used as the Source root", () => {
    const target = makeRepo({ "outside.stl": "solid" });
    const parent = scratchDir("pp-scan-root-link-");
    const rootLink = join(parent, "source");
    symlinkSync(target, rootLink, "dir");

    expect(scanRepo(rootLink)).toEqual([]);
    expect(listStlRelativePaths(rootLink)).toEqual([]);
  });
});
