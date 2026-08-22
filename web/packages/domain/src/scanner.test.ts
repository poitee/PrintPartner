import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { scanRepo } from "./scanner.js";

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pp-scan-"));
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
});
