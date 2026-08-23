import { encodeAcceptedPlate3mf, parseStlMesh, type StlMesh } from "@print-partner/domain";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractThreeMfMeshes } from "./three-mf-import.js";

const triangle: StlMesh = {
  vertices: [[0, 0, 0], [10, 0, 0], [0, 5, 0]],
  faces: [[0, 1, 2]],
  bounds: {
    minX: 0, minY: 0, minZ: 0,
    maxX: 10, maxY: 5, maxZ: 0,
    widthMm: 10, depthMm: 5, heightMm: 0,
  },
};

describe("extractThreeMfMeshes", () => {
  it("preserves each mesh object as a stable, parseable STL", () => {
    const root = mkdtempSync(join(tmpdir(), "pp-3mf-"));
    const bytes = encodeAcceptedPlate3mf([
      { token: "one", objectName: "Front Bracket", xUm: 0, yUm: 0, mesh: triangle },
      { token: "two", objectName: "Front Bracket", xUm: 20_000, yUm: 0, mesh: triangle },
    ]);

    const result = extractThreeMfMeshes(Buffer.from(bytes), root, "My Project.3mf");

    expect(result.files.map((file) => file.relativePath)).toEqual([
      "_3mf/my-project/front-bracket.stl",
      "_3mf/my-project/front-bracket-2.stl",
    ]);
    expect(result.objectCount).toBe(2);
    expect(parseStlMesh(readFileSync(join(root, result.files[0]!.relativePath)))).not.toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects malformed 3MF packages", () => {
    const root = mkdtempSync(join(tmpdir(), "pp-3mf-"));
    expect(() => extractThreeMfMeshes(Buffer.from("not a zip"), root, "bad.3mf"))
      .toThrow(/valid 3MF/i);
    rmSync(root, { recursive: true, force: true });
  });

  it("enforces object limits", () => {
    const root = mkdtempSync(join(tmpdir(), "pp-3mf-"));
    const bytes = encodeAcceptedPlate3mf([
      { token: "one", objectName: "one", xUm: 0, yUm: 0, mesh: triangle },
      { token: "two", objectName: "two", xUm: 0, yUm: 0, mesh: triangle },
    ]);
    expect(() => extractThreeMfMeshes(Buffer.from(bytes), root, "many.3mf", { maxObjects: 1 }))
      .toThrow(/too many mesh objects/i);
    rmSync(root, { recursive: true, force: true });
  });

  it("bounds derived STL bytes before retaining oversized output", () => {
    const root = mkdtempSync(join(tmpdir(), "pp-3mf-"));
    const bytes = encodeAcceptedPlate3mf([
      { token: "one", objectName: "one", xUm: 0, yUm: 0, mesh: triangle },
    ]);
    expect(() => extractThreeMfMeshes(Buffer.from(bytes), root, "part.3mf", { maxOutputBytes: 32 }))
      .toThrow(/derived STL output exceeds/i);
    expect(() => readFileSync(join(root, "_3mf/part/one.stl"))).toThrow();
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects invalid limits before reading archive contents", () => {
    const root = mkdtempSync(join(tmpdir(), "pp-3mf-"));
    const bytes = encodeAcceptedPlate3mf([
      { token: "one", objectName: "one", xUm: 0, yUm: 0, mesh: triangle },
    ]);
    expect(() => extractThreeMfMeshes(Buffer.from(bytes), root, "part.3mf", { maxModelBytes: -1 }))
      .toThrow(/positive integers/i);
    rmSync(root, { recursive: true, force: true });
  });
});
