import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import AdmZip from "adm-zip";
import { ZipFile } from "yazl";
import { encodeAcceptedPlate3mf, type StlMesh } from "@print-partner/domain";
import {
  runWithTenantDiskQuota,
  TenantDiskQuotaError,
} from "../lib/tenant-disk-quota.js";
import { createSourceUploadStaging, extractZipFile, writeUploadedFiles, writeUploadedZip, discoverImportRules } from "./archive-import.js";

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

  it("uploads multiple files with relative paths", () => {
    const root = tempRoot();
    const result = writeUploadedFiles(
      [
        staged("parts/a.stl", Buffer.from("solid a")),
        staged("parts/b.stl", Buffer.from("solid b")),
      ],
      root,
    );
    expect(result.fileCount).toBe(2);
    expect(result.stlCount).toBe(2);
    expect(existsSync(join(result.extractDir, "parts/a.stl"))).toBe(true);
    expect(result.suggestedImportRules).toEqual(["parts/"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("cleans uploaded file staging when quota blocks a file write", async () => {
    const root = tempRoot();
    const sourcesDir = join(root, "sources");
    mkdirSync(sourcesDir);

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
          writeUploadedFiles(
            [staged("parts/a.stl", Buffer.from("solid a"))],
            sourcesDir,
          ),
      ),
    ).rejects.toBeInstanceOf(TenantDiskQuotaError);

    expect(existsSync(join(sourcesDir, "42", "files"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("leaves source upload writers unlimited when hosted quota is disabled", async () => {
    const root = tempRoot();
    const sourcesDir = join(root, "sources");
    mkdirSync(sourcesDir);
    const result = await runWithTenantDiskQuota(
      {
        dataDir: root,
        reposDir: join(root, "repos"),
        tenantId: "tenant-a",
        quotaBytes: null,
        sourceIds: () => [42],
      },
      async () =>
        writeUploadedFiles(
          [staged("parts/a.stl", Buffer.from("solid a"))],
          sourcesDir,
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
    const result = writeUploadedFiles(
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

    const extractDir = writeUploadedZip(stagedFile(zip.toBuffer()), root);

    expect(existsSync(join(extractDir, "models/assembly.3mf"))).toBe(true);
    expect(existsSync(join(extractDir, "_3mf/assembly/clip.stl"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects path traversal in uploaded file names", () => {
    const root = tempRoot();
    expect(() =>
      writeUploadedFiles(
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


describe("upload candidates", () => {
  it.each(["garbage", "truncated", "corrupt", "nested", "nested-truncated", "unsafe"])("preserves the previous working bytes for a %s ZIP", (kind) => {
    const root = tempRoot();
    mkdirSync(join(root, "42", "files"), { recursive: true });
    writeFileSync(join(root, "42", "files", "keep.stl"), "previous STL");
    writeFileSync(join(root, "42", "upload.zip"), "previous ZIP");
    const zip = new AdmZip();
    zip.addFile("new.stl", Buffer.from("candidate STL"));
    if (kind === "nested") zip.addFile("models/bad.3mf", Buffer.from("not-a-3mf"));
    if (kind === "nested-truncated") {
      const threeMf = encodeAcceptedPlate3mf([{ token: "clip", objectName: "Clip", xUm: 0, yUm: 0, mesh: triangle }]);
      zip.addFile("models/truncated.3mf", Buffer.from(threeMf.subarray(0, threeMf.length - 8)));
    }
    if (kind === "unsafe") addMaliciousEntry(zip, "../escape.stl", Buffer.from("escape"));
    let bytes = zip.toBuffer();
    if (kind === "garbage") bytes = Buffer.from("not-a-zip");
    if (kind === "truncated") bytes = bytes.subarray(0, bytes.length - 12);
    if (kind === "corrupt") {
      const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      bytes.writeUInt32LE(0, central + 16);
    }
    const candidate = createSourceUploadStaging(root);
    const incoming = join(candidate, "upload.zip");
    writeFileSync(incoming, bytes);
    expect(() => writeUploadedZip(incoming, candidate)).toThrow();
    expect(readFileSync(join(root, "42", "files", "keep.stl"), "utf8")).toBe("previous STL");
    expect(readFileSync(join(root, "42", "upload.zip"), "utf8")).toBe("previous ZIP");
    expect(readdirSync(candidate)).toEqual(["upload.zip"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("preserves previous files when a later uploaded filename is unsafe", () => {
    const root = tempRoot();
    mkdirSync(join(root, "42", "files"), { recursive: true });
    writeFileSync(join(root, "42", "files", "keep.stl"), "previous STL");
    const candidate = createSourceUploadStaging(root);
    expect(() => writeUploadedFiles([
      staged("ok.stl", Buffer.from("new STL")),
      staged("../escape.stl", Buffer.from("escape")),
    ], candidate)).toThrow(/escapes extraction directory/);
    expect(readFileSync(join(root, "42", "files", "keep.stl"), "utf8")).toBe("previous STL");
    expect(readdirSync(candidate)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts ZIP64 directories and entries", async () => {
    const root = tempRoot();
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    const finished = new Promise<Buffer>((resolve, reject) => {
      zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
      zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
      zip.outputStream.on("error", reject);
    });
    zip.addBuffer(Buffer.from("ZIP64 STL"), "part.stl", { forceZip64Format: true });
    zip.end({ forceZip64Format: true, comment: "supported ZIP64" });
    const incoming = stagedFile(await finished);
    const extracted = writeUploadedZip(incoming, root);
    expect(readFileSync(join(extracted, "part.stl"), "utf8")).toBe("ZIP64 STL");
    rmSync(root, { recursive: true, force: true });
  });
});
