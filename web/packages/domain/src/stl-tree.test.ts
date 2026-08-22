import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildStlTreePayload } from "./stl-tree.js";

describe("stl-tree", () => {
  it("marks checked files from import rules", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-tree-"));
    mkdirSync(join(dir, "a"), { recursive: true });
    writeFileSync(join(dir, "a", "one.stl"), "");
    writeFileSync(join(dir, "skip.stl"), "");
    const payload = buildStlTreePayload(dir, JSON.stringify(["a/"]));
    expect(payload.total).toBe(2);
    expect(payload.selected).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
