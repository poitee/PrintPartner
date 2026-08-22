import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCaseInsensitiveRepoPath } from "./part-paths.js";

describe("resolveRepoStlPath", () => {
  it("falls back to case-insensitive lookup when exact path differs", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-stl-path-"));
    mkdirSync(join(dir, "STLs"), { recursive: true });
    const stl = join(dir, "STLs", "Part.stl");
    writeFileSync(stl, "solid");
    expect(resolveCaseInsensitiveRepoPath(dir, "stls/part.stl")).toBe(stl);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no file matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-stl-miss-"));
    expect(resolveCaseInsensitiveRepoPath(dir, "missing/file.stl")).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
