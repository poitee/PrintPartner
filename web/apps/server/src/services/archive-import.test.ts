import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import AdmZip from "adm-zip";
import { encodeAcceptedPlate3mf, type StlMesh } from "@print-partner/domain";
import { extractZipBuffer, writeUploadedFiles, writeUploadedZip, discoverImportRules } from "./archive-import.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "pp-archive-"));
}

const triangle: StlMesh = {
  vertices: [[0, 0, 0], [10, 0, 0], [0, 5, 0]],
  faces: [[0, 1, 2]],
  bounds: { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 5, maxZ: 0, widthMm: 10, depthMm: 5, heightMm: 0 },
};

/** adm-zip sanitizes names in addFile, so force a hostile entry name afterwards. */
function addMaliciousEntry(zip: AdmZip, name: string, data: Buffer): void {
  zip.addFile("placeholder-entry", data);
  const entry = zip.getEntries().find((e) => e.entryName === "placeholder-entry")!;
  entry.entryName = name;
}

describe("archive extraction hardening", () => {
  it("extracts a normal archive and counts STL files", () => {
    const root = tempRoot();
    const zip = new AdmZip();
    zip.addFile("README.md", Buffer.from("# Kit"));
    zip.addFile("parts/bracket.stl", Buffer.from("solid bracket"));
    zip.addFile("parts/nested/clip.STL", Buffer.from("solid clip"));

    const dest = join(root, "files");
    const count = extractZipBuffer(zip.toBuffer(), dest);

    expect(count).toBe(2);
    expect(existsSync(join(dest, "parts/bracket.stl"))).toBe(true);
    expect(existsSync(join(dest, "parts/nested/clip.STL"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects zip-slip entries that traverse out of the destination", () => {
    const root = tempRoot();
    const zip = new AdmZip();
    zip.addFile("ok.stl", Buffer.from("solid ok"));
    addMaliciousEntry(zip, "../evil.txt", Buffer.from("pwned"));

    const dest = join(root, "files");
    expect(() => extractZipBuffer(zip.toBuffer(), dest)).toThrow(
      /escapes extraction directory/,
    );
    expect(existsSync(join(root, "evil.txt"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects deeply nested traversal entries", () => {
    const root = tempRoot();
    const zip = new AdmZip();
    addMaliciousEntry(zip, "a/b/../../../../tmp/evil.stl", Buffer.from("solid evil"));

    expect(() => extractZipBuffer(zip.toBuffer(), join(root, "files"))).toThrow(
      /escapes extraction directory/,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("neutralizes absolute entry paths under the destination", () => {
    const root = tempRoot();
    const zip = new AdmZip();
    addMaliciousEntry(zip, "/abs/part.stl", Buffer.from("solid abs"));

    const dest = join(root, "files");
    const count = extractZipBuffer(zip.toBuffer(), dest);
    expect(count).toBe(1);
    expect(existsSync(join(dest, "abs/part.stl"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects archives with too many entries", () => {
    const root = tempRoot();
    const zip = new AdmZip();
    zip.addFile("a.txt", Buffer.from("a"));
    zip.addFile("b.txt", Buffer.from("b"));
    zip.addFile("c.txt", Buffer.from("c"));

    expect(() =>
      extractZipBuffer(zip.toBuffer(), join(root, "files"), { maxEntries: 2 }),
    ).toThrow(/too many entries/);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects archives whose uncompressed size exceeds the limit", () => {
    const root = tempRoot();
    const zip = new AdmZip();
    zip.addFile("big.bin", Buffer.alloc(64 * 1024, 0));

    expect(() =>
      extractZipBuffer(zip.toBuffer(), join(root, "files"), {
        maxUncompressedBytes: 1024,
      }),
    ).toThrow(/uncompressed size exceeds limit/);
    rmSync(root, { recursive: true, force: true });
  });

  it("uploads multiple files with relative paths", () => {
    const root = tempRoot();
    const result = writeUploadedFiles(
      [
        { relativePath: "parts/a.stl", buffer: Buffer.from("solid a") },
        { relativePath: "parts/b.stl", buffer: Buffer.from("solid b") },
      ],
      root,
      42,
    );
    expect(result.fileCount).toBe(2);
    expect(result.stlCount).toBe(2);
    expect(existsSync(join(result.extractDir, "parts/a.stl"))).toBe(true);
    expect(result.suggestedImportRules).toEqual(["parts/"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("includes a top-level 3MF in suggested import rules", () => {
    const root = tempRoot();
    const threeMf = encodeAcceptedPlate3mf([
      { token: "bracket", objectName: "Bracket", xUm: 0, yUm: 0, mesh: triangle },
    ]);
    const result = writeUploadedFiles(
      [{ relativePath: "project.3mf", buffer: Buffer.from(threeMf) }],
      root,
      43,
    );
    expect(result.stlCount).toBe(1);
    expect(existsSync(join(result.extractDir, "_3mf/project/bracket.stl"))).toBe(true);
    expect(result.suggestedImportRules).toEqual(["_3mf/", "project.3mf"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("expands 3MF projects nested in uploaded ZIP files", () => {
    const root = tempRoot();
    const threeMf = encodeAcceptedPlate3mf([
      { token: "clip", objectName: "Clip", xUm: 0, yUm: 0, mesh: triangle },
    ]);
    const zip = new AdmZip();
    zip.addFile("models/assembly.3mf", Buffer.from(threeMf));

    const extractDir = writeUploadedZip(zip.toBuffer(), root, 44);

    expect(existsSync(join(extractDir, "models/assembly.3mf"))).toBe(true);
    expect(existsSync(join(extractDir, "_3mf/assembly/clip.stl"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects path traversal in uploaded file names", () => {
    const root = tempRoot();
    expect(() =>
      writeUploadedFiles(
        [{ relativePath: "../evil.stl", buffer: Buffer.from("solid") }],
        root,
        1,
      ),
    ).toThrow(/escapes extraction directory/);
    rmSync(root, { recursive: true, force: true });
  });

  it("discovers import rules for a single top-level folder", () => {
    const root = tempRoot();
    const kit = join(root, "kit");
    mkdirSync(join(kit, "STLs"), { recursive: true });
    expect(discoverImportRules(kit)).toEqual(["STLs/"]);
    rmSync(root, { recursive: true, force: true });
  });
});
