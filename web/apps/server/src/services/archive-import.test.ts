import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import AdmZip from "adm-zip";
import { ZipFile } from "yazl";
import { encodeAcceptedPlate3mf, type StlMesh } from "@print-partner/domain";
import { runWithTenantDiskQuota } from "../lib/tenant-disk-quota.js";
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
  it.each(["zip", "files"])("shares validation bytes between outer content and nested packages in a %s upload", (kind) => {
    const root = tempRoot();
    const nested = new AdmZip(Buffer.from(encodeAcceptedPlate3mf([
      { token: "clip", objectName: "Clip", xUm: 0, yUm: 0, mesh: triangle },
    ])));
    nested.addFile("padding.bin", Buffer.alloc(4096));
    const bytes = nested.toBuffer();
    const limit = bytes.length + nested.getEntries().reduce((total, entry) => total + entry.header.size, 0);
    const upload = (maxUncompressedBytes: number): string => {
      const staging = createSourceUploadStaging(root, "default");
      if (kind === "files") return writeUploadedFiles([staged("clip.3mf", bytes)], staging, { maxUncompressedBytes }).extractDir;
      const zip = new AdmZip();
      zip.addFile("clip.3mf", bytes);
      return writeUploadedZip(stagedFile(zip.toBuffer()), staging, { maxUncompressedBytes });
    };
    try {
      expect(() => upload(limit - 1)).toThrow("Nested 3MF uncompressed size exceeds limit");
      const extracted = upload(limit);
      expect(readFileSync(join(extracted, "_3mf/clip/clip.stl")).length).toBe(142);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accounts for actual nested bytes when a child understates its declared size", () => {
    const root = tempRoot();
    const nested = new AdmZip(Buffer.from(encodeAcceptedPlate3mf([
      { token: "clip", objectName: "Clip", xUm: 0, yUm: 0, mesh: triangle },
    ])));
    nested.addFile("padding.bin", randomBytes(128 * 1024));
    const bytes = nested.toBuffer();
    const name = Buffer.from("padding.bin");
    for (let offset = 0; offset + 4 <= bytes.length; offset++) {
      const signature = bytes.readUInt32LE(offset);
      if (signature === 0x02014b50 && bytes.subarray(offset + 46, offset + 46 + name.length).equals(name)) bytes.writeUInt32LE(1, offset + 24);
      if (signature === 0x04034b50 && bytes.subarray(offset + 30, offset + 30 + name.length).equals(name)) bytes.writeUInt32LE(1, offset + 22);
    }
    const zip = new AdmZip();
    zip.addFile("clip.3mf", bytes);
    try {
      const staging = createSourceUploadStaging(root, "default");
      expect(() => writeUploadedZip(stagedFile(zip.toBuffer()), staging, {
        maxUncompressedBytes: bytes.length + 64 * 1024,
      })).toThrow("Archive uncompressed size exceeds limit");
      expect(readdirSync(staging)).toEqual([]);
      const alone = createSourceUploadStaging(root, "default");
      expect(() => writeUploadedZip(stagedFile(zip.toBuffer()), alone, {
        maxUncompressedBytes: bytes.length + 256 * 1024,
      })).toThrow("File is not a valid ZIP archive or is truncated");
      expect(readdirSync(alone)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["zip", "files"])("shares the aggregate entry budget across a %s upload, including empty files and directories", (kind) => {
    const root = tempRoot();
    const nested = new AdmZip(Buffer.from(encodeAcceptedPlate3mf([
      { token: "clip", objectName: "Clip", xUm: 0, yUm: 0, mesh: triangle },
    ])));
    nested.addFile("discarded/", Buffer.alloc(0));
    nested.addFile("discarded/empty.bin", Buffer.alloc(0));
    const bytes = nested.toBuffer();
    const entryLimit = 3 * (nested.getEntries().length + 1);
    const upload = (count: number, maxEntries: number): string => {
      const staging = createSourceUploadStaging(root, "default");
      const files = Array.from({ length: count }, (_, index) => staged(`${index}.3mf`, bytes));
      if (kind === "files") return writeUploadedFiles(files, staging, { maxEntries }).extractDir;
      const zip = new AdmZip();
      for (const file of files) zip.addFile(file.relativePath, bytes);
      return writeUploadedZip(stagedFile(zip.toBuffer()), staging, { maxEntries });
    };
    try {
      expect(() => upload(3, entryLimit - 1)).toThrow(/too many entries/);
      const extracted = upload(3, entryLimit);
      expect(readFileSync(join(extracted, "0.3mf"))).toEqual(bytes);
      expect(readdirSync(join(extracted, "_3mf")).sort()).toEqual(["0", "1", "2"]);
      expect(readFileSync(join(extracted, "_3mf/2/clip.stl")).length).toBe(142);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts outer ZIP directories and empty files toward the nested entry budget", () => {
    const root = tempRoot();
    const model = Buffer.from(encodeAcceptedPlate3mf([
      { token: "clip", objectName: "Clip", xUm: 0, yUm: 0, mesh: triangle },
    ]));
    const zip = new AdmZip();
    zip.addFile("empty/", Buffer.alloc(0));
    zip.addFile("empty/file.bin", Buffer.alloc(0));
    zip.addFile("model.3mf", model);
    try {
      expect(() => writeUploadedZip(stagedFile(zip.toBuffer()), root, {
        maxEntries: new AdmZip(model).getEntries().length + 2,
      })).toThrow(/too many entries/);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["zip", "files"])("shares the nested 3MF validation budget across a %s upload", (kind) => {
    const root = tempRoot();
    const model = encodeAcceptedPlate3mf([{ token: "clip", objectName: "Clip", xUm: 0, yUm: 0, mesh: triangle }]);
    const nested = new AdmZip(Buffer.from(model));
    nested.addFile("padding.bin", Buffer.alloc(4096, 0));
    const bytes = nested.toBuffer();
    const childBytes = nested.getEntries().reduce((total, entry) => total + entry.header.size, 0);
    const limit = childBytes + 1024;
    const zip = new AdmZip();
    zip.addFile("a.3mf", bytes);
    zip.addFile("b.3mf", bytes);
    const staging = createSourceUploadStaging(root, "default");
    try {
      expect(() => kind === "zip"
        ? writeUploadedZip(stagedFile(zip.toBuffer()), staging, { maxUncompressedBytes: limit })
        : writeUploadedFiles([staged("a.3mf", bytes), staged("b.3mf", bytes)], staging, { maxUncompressedBytes: limit })
      ).toThrow("Nested 3MF uncompressed size exceeds limit");
      expect(existsSync(join(staging, "files"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["zip", "files"])("rejects case-equivalent %s targets before either name can replace the other", (kind) => {
    const root = tempRoot();
    const distinct = Buffer.from("distinct part");
    const folded = Buffer.from("folded part");
    try {
      if (kind === "files") {
        const staging = createSourceUploadStaging(root, "default");
        const first = staged("Part.stl", distinct);
        const second = staged("part.stl", folded);
        expect(() => writeUploadedFiles([first, second], staging)).toThrow(/Duplicate uploaded file path: part\.stl/);
        expect(existsSync(join(staging, "files"))).toBe(false);
        expect(readFileSync(second.path)).toEqual(folded);
      } else {
        const zip = new AdmZip();
        zip.addFile("Part.stl", distinct);
        zip.addFile("part.stl", folded);
        const staging = createSourceUploadStaging(root, "default");
        expect(() => writeUploadedZip(stagedFile(zip.toBuffer()), staging)).toThrow(/Archive has duplicate path: part\.stl/);
        expect(existsSync(join(staging, "files"))).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  it("does not charge a rename for bytes already counted in tenant upload staging", async () => {
    const root = tempRoot();
    const staging = createSourceUploadStaging(join(root, "sources"), "tenant-a");
    const path = join(staging, "upload");
    writeFileSync(path, "solid a");
    const result = await runWithTenantDiskQuota({
      dataDir: root, reposDir: join(root, "repos"), tenantId: "tenant-a",
      quotaBytes: 7, sourceIds: () => [],
    }, async () => writeUploadedFiles([{ relativePath: "parts/a.stl", path }], staging));
    expect(result.fileCount).toBe(1);
    expect(readFileSync(join(result.extractDir, "parts/a.stl"), "utf8")).toBe("solid a");
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
    const candidate = createSourceUploadStaging(root, "default");
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
    const candidate = createSourceUploadStaging(root, "default");
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
