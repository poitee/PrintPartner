import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import AdmZip from "adm-zip";
import { encodeAcceptedPlate3mf, type StlMesh } from "@print-partner/domain";
import {
  runWithTenantDiskQuota,
  TenantDiskQuotaError,
} from "../lib/tenant-disk-quota.js";
import {
  discoverImportRules,
  extractZipFile,
  stageUploadedFiles,
  stageUploadedZip,
} from "./archive-import.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "pp-archive-"));
}

function stagedFile(content: Buffer | Uint8Array): string {
  const path = join(mkdtempSync(join(tmpdir(), "pp-archive-staged-")), "upload");
  writeFileSync(path, content);
  return path;
}

function staged(relativePath: string, content: Buffer | Uint8Array): { relativePath: string; path: string } {
  return { relativePath, path: stagedFile(content) };
}

const triangle: StlMesh = {
  vertices: [[0, 0, 0], [10, 0, 0], [0, 5, 0]],
  faces: [[0, 1, 2]],
  bounds: { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 5, maxZ: 0, widthMm: 10, depthMm: 5, heightMm: 0 },
};

/** Re-terminate an archive with ZIP64 records and saturated classic counts, as large-archive writers do. */
function withZip64EndRecords(zip: Buffer): Buffer {
  const eocd = zip.length - 22;
  const entries = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12);
  record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(entries), 24);
  record.writeBigUInt64LE(BigInt(entries), 32);
  record.writeBigUInt64LE(BigInt(centralSize), 40);
  record.writeBigUInt64LE(BigInt(centralOffset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(eocd), 8);
  locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([zip.subarray(0, eocd), record, locator, end]);
}

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
    const count = extractZipFile(stagedFile(zip.toBuffer()), dest);

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
    expect(() => extractZipFile(stagedFile(zip.toBuffer()), dest)).toThrow(
      /escapes extraction directory/,
    );
    expect(existsSync(join(root, "evil.txt"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects deeply nested traversal entries", () => {
    const root = tempRoot();
    const zip = new AdmZip();
    addMaliciousEntry(zip, "a/b/../../../../tmp/evil.stl", Buffer.from("solid evil"));

    expect(() => extractZipFile(stagedFile(zip.toBuffer()), join(root, "files"))).toThrow(
      /escapes extraction directory/,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("neutralizes absolute entry paths under the destination", () => {
    const root = tempRoot();
    const zip = new AdmZip();
    addMaliciousEntry(zip, "/abs/part.stl", Buffer.from("solid abs"));

    const dest = join(root, "files");
    const count = extractZipFile(stagedFile(zip.toBuffer()), dest);
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
      extractZipFile(stagedFile(zip.toBuffer()), join(root, "files"), { maxEntries: 2 }),
    ).toThrow(/too many entries/);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects archives whose uncompressed size exceeds the limit", () => {
    const root = tempRoot();
    const zip = new AdmZip();
    zip.addFile("big.bin", Buffer.alloc(64 * 1024, 0));

    expect(() =>
      extractZipFile(stagedFile(zip.toBuffer()), join(root, "files"), {
        maxUncompressedBytes: 1024,
      }),
    ).toThrow(/uncompressed size exceeds limit/);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects bytes that are not a ZIP archive", () => {
    const root = tempRoot();
    expect(() => extractZipFile(stagedFile(Buffer.from("not a zip archive")), join(root, "files"))).toThrow(
      "Upload is not a complete ZIP archive",
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects an archive truncated before its central directory", () => {
    const root = tempRoot();
    const zip = new AdmZip();
    zip.addFile("parts/a.stl", Buffer.from("solid a"));
    zip.addFile("parts/b.stl", Buffer.from("solid b"));
    const bytes = zip.toBuffer();
    const centralOffset = bytes.readUInt32LE(bytes.length - 22 + 16);

    expect(() => extractZipFile(stagedFile(bytes.subarray(0, centralOffset)), join(root, "files"))).toThrow(
      "Upload is not a complete ZIP archive",
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects an archive with no files", () => {
    const root = tempRoot();
    const zip = new AdmZip();
    zip.addFile("empty/", Buffer.alloc(0));

    expect(() => extractZipFile(stagedFile(zip.toBuffer()), join(root, "files"))).toThrow(
      "ZIP archive contains no files",
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("extracts an archive whose entry count lives in the ZIP64 end record", () => {
    const root = tempRoot();
    const zip = new AdmZip();
    zip.addFile("parts/a.stl", Buffer.from("solid a"));

    const dest = join(root, "files");
    expect(extractZipFile(stagedFile(withZip64EndRecords(zip.toBuffer())), dest)).toBe(1);
    expect(existsSync(join(dest, "parts/a.stl"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("uploads multiple files with relative paths", () => {
    const root = tempRoot();
    const result = stageUploadedFiles(
      [
        staged("parts/a.stl", Buffer.from("solid a")),
        staged("parts/b.stl", Buffer.from("solid b")),
      ],
      root,
    );
    expect(existsSync(join(result.extractDir, "parts/b.stl"))).toBe(true);
    expect(result.stlCount).toBe(2);
    expect(existsSync(join(result.extractDir, "parts/a.stl"))).toBe(true);
    expect(result.suggestedImportRules).toEqual(["parts/"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("leaves the Source directory untouched when quota blocks a staged file write", async () => {
    const root = tempRoot();
    const sourcesDir = join(root, "sources");
    const staging = mkdtempSync(join(root, "staging-"));

    await expect(
      runWithTenantDiskQuota(
        {
          dataDir: root,
          reposDir: join(root, "repos"),
          tenantId: "tenant-a",
          quotaBytes: 3,
          sourceIds: () => [42],
        },
        async () =>
          stageUploadedFiles(
            [staged("parts/a.stl", Buffer.from("solid a"))],
            staging,
          ),
      ),
    ).rejects.toBeInstanceOf(TenantDiskQuotaError);

    expect(existsSync(join(sourcesDir, "42"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("leaves source upload writers unlimited when hosted quota is disabled", async () => {
    const root = tempRoot();
    const result = await runWithTenantDiskQuota(
      {
        dataDir: root,
        reposDir: join(root, "repos"),
        tenantId: "tenant-a",
        quotaBytes: null,
        sourceIds: () => [42],
      },
      async () =>
        stageUploadedFiles(
          [staged("parts/a.stl", Buffer.from("solid a"))],
          mkdtempSync(join(root, "staging-")),
        ),
    );

    expect(existsSync(join(result.extractDir, "parts/a.stl"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("includes a top-level 3MF in suggested import rules", () => {
    const root = tempRoot();
    const threeMf = encodeAcceptedPlate3mf([
      { token: "bracket", objectName: "Bracket", xUm: 0, yUm: 0, mesh: triangle },
    ]);
    const result = stageUploadedFiles(
      [staged("project.3mf", Buffer.from(threeMf))],
      root,
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

    const { extractDir } = stageUploadedZip(stagedFile(zip.toBuffer()), root);

    expect(existsSync(join(extractDir, "models/assembly.3mf"))).toBe(true);
    expect(existsSync(join(extractDir, "_3mf/assembly/clip.stl"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects path traversal in uploaded file names", () => {
    const root = tempRoot();
    expect(() =>
      stageUploadedFiles(
        [staged("../evil.stl", Buffer.from("solid"))],
        root,
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
