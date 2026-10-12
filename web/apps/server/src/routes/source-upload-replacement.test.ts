import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import AdmZip from "adm-zip";
import { SourceActivationConflictError } from "../db/repository.js";
import {
  createSourceUploadStaging,
  publishStagedSource,
  stageUploadedFiles,
} from "../services/archive-import.js";
import { makeApp } from "../test/make-app.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  delete process.env.PRINT_PARTNER_DATA_DIR;
});

type Multipart = { payload: Buffer; headers: Record<string, string> };

function multipartZip(buffer: Buffer): Multipart {
  const boundary = "----pp-replacement-boundary";
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="archive.zip"\r\n` +
          `Content-Type: application/zip\r\n\r\n`,
      ),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

function multipartFiles(files: Array<{ name: string; content: Buffer }>): Multipart {
  const boundary = "----pp-replacement-boundary";
  const parts: Buffer[] = [
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="relative_paths"\r\n\r\n` +
        `${JSON.stringify(files.map((file) => file.name))}\r\n`,
    ),
  ];
  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="files"; filename="${file.name}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
      ),
      file.content,
      Buffer.from("\r\n"),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

function zipOf(entries: Record<string, string | Buffer>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
}

function zipSlip(): Buffer {
  const zip = new AdmZip();
  zip.addFile("placeholder-entry", Buffer.from("pwned"));
  zip.getEntries()[0]!.entryName = "../../../evil.txt";
  return zip.toBuffer();
}

function truncatedBeforeCentralDirectory(zip: Buffer): Buffer {
  return zip.subarray(0, zip.readUInt32LE(zip.length - 22 + 16));
}

function tree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else files[relative] = readFileSync(join(dir, entry.name)).toString("base64");
    }
  };
  walk(root, "");
  return files;
}

function text(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([path, content]) => [path, Buffer.from(content, "base64").toString("utf8")]),
  );
}

async function localSource() {
  const dir = mkdtempSync(join(tmpdir(), "pp-upload-replacement-"));
  const { app, ports } = await makeApp(dir);
  cleanups.push(async () => {
    await app.close();
    ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const created = await app.inject({
    method: "POST",
    url: "/sources",
    payload: { name: "Replacement Source", source_kind: "local" },
  });
  expect(created.statusCode).toBe(200);
  const id = (created.json() as { id: number }).id;
  const sourceDir = join(dir, "sources", String(id));
  const upload = (route: "upload-zip" | "upload-files", body: Multipart) =>
    app.inject({ method: "POST", url: `/sources/${id}/${route}`, ...body });
  const state = async () => ({
    source: (await app.inject({ method: "GET", url: `/sources/${id}` })).json(),
    rules: (await app.inject({ method: "GET", url: `/sources/${id}/import-rules` })).json(),
  });
  const stagingLeftovers = () =>
    readdirSync(join(dir, "sources")).filter((name) => name.startsWith("."));
  return { dir, app, ports, id, sourceDir, upload, state, stagingLeftovers };
}

const firstZip = zipOf({ "README.md": "# v1\n", "parts/a.stl": "solid v1\nendsolid v1\n" });

const tooManyStls = zipOf(
  Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`part-${i}.stl`, `solid ${i}\n`])),
);

const failingUploads: Array<[string, "upload-zip" | "upload-files", Multipart, string]> = [
  ["a body that is not a ZIP", "upload-zip", multipartZip(Buffer.from("not a zip archive")), "Upload is not a complete ZIP archive"],
  [
    "a ZIP truncated before its central directory",
    "upload-zip",
    multipartZip(truncatedBeforeCentralDirectory(zipOf({ "parts/b.stl": "solid v2\n" }))),
    "Upload is not a complete ZIP archive",
  ],
  [
    "a ZIP entry that escapes the Source",
    "upload-zip",
    multipartZip(zipSlip()),
    "Archive entry escapes extraction directory: ../../../evil.txt",
  ],
  [
    "a ZIP with a malformed nested 3MF",
    "upload-zip",
    multipartZip(zipOf({ "models/broken.3mf": "not a 3mf package" })),
    "File is not a valid 3MF package: model document is missing",
  ],
  [
    "a ZIP over the published STL limit",
    "upload-zip",
    multipartZip(tooManyStls),
    "Local Source contains 501 STL files, exceeding the limit of 500",
  ],
  [
    "a file path that escapes the Source",
    "upload-files",
    multipartFiles([{ name: "../evil.stl", content: Buffer.from("solid evil\n") }]),
    "File path escapes extraction directory: ../evil.stl",
  ],
  [
    "a malformed 3MF file",
    "upload-files",
    multipartFiles([{ name: "broken.3mf", content: Buffer.from("not a 3mf package") }]),
    "File is not a valid 3MF package: model document is missing",
  ],
];

describe("Source upload replacement", () => {
  it.each(failingUploads)("keeps the previous working files after %s", async (_label, route, body, detail) => {
    const source = await localSource();
    expect((await source.upload("upload-zip", multipartZip(firstZip))).statusCode).toBe(200);
    const before = tree(source.sourceDir);
    expect(text(before)).toEqual({
      "files/README.md": "# v1\n",
      "files/parts/a.stl": "solid v1\nendsolid v1\n",
      "upload.zip": firstZip.toString("utf8"),
    });
    expect(before["upload.zip"]).toBe(firstZip.toString("base64"));
    const stateBefore = await source.state();

    const refused = await source.upload(route, body);

    expect(refused.statusCode).toBe(400);
    expect((refused.json() as { detail: string }).detail).toBe(detail);
    expect(tree(source.sourceDir)).toEqual(before);
    expect(await source.state()).toEqual(stateBefore);
    await vi.waitFor(() => expect(source.stagingLeftovers()).toEqual([]));
    expect(existsSync(join(source.dir, "evil.txt"))).toBe(false);
    expect(existsSync(join(source.dir, "sources", "evil.stl"))).toBe(false);
  });

  it("leaves a new Source without working files or import rules when publication refuses the upload", async () => {
    const source = await localSource();

    const refused = await source.upload("upload-zip", multipartZip(tooManyStls));

    expect(refused.statusCode).toBe(400);
    expect(existsSync(source.sourceDir)).toBe(false);
    expect((await source.state()).rules).toEqual({ rules: [], legacy_import_all: true });
  });

  it("replaces the working files and archive together after publication", async () => {
    const source = await localSource();
    expect((await source.upload("upload-zip", multipartZip(firstZip))).statusCode).toBe(200);
    const secondZip = zipOf({ "parts/b.stl": "solid v2\nendsolid v2\n" });

    const replaced = await source.upload("upload-zip", multipartZip(secondZip));

    expect(replaced.statusCode).toBe(200);
    const body = replaced.json() as { local_path: string; stl_count: number };
    expect(body.stl_count).toBe(1);
    expect(tree(source.sourceDir)).toEqual({
      "files/parts/b.stl": Buffer.from("solid v2\nendsolid v2\n").toString("base64"),
      "upload.zip": secondZip.toString("base64"),
    });
    expect(readFileSync(join(body.local_path, "parts/b.stl"), "utf8")).toBe("solid v2\nendsolid v2\n");
    expect(existsSync(join(body.local_path, "parts/a.stl"))).toBe(false);
    await vi.waitFor(() => expect(source.stagingLeftovers()).toEqual([]));
  });

  it("installs only the winning candidate when two publications race", async () => {
    const source = await localSource();
    expect((await source.upload("upload-zip", multipartZip(firstZip))).statusCode).toBe(200);
    const before = tree(source.sourceDir);
    const repo = source.ports.repository;
    const stagings = [0, 1].map(() => createSourceUploadStaging(source.ports.sourcesDir));
    const candidates = ["solid first\n", "solid second\n"].map((content, n) => {
      writeFileSync(join(stagings[n]!, "0"), content);
      return stageUploadedFiles([{ relativePath: "parts/race.stl", path: join(stagings[n]!, "0") }], stagings[n]!);
    });

    const results = await Promise.allSettled(
      candidates.map((staged) =>
        publishStagedSource({
          repo,
          reposDir: source.ports.reposDir,
          sourcesDir: source.ports.sourcesDir,
          sourceId: source.id,
          staged,
        }),
      ),
    );

    const winner = results.findIndex((result) => result.status === "fulfilled");
    const loser = 1 - winner;
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results[loser] as PromiseRejectedResult).reason).toBeInstanceOf(SourceActivationConflictError);
    const winningContent = winner === 0 ? "solid first\n" : "solid second\n";
    expect(text(tree(join(source.sourceDir, "files")))).toEqual({ "parts/race.stl": winningContent });
    expect(tree(source.sourceDir)["upload.zip"]).toBe(before["upload.zip"]);
    expect(readFileSync(join(repo.getSource(source.id)!.local_path!, "parts/race.stl"), "utf8")).toBe(winningContent);
    expect(existsSync(candidates[loser]!.extractDir)).toBe(true);
    for (const staging of stagings) rmSync(staging, { recursive: true, force: true });
  });

  it("keeps the working files and archive from the same upload under concurrent requests", async () => {
    const source = await localSource();
    const zips = Array.from({ length: 4 }, (_, n) => zipOf({ "parts/part.stl": `solid concurrent-${n}\n` }));

    const responses = await Promise.all(zips.map((zip) => source.upload("upload-zip", multipartZip(zip))));

    const statuses = responses.map((response) => response.statusCode);
    expect(statuses.every((status) => status === 200 || status === 409)).toBe(true);
    expect(statuses).toContain(200);
    for (const response of responses.filter((candidate) => candidate.statusCode === 409)) {
      expect((response.json() as { detail: string }).detail).toBe(
        "Source changed during sync; revision was not activated",
      );
    }
    const working = tree(source.sourceDir);
    const installed = zips.findIndex((zip) => zip.toString("base64") === working["upload.zip"]);
    expect(installed).toBeGreaterThanOrEqual(0);
    expect(text(working)["files/parts/part.stl"]).toBe(`solid concurrent-${installed}\n`);
    expect(Object.keys(working).sort()).toEqual(["files/parts/part.stl", "upload.zip"]);
    const active = (await source.state()).source as { local_path: string };
    expect(readFileSync(join(active.local_path, "parts/part.stl"), "utf8")).toBe(`solid concurrent-${installed}\n`);
    await vi.waitFor(() => expect(source.stagingLeftovers()).toEqual([]));
  });
});
