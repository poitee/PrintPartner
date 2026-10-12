import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import * as sourceDocs from "../services/source-docs-index.js";
import { SOURCE_PUBLICATION_UNAVAILABLE_DETAIL } from "../services/local-source-revision.js";

vi.mock("../services/source-docs-index.js", { spy: true });

function archive(files: Array<{ path: string; content: Buffer }>) {
  const zip = new AdmZip();
  for (const file of files) zip.addFile(file.path, file.content);
  return zip.toBuffer();
}

function multipart(files: Array<{ path: string; content: Buffer }>, zip = false) {
  const boundary = "gre288-candidate";
  const chunks: Buffer[] = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="relative_paths"\r\n\r\n${JSON.stringify(files.map((file) => file.path))}\r\n`)];
  if (zip) chunks.length = 0;
  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${zip ? "file" : "files"}"; filename="upload"\r\nContent-Type: application/octet-stream\r\n\r\n`), file.content, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(chunks) };
}

describe("Source upload candidate routes", () => {
  let dir: string;
  let ports: ReturnType<typeof createSelfHostPorts>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let id: number;
  let priorPath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pp-upload-candidate-"));
    ports = createSelfHostPorts(dir);
    await ports.db.connect();
    app = await buildApp({ ...loadConfig(), dataDir: dir }, ports);
    const created = await app.inject({ method: "POST", url: "/sources", payload: { name: "Candidate test", source_kind: "local" } });
    id = created.json().id;
    const uploaded = await app.inject({ method: "POST", url: `/sources/${id}/upload-files`, ...multipart([{ path: "keep.stl", content: Buffer.from("previous STL") }]) });
    expect(uploaded.statusCode).toBe(200);
    priorPath = uploaded.json().local_path;
    mkdirSync(join(dir, "sources", String(id), "files"), { recursive: true });
    writeFileSync(join(dir, "sources", String(id), "files", "legacy.stl"), "legacy STL");
    writeFileSync(join(dir, "sources", String(id), "upload.zip"), "legacy ZIP");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(["garbage", "truncated", "nested-3mf", "unsafe-path"])("rejects %s without changing either the active revision or legacy working bytes", async (kind) => {
    const zip = new AdmZip();
    zip.addFile("new.stl", Buffer.from("new STL"));
    if (kind === "nested-3mf") zip.addFile("models/bad.3mf", Buffer.from("not-a-zip"));
    let content = zip.toBuffer();
    if (kind === "garbage") content = Buffer.from("not-a-zip");
    if (kind === "truncated") content = content.subarray(0, content.length - 8);
    const files = kind === "unsafe-path";
    const response = await app.inject({
      method: "POST", url: `/sources/${id}/${files ? "upload-files" : "upload-zip"}`,
      ...multipart([{ path: files ? "../escape.stl" : "upload.zip", content }], !files),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toMatch(files ? /escapes extraction directory/ : /not a valid ZIP/);
    const current = (await app.inject({ method: "GET", url: `/sources/${id}` })).json();
    expect(current.local_path).toBe(priorPath);
    expect(readFileSync(join(priorPath, "keep.stl"), "utf8")).toBe("previous STL");
    expect(readFileSync(join(dir, "sources", String(id), "files", "legacy.stl"), "utf8")).toBe("legacy STL");
    expect(readFileSync(join(dir, "sources", String(id), "upload.zip"), "utf8")).toBe("legacy ZIP");
    expect((await app.inject({ method: "GET", url: `/sources/${id}/import-rules` })).json().rules).toEqual(["keep.stl"]);
    await expect.poll(() => readdirSync(join(dir, "sources"))).toEqual([String(id)]);
  });

  it.each(["files", "zip"] as const)("publishes %s and drops stale docs when indexing fails", async (kind) => {
    const seeded = await app.inject({
      method: "POST",
      url: `/sources/${id}/upload-${kind}`,
      ...multipart(kind === "zip"
        ? [{ path: "upload.zip", content: archive([
          { path: "keep.stl", content: Buffer.from("previous STL") },
          { path: "old/readme.md", content: Buffer.from("old readme\n") },
        ]) }]
        : [
          { path: "keep.stl", content: Buffer.from("previous STL") },
          { path: "old/readme.md", content: Buffer.from("old readme\n") },
        ], kind === "zip"),
    });
    expect(seeded.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/sources/${id}/docs` })).json().docs.map((doc: { path: string }) => doc.path)).toEqual(["old/readme.md"]);
    vi.mocked(sourceDocs.indexSourceDocsFromDisk).mockImplementationOnce(() => { throw new Error("index unavailable"); });
    const response = await app.inject({
      method: "POST",
      url: `/sources/${id}/upload-${kind}`,
      ...multipart(kind === "zip"
        ? [{ path: "upload.zip", content: archive([
          { path: "replacement.stl", content: Buffer.from("replacement STL") },
          { path: "new/readme.md", content: Buffer.from("new readme\n") },
        ]) }]
        : [
          { path: "replacement.stl", content: Buffer.from("replacement STL") },
          { path: "new/readme.md", content: Buffer.from("new readme\n") },
        ], kind === "zip"),
    });
    expect(response.statusCode).toBe(200);
    const active = response.json();
    expect(readFileSync(join(active.local_path, "replacement.stl"), "utf8")).toBe("replacement STL");
    expect(readFileSync(join(active.local_path, "new/readme.md"), "utf8")).toBe("new readme\n");
    expect(readFileSync(join(priorPath, "keep.stl"), "utf8")).toBe("previous STL");
    const listed = await app.inject({ method: "GET", url: `/sources/${id}/docs` });
    expect(listed.json().docs.map((doc: { path: string }) => doc.path)).toEqual(["new/readme.md"]);
    expect((await app.inject({ method: "GET", url: `/sources/${id}/docs/old/readme.md` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/sources/${id}/docs/new/readme.md` })).statusCode).toBe(200);
  });

  it("returns the exact unavailable response for repo-manifest publication before changing the active snapshot", async () => {
    const revisions = join(dir, "repos", String(id), "revisions");
    const beforeDirectories = readdirSync(revisions).sort();
    const unavailable = vi.spyOn(ports.repository, "canPublishSourceRevision").mockReturnValue(false);
    try {
      const response = await app.inject({
        method: "PUT",
        url: `/sources/${id}/repo-manifest`,
        payload: { yaml: "project: blocked\nparts: []\n" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ detail: SOURCE_PUBLICATION_UNAVAILABLE_DETAIL });
      expect(readdirSync(revisions).sort()).toEqual(beforeDirectories);
      expect(readFileSync(join(priorPath, "keep.stl"), "utf8")).toBe("previous STL");
      const current = (await app.inject({ method: "GET", url: `/sources/${id}` })).json();
      expect(current.local_path).toBe(priorPath);
    } finally {
      unavailable.mockRestore();
    }
  });
});
