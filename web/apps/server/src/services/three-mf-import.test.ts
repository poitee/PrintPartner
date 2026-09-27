import { encodeAcceptedPlate3mf, parseStlMesh, type StlMesh } from "@print-partner/domain";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { bufferChunks, type ByteChunk } from "../lib/byte-chunks.js";
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

function countingChunks(bytes: Uint8Array): { chunks: Iterable<ByteChunk>; consumed: () => number } {
  let consumed = 0;
  function* chunks(): Generator<ByteChunk> {
    for (const chunk of bufferChunks(bytes)) {
      consumed += chunk[0].length;
      yield chunk;
    }
  }
  return { chunks: chunks(), consumed: () => consumed };
}

describe("extractThreeMfMeshes", () => {
  it("preserves each mesh object as a stable, parseable STL", () => {
    const root = mkdtempSync(join(tmpdir(), "pp-3mf-"));
    const bytes = encodeAcceptedPlate3mf([
      { token: "one", objectName: "Front Bracket", xUm: 0, yUm: 0, mesh: triangle },
      { token: "two", objectName: "Front Bracket", xUm: 20_000, yUm: 0, mesh: triangle },
    ]);

    const result = extractThreeMfMeshes(bufferChunks(Buffer.from(bytes)), root, "My Project.3mf");

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
    expect(() => extractThreeMfMeshes(bufferChunks(Buffer.from("not a zip")), root, "bad.3mf"))
      .toThrow(/valid 3MF/i);
    rmSync(root, { recursive: true, force: true });
  });

  it("enforces object limits", () => {
    const root = mkdtempSync(join(tmpdir(), "pp-3mf-"));
    const bytes = encodeAcceptedPlate3mf([
      { token: "one", objectName: "one", xUm: 0, yUm: 0, mesh: triangle },
      { token: "two", objectName: "two", xUm: 0, yUm: 0, mesh: triangle },
    ]);
    expect(() => extractThreeMfMeshes(bufferChunks(Buffer.from(bytes)), root, "many.3mf", { maxObjects: 1 }))
      .toThrow(/too many mesh objects/i);
    rmSync(root, { recursive: true, force: true });
  });

  it("bounds derived STL bytes before retaining oversized output", () => {
    const root = mkdtempSync(join(tmpdir(), "pp-3mf-"));
    const bytes = encodeAcceptedPlate3mf([
      { token: "one", objectName: "one", xUm: 0, yUm: 0, mesh: triangle },
    ]);
    expect(() => extractThreeMfMeshes(bufferChunks(Buffer.from(bytes)), root, "part.3mf", { maxOutputBytes: 32 }))
      .toThrow(/derived STL output exceeds/i);
    expect(() => readFileSync(join(root, "_3mf/part/one.stl"))).toThrow();
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects invalid limits before reading archive contents", () => {
    const root = mkdtempSync(join(tmpdir(), "pp-3mf-"));
    const bytes = encodeAcceptedPlate3mf([
      { token: "one", objectName: "one", xUm: 0, yUm: 0, mesh: triangle },
    ]);
    expect(() => extractThreeMfMeshes(bufferChunks(Buffer.from(bytes)), root, "part.3mf", { maxModelBytes: -1 }))
      .toThrow(/positive integers/i);
    rmSync(root, { recursive: true, force: true });
  });

  it("stops reading the package once the model document is complete", () => {
    const root = mkdtempSync(join(tmpdir(), "pp-3mf-"));
    const entries = unzipSync(encodeAcceptedPlate3mf([
      { token: "one", objectName: "one", xUm: 0, yUm: 0, mesh: triangle },
    ]));
    const modelName = Object.keys(entries).find((name) => name.endsWith(".model"))!;
    const trailingBytes = 1024 * 1024;
    const pkg = zipSync({
      [modelName]: entries[modelName]!,
      "Metadata/trailing.bin": [new Uint8Array(trailingBytes), { level: 0 }],
    });
    const source = countingChunks(pkg);

    const result = extractThreeMfMeshes(source.chunks, root, "part.3mf");

    expect(result.objectCount).toBe(1);
    expect(source.consumed()).toBeLessThan(pkg.length - trailingBytes / 2);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses a model document by its declared size before reading its data", () => {
    const root = mkdtempSync(join(tmpdir(), "pp-3mf-"));
    const pkg = zipSync({
      "3D/3dmodel.model": [new Uint8Array(1024 * 1024).fill(0x20), { level: 0 }],
    });
    const source = countingChunks(pkg);

    expect(() => extractThreeMfMeshes(source.chunks, root, "part.3mf", { maxModelBytes: 1024 }))
      .toThrow(/model document exceeds the size limit/);
    expect(source.consumed()).toBeLessThanOrEqual(64 * 1024);
    rmSync(root, { recursive: true, force: true });
  });
});
