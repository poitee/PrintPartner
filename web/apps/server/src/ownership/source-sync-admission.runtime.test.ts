import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdmZip from "adm-zip";
import * as assistantTools from "../assistant/tools.js";
import * as localRevision from "../services/local-source-revision.js";
import * as archiveImport from "../services/archive-import.js";
import * as docScan from "../services/source-docs-scan.js";
import * as webhooks from "../services/webhook-store.js";
vi.mock("../services/webhook-store.js", { spy: true });
import { InProcessJobRunner } from "../services/job-runner.js";
import { syncProjectById } from "../routes/sources.js";
import * as sourceRoutes from "../routes/sources.js";
import * as docIndex from "../services/source-docs-index.js";
import * as updates from "../services/source-update-check.js";
vi.mock("../routes/sources.js", { spy: true });
vi.mock("../services/source-docs-index.js", { spy: true });
vi.mock("../services/source-update-check.js", { spy: true });
import * as legacyManifest from "../services/legacy-source-manifest.js";

vi.mock("../services/legacy-source-manifest.js", { spy: true });
vi.mock("../services/source-docs-scan.js", { spy: true });
vi.mock("../services/archive-import.js", { spy: true });
vi.mock("../services/local-source-revision.js", { spy: true });
vi.mock("../assistant/tools.js", { spy: true });
import Database from "better-sqlite3";
import { buildApp, createPorts, startServer } from "../app.js";
import { loadConfig } from "../config.js";
import { installedSourceSyncWatchers } from "../services/source-watcher.js";
import {
  SOURCE_SYNC_OPERATION,
  SOURCE_SYNC_PARTICIPANTS,
  admitSourceSyncManifest,
  beginSourceSyncAdmission,
  defaultSourceSyncManifestPath,
  packagedSourceSyncManifestPath,
  parseSourceSyncAdmissionReceipt,
  OwnershipAdmissionError,
  sourceSyncAdmissionReceiptPath,
  requireSourceSyncParticipant,
  type SourceSyncAdmissionReceipt,
} from "./source-sync-admission.js";

const sourceDir = dirname(fileURLToPath(import.meta.url));

const packagedManifest = join(sourceDir, "../data/source-sync-ownership.json");

type AppHandle = {
  app: Awaited<ReturnType<typeof buildApp>>;
  ports: ReturnType<typeof createPorts>;
  dataDir: string;
};

const openApps: AppHandle[] = [];
const scratchDirs: string[] = [];
const previousEnv = {
  dataDir: process.env.PRINT_PARTNER_DATA_DIR,
  apiKey: process.env.PRINT_PARTNER_API_KEY,
  host: process.env.HOST,
  deploy: process.env.DEPLOY_MODE,
  manifest: process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST,
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of openApps.splice(0)) {
    await handle.app.close();
    await handle.ports.db.close();
  }
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  restoreEnv("PRINT_PARTNER_DATA_DIR", previousEnv.dataDir);
  restoreEnv("PRINT_PARTNER_API_KEY", previousEnv.apiKey);
  restoreEnv("HOST", previousEnv.host);
  restoreEnv("DEPLOY_MODE", previousEnv.deploy);
  restoreEnv("PP_SOURCE_SYNC_OWNERSHIP_MANIFEST", previousEnv.manifest);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function scratch(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `print-partner-source-sync-${name}-`));
  scratchDirs.push(dir);
  return dir;
}

function writeManifest(
  dir: string,
  name: string,
  mutate?: (manifest: Record<string, unknown>) => void,
): string {
  const manifest = JSON.parse(readFileSync(packagedManifest, "utf8")) as Record<string, unknown>;
  mutate?.(manifest);
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

function installManifest(path: string, dataDir: string): void {
  process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST = path;
  process.env.PRINT_PARTNER_DATA_DIR = dataDir;
  process.env.PRINT_PARTNER_API_KEY = "test-mcp-key";
  process.env.HOST = "127.0.0.1";
  process.env.DEPLOY_MODE = "self-host";
}

async function boot(dataDir: string): Promise<AppHandle> {
  const ports = createPorts(loadConfig());
  await ports.db.connect();
  const app = await buildApp(loadConfig(), ports);
  const handle = { app, ports, dataDir };
  openApps.push(handle);
  return handle;
}

function minimalPdf(text: string): string {
  const stream = `BT\n/F1 12 Tf\n72 72 Td\n(${text}) Tj\nET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(body.length);
    body += object;
  }
  const xrefOffset = body.length;
  body += "xref\n0 6\n0000000000 65535 f \n";
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return body;
}

function fingerprint(dir: string): string {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`unexpected symlink ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  if (existsSync(dir)) visit(dir);
  files.sort();
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(relative(dir, path).split(sep).join("/"));
    hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

async function waitJob(app: AppHandle["app"], jobId: string): Promise<{ status?: string; error?: string; result?: { synced?: number } }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/jobs/${jobId}` });
    const job = response.json() as { status?: string; error?: string; result?: { synced?: number } };
    if (job.status === "done" || job.status === "error" || job.status === "cancelled") return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job ${jobId} did not finish`);
}

function jsonObjects(body: string): unknown[] {
  const values: unknown[] = [];
  const whole = body.trim();
  if (whole.startsWith("{") || whole.startsWith("[")) {
    try {
      values.push(JSON.parse(whole));
    } catch {
      // Streamed frames are parsed line by line below.
    }
  }
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
    if (!payload.startsWith("{")) continue;
    try {
      values.push(JSON.parse(payload));
    } catch {
      // Non-JSON stream frames are ignored.
    }
  }
  return values;
}

function toolText(body: string): string {
  for (const value of jsonObjects(body)) {
    if (!value || typeof value !== "object" || !("result" in value)) continue;
    const result = (value as { result?: unknown }).result;
    if (!result || typeof result !== "object" || !("content" in result)) continue;
    const content = (result as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const entry of content) {
      if (entry && typeof entry === "object" && "text" in entry && typeof entry.text === "string") {
        return entry.text;
      }
    }
  }
  return body;
}

async function localAdmissionFixture(name: string) {
  const dir = scratch(name);
  const manifest = writeManifest(dir, "admitted.json");
  installManifest(manifest, dir);
  const started = await boot(dir);
  const repo = started.ports.repository;
  const reposDir = started.ports.reposDir;
  if (!repo || !reposDir) throw new Error("Expected self-host Source repository");
  const source = repo.createSource({ name, source_kind: "local" });
  const workspace = join(reposDir, String(source.id));
  mkdirSync(workspace, { recursive: true });
  return { dir, manifest, original: readFileSync(manifest, "utf8"), started, repo, source, workspace };
}

function linkedProfileProbe(f: Awaited<ReturnType<typeof localAdmissionFixture>>) {
  const profile = f.repo.createProfile("Linked imported rules", f.source.id);
  const probe = new Database(join(f.dir, "print-partner.db"));
  probe.prepare("UPDATE build_profiles SET config_modified_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", profile.id);
  probe.close();
  return { id: profile.id, modifiedAt: () => {
    const read = new Database(join(f.dir, "print-partner.db"), { readonly: true });
    try {
      const value = read.prepare("SELECT config_modified_at FROM build_profiles WHERE id = ?").pluck().get(profile.id);
      if (typeof value !== "string") throw new Error("Expected profile configuration timestamp");
      return value;
    } finally { read.close(); }
  } };
}

function multipartUpload(kind: "zip" | "files") {
  const boundary = "pp-admission-upload";
  const field = kind === "zip" ? "file" : "files";
  let bytes: Buffer = Buffer.from("solid cube\nendsolid cube\n");
  if (kind === "zip") {
    const archive = new AdmZip();
    archive.addFile("cube.stl", bytes);
    bytes = archive.toBuffer();
  }
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, authorization: "Bearer test-mcp-key" },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="cube.${kind === "zip" ? "zip" : "stl"}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

describe("Source Sync Fastify admission", () => {
  it.each([
    ["", "missing"], ["/api/v1", "missing"],
    ["", "malformed"], ["/api/v1", "malformed"],
    ["", "replaced"], ["/api/v1", "replaced"],
  ])("returns 503 for %s source creation when ownership is %s", async (prefix, kind) => {
    const f = await localAdmissionFixture("outage-status");
    const before = f.repo.listSources();
    if (kind === "missing") rmSync(f.manifest);
    else writeFileSync(f.manifest, kind === "malformed" ? "null" : `${f.original}\n`);
    const rejected = await f.started.app.inject({
      method: "POST", url: `${prefix}/sources`, headers: { authorization: "Bearer test-mcp-key" },
      payload: { name: "Unavailable", source_kind: "local" },
    });
    expect(rejected.statusCode, rejected.body).toBe(503);
    expect(f.repo.listSources()).toEqual(before);
    writeFileSync(f.manifest, f.original);
    const invalid = await f.started.app.inject({
      method: "POST", url: `${prefix}/sources`, headers: { authorization: "Bearer test-mcp-key" },
      payload: { name: "", source_kind: "local" },
    });
    expect(invalid.statusCode, invalid.body).toBe(400);
    expect(f.repo.listSources()).toEqual(before);
  });

  it.each([
    ["", "zip"], ["/api/v1", "zip"], ["", "files"], ["/api/v1", "files"],
    ["assistant", "files"], ["assistant", "zip"],
  ] as const)("preserves the previous uploaded tree when %s %s publication loses admission", async (prefix, kind) => {
    const f = await localAdmissionFixture("preserve-upload-tree");
    const sourcesDir = join(f.dir, "sources");
    const legacyTree = join(sourcesDir, String(f.source.id), "files");
    mkdirSync(legacyTree, { recursive: true });
    writeFileSync(join(legacyTree, "previous.stl"), "solid previous\nendsolid previous\n");
    writeFileSync(join(legacyTree, "notes.md"), "Original uploaded documentation");
    f.repo.updateSource(f.source.id, { local_path: legacyTree });
    const before = f.repo.getProjectRow(f.source.id);
    const treeBefore = fingerprint(sourcesDir);
    const actual = await vi.importActual<typeof localRevision>("../services/local-source-revision.js");
    vi.spyOn(localRevision, "publishLocalSourceWorkingTree").mockImplementationOnce(async (input) => {
      const publication = actual.publishLocalSourceWorkingTree(input);
      await Promise.resolve();
      writeFileSync(f.manifest, `${f.original}\n`);
      return publication;
    });
    let response;
    if (prefix === "assistant") {
      const params = kind === "files"
        ? { source_id: f.source.id, files: [{ path: "cube.stl", content_base64: Buffer.from("solid cube\nendsolid cube\n").toString("base64") }] }
        : (() => { const archive = new AdmZip(); archive.addFile("cube.stl", Buffer.from("solid cube\nendsolid cube\n")); return { source_id: f.source.id, archive_base64: archive.toBuffer().toString("base64") }; })();
      response = await f.started.app.inject({ method: "POST", url: "/assistant/actions/apply", payload: { action: {
        id: "import", type: "propose_import_source_files", plan_id: 0, label: "Import", summary: "Import", params,
      } } });
    } else {
      response = await f.started.app.inject({ method: "POST", url: `${prefix}/sources/${f.source.id}/upload-${kind}`, ...multipartUpload(kind) });
    }
    expect(response.statusCode, response.body).toBe(503);
    expect(f.repo.getProjectRow(f.source.id)).toEqual(before);
    expect(f.repo.listSourceRevisions(f.source.id)).toEqual([]);
    await vi.waitFor(() => expect(readdirSync(sourcesDir)).toEqual([String(f.source.id)]));
    expect(fingerprint(sourcesDir)).toBe(treeBefore);
    expect(readFileSync(join(legacyTree, "previous.stl"), "utf8")).toBe("solid previous\nendsolid previous\n");
  });

  it.each([["", "zip"], ["/api/v1", "zip"], ["", "files"], ["/api/v1", "files"]] as const)(
    "returns 503 when admission changes during %s upload-%s streaming", async (prefix, kind) => {
      const f = await localAdmissionFixture("stream-outage-status");
      const before = f.repo.getProjectRow(f.source.id);
      const actual = await vi.importActual<typeof archiveImport>("../services/archive-import.js");
      vi.spyOn(archiveImport, "streamSourceUpload").mockImplementationOnce(async (...args) => {
        const bytes = await actual.streamSourceUpload(...args);
        writeFileSync(f.manifest, `${f.original}\n`);
        return bytes;
      });
      const rejected = await f.started.app.inject({
        method: "POST", url: `${prefix}/sources/${f.source.id}/upload-${kind}`, ...multipartUpload(kind),
      });
      expect(rejected.statusCode, rejected.body).toBe(503);
      expect(rejected.body).toMatch(/runtime manifest does not match/);
      expect(f.repo.getProjectRow(f.source.id)).toEqual(before);
      expect(f.repo.listSourceRevisions(f.source.id)).toEqual([]);
      expect(readdirSync(f.workspace)).toEqual([]);
    },
  );

  it.each([["", "zip"], ["/api/v1", "zip"], ["", "files"], ["/api/v1", "files"]] as const)(
    "admits %s local upload-%s and refuses publication after manifest replacement", async (prefix, kind) => {
      const f = await localAdmissionFixture("upload-admission");
      const profile = linkedProfileProbe(f);
      const url = `${prefix}/sources/${f.source.id}/upload-${kind}`;
      const before = f.repo.getProjectRow(f.source.id);
      writeFileSync(f.manifest, `${f.original}\n`);
      const refused = await f.started.app.inject({ method: "POST", url, ...multipartUpload(kind) });
      expect(refused.statusCode).toBe(503);
      expect(refused.body).toMatch(/runtime manifest does not match/);
      expect(f.repo.getProjectRow(f.source.id)).toEqual(before);
      expect(f.repo.listSourceRevisions(f.source.id)).toEqual([]);
      expect(readdirSync(f.workspace)).toEqual([]);
      writeFileSync(f.manifest, f.original);
      const admitted = await f.started.app.inject({ method: "POST", url, ...multipartUpload(kind) });
      expect(admitted.statusCode, admitted.body).toBe(200);
      expect(f.repo.listSourceRevisions(f.source.id)).toHaveLength(1);
      expect(profile.modifiedAt()).not.toBe("2000-01-01T00:00:00.000Z");
      expect(f.repo.getSource(f.source.id)?.current_source_revision_id).toEqual(expect.any(Number));
    },
  );

  it("admits assistant file import and rejects it after manifest replacement", async () => {
    const f = await localAdmissionFixture("assistant-import-admission");
    const profile = linkedProfileProbe(f);
    const action = {
      id: "local-import", type: "propose_import_source_files", plan_id: 0, label: "Import", summary: "Import local files",
      params: { source_id: f.source.id, files: [{ path: "cube.stl", content_base64: Buffer.from("solid cube\nendsolid cube\n").toString("base64") }] },
    };
    writeFileSync(f.manifest, `${f.original}\n`);
    const refused = await f.started.app.inject({ method: "POST", url: "/assistant/actions/apply", payload: { action } });
    expect(refused.statusCode, refused.body).toBe(503);
    expect(refused.body).toMatch(/runtime manifest does not match/);
    expect(f.repo.listSourceRevisions(f.source.id)).toEqual([]);
    expect(readdirSync(f.workspace)).toEqual([]);
    writeFileSync(f.manifest, f.original);
    const admitted = await f.started.app.inject({ method: "POST", url: "/assistant/actions/apply", payload: { action } });
    expect(admitted.statusCode, admitted.body).toBe(200);
    expect(admitted.json()).toMatchObject({ ok: true });
    expect(f.repo.listSourceRevisions(f.source.id)).toHaveLength(1);
    expect(profile.modifiedAt()).not.toBe("2000-01-01T00:00:00.000Z");
  });

  it.each(["", "/api/v1"])("preserves 503 after %s assistant start_sync passes the route guard", async (prefix) => {
    const f = await localAdmissionFixture("assistant-sync-outage");
    const actual = await vi.importActual<typeof assistantTools>("../assistant/tools.js");
    vi.spyOn(assistantTools, "applyAssistantAction").mockImplementationOnce(async (...args) => {
      await Promise.resolve();
      writeFileSync(f.manifest, `${f.original}\n`);
      return actual.applyAssistantAction(...args);
    });
    const response = await f.started.app.inject({
      method: "POST", url: `${prefix}/assistant/actions/apply`, headers: { authorization: "Bearer test-mcp-key" },
      payload: { action: { id: "sync", type: "start_sync", plan_id: 0, label: "Sync", summary: "Sync", params: { project_ids: [f.source.id] } } },
    });
    expect(response.statusCode, response.body).toBe(503);
    expect(response.body).toMatch(/runtime manifest does not match/);
    const jobs = f.started.ports.jobs;
    if (!(jobs instanceof InProcessJobRunner)) throw new Error("Expected local runner");
    expect(jobs.listJobs({}, "default")).toEqual([]);
  });

  it("rejects missing or conflicting profile-table claims before admission", () => {
    const ids = SOURCE_SYNC_PARTICIPANTS.filter((id) => id.endsWith("/upload-zip") || id.endsWith("/upload-files") || id === "assistant.propose_import_source_files");
    expect(ids).toHaveLength(5);
    for (const [index, id] of ids.entries()) {
      const dir = scratch(`profile-claim-${index}`);
      const dataDir = join(dir, "data");
      const manifest = writeManifest(dir, "missing.json", (value) => {
        const participants = value.participants as Array<{ id: string; resources: string[] }>;
        const participant = participants.find((item) => item.id === id);
        if (!participant) throw new Error("Missing import participant");
        participant.resources = participant.resources.filter((resource) => resource !== "table:build_profiles");
      });
      installManifest(manifest, dataDir);
      expect(() => beginSourceSyncAdmission(dataDir)).toThrow(/resource set mismatch/);
      expect(existsSync(dataDir)).toBe(false);
    }
    const dir = scratch("conflicting-profile-claim");
    const dataDir = join(dir, "data");
    const manifest = writeManifest(dir, "conflict.json", (value) => {
      const participants = value.participants as unknown[];
      participants.push({ id: "job.other-profile-owner", kind: "job", owner: "rust", resources: ["table:build_profiles"] });
    });
    installManifest(manifest, dataDir);
    expect(() => beginSourceSyncAdmission(dataDir)).toThrow(/conflicting resource authority for table:build_profiles/);
    expect(existsSync(dataDir)).toBe(false);
  });

  it.each([
    ["", "missing"], ["/api/v1", "missing"], ["", "malformed"], ["/api/v1", "malformed"],
    ["", "replaced"], ["/api/v1", "replaced"], ["", "during-publication"], ["/api/v1", "during-publication"],
  ])("preserves 503 for %s assistant import when admission changes %s", async (prefix, phase) => {
    const f = await localAdmissionFixture("assistant-outage");
    const before = f.repo.getProjectRow(f.source.id);
    if (phase === "missing") rmSync(f.manifest);
    else if (phase !== "during-publication") writeFileSync(f.manifest, phase === "malformed" ? "null" : `${f.original}\n`);
    else {
      const actual = await vi.importActual<typeof localRevision>("../services/local-source-revision.js");
      vi.spyOn(localRevision, "publishLocalSourceWorkingTree").mockImplementationOnce(async (input) => {
        await Promise.resolve();
        writeFileSync(f.manifest, `${f.original}\n`);
        return actual.publishLocalSourceWorkingTree(input);
      });
    }
    const response = await f.started.app.inject({
      method: "POST", url: `${prefix}/assistant/actions/apply`, headers: { authorization: "Bearer test-mcp-key" },
      payload: { action: { id: "import", type: "propose_import_source_files", plan_id: 0, label: "Import", summary: "Import", params: {
        source_id: f.source.id, files: [{ path: "cube.stl", content_base64: Buffer.from("solid cube\nendsolid cube\n").toString("base64") }],
      } } },
    });
    expect(response.statusCode, response.body).toBe(503);
    expect(response.body).toMatch(/ownership manifest|runtime manifest does not match/);
    expect(f.repo.getProjectRow(f.source.id)).toEqual(before);
    expect(f.repo.listSourceRevisions(f.source.id)).toEqual([]);
    expect(readdirSync(f.workspace)).toEqual([]);
  });

  it.each(["sync", "import-scan", "extract-source-docs", "check-source-updates"] as const)(
    "refuses successful %s job webhooks when admission changes after the worker finishes", async (kind) => {
      const f = await localAdmissionFixture(`finished-${kind}`);
      writeFileSync(join(f.workspace, "README.md"), "# Completed source\n");
      const dispatch = vi.spyOn(webhooks, "dispatchWebhooks").mockResolvedValue(undefined);
      if (kind === "sync" || kind === "import-scan") {
        const actual = await vi.importActual<typeof sourceRoutes>("../routes/sources.js");
        vi.spyOn(sourceRoutes, "syncProjectById").mockImplementationOnce(async (...args) => {
          const result = await actual.syncProjectById(...args);
          writeFileSync(f.manifest, `${f.original}\n`);
          return result;
        });
      } else if (kind === "extract-source-docs") {
        const actual = await vi.importActual<typeof docIndex>("../services/source-docs-index.js");
        vi.spyOn(docIndex, "extractPendingPdfsForSource").mockImplementationOnce(async (...args) => {
          const result = await actual.extractPendingPdfsForSource(...args);
          writeFileSync(f.manifest, `${f.original}\n`);
          return result;
        });
      } else {
        const actual = await vi.importActual<typeof updates>("../services/source-update-check.js");
        vi.spyOn(updates, "checkAllSourceUpdates").mockImplementationOnce(async (...args) => {
          const result = await actual.checkAllSourceUpdates(...args);
          writeFileSync(f.manifest, `${f.original}\n`);
          return result;
        });
      }
      const jobId = await f.started.ports.jobs.start(kind, { project_id: f.source.id, project_ids: [f.source.id] });
      const result = await waitJob(f.started.app, jobId);
      expect(result).toMatchObject({ status: "error", error: expect.stringMatching(/runtime manifest does not match/) });
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("refuses job webhooks when a terminal listener revokes admission", async () => {
    const f = await localAdmissionFixture("listener-revocation");
    const dispatch = vi.spyOn(webhooks, "dispatchWebhooks").mockResolvedValue(undefined);
    const runner = f.started.ports.jobs;
    if (!(runner instanceof InProcessJobRunner)) throw new Error("Expected in-process jobs");
    const jobId = await runner.start("sync", { project_ids: [f.source.id] });
    const unsubscribe = runner.subscribe(jobId, "default", (event) => {
      if (event.status === "done") writeFileSync(f.manifest, `${f.original}\n`);
    });
    const result = await waitJob(f.started.app, jobId);
    unsubscribe?.();
    expect(result.status).toBe("done");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses ordinary job error webhooks after the worker loses admission", async () => {
    const f = await localAdmissionFixture("ordinary-error-revocation");
    f.repo.updateSource(f.source.id, { source_kind: "github", url: "invalid" });
    const dispatch = vi.spyOn(webhooks, "dispatchWebhooks").mockResolvedValue(undefined);
    const actual = await vi.importActual<typeof sourceRoutes>("../routes/sources.js");
    vi.spyOn(sourceRoutes, "syncProjectById").mockImplementationOnce(async (...args) => {
      try {
        return await actual.syncProjectById(...args);
      } finally {
        writeFileSync(f.manifest, `${f.original}\n`);
      }
    });
    const jobId = await f.started.ports.jobs.start("sync", { project_ids: [f.source.id] });
    const result = await waitJob(f.started.app, jobId);
    expect(result).toMatchObject({ status: "error", error: expect.any(String) });
    expect(result.error).not.toMatch(/runtime manifest does not match/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([false, true])("marks the job error when the final sync loses admission (earlierSuccess=%s)", async (earlierSuccess) => {
    const f = await localAdmissionFixture("final-sync-outage");
    writeFileSync(join(f.workspace, "README.md"), "# Final document\n");
    const ids: number[] = [];
    if (earlierSuccess) {
      const previous = f.repo.createSource({ name: "Earlier source", source_kind: "local" });
      mkdirSync(join(f.repo.reposDir, String(previous.id)), { recursive: true });
      ids.push(previous.id);
    }
    ids.push(f.source.id);
    const before = f.repo.getProjectRow(f.source.id);
    const actual = await vi.importActual<typeof docScan>("../services/source-docs-scan.js");
    vi.spyOn(docScan, "walkSourceDocs").mockImplementation((path) => {
      const docs = actual.walkSourceDocs(path);
      if (path === f.workspace) writeFileSync(f.manifest, `${f.original}\n`);
      return docs;
    });
    const dispatch = vi.spyOn(webhooks, "dispatchWebhooks").mockResolvedValue(undefined);
    const jobId = await f.started.ports.jobs.start("sync", { project_ids: ids });
    const listener = vi.fn();
    const runner = f.started.ports.jobs;
    if (!(runner instanceof InProcessJobRunner)) throw new Error("Expected in-process jobs");
    const unsubscribe = runner.subscribe(jobId, "default", listener);
    const result = await waitJob(f.started.app, jobId);
    expect(result).toMatchObject({ status: "error", error: expect.stringMatching(/runtime manifest does not match/) });
    expect(dispatch).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: "error", error: result.error }));
    unsubscribe?.();
    expect(f.repo.getProjectRow(f.source.id)).toEqual(before);
    expect(f.repo.listSourceDocs(f.source.id)).toEqual([]);
    if (earlierSuccess) expect(f.repo.getSource(ids[0])?.last_synced_at).toBeTruthy();
  });

  it.each(["", "/api/v1"])("guards %s document and cover cache writes while serving admitted cached reads", async (prefix) => {
    const f = await localAdmissionFixture("read-cache-admission");
    writeFileSync(join(f.workspace, "README.md"), "# Owned documentation\n");
    writeFileSync(join(f.workspace, "manual.pdf"), minimalPdf("Owned manual"), "binary");
    writeFileSync(join(f.workspace, "cover.png"), "owned cover bytes");
    const docsBefore = f.repo.listSourceDocs(f.source.id);
    const sourceTree = fingerprint(f.workspace);
    const coverDir = join(f.dir, "covers");
    const coversBefore = fingerprint(coverDir);
    const base = `${prefix}/sources/${f.source.id}`;
    const headers = { authorization: "Bearer test-mcp-key" };
    writeFileSync(f.manifest, `${f.original}\n`);
    for (const suffix of ["docs", "docs/manual.pdf", "cover"]) {
      const refused = await f.started.app.inject({ method: "GET", url: `${base}/${suffix}`, headers });
      expect(refused.statusCode, refused.body).toBe(503);
      expect(refused.body).toMatch(/runtime manifest does not match/);
    }
    expect(f.repo.listSourceDocs(f.source.id)).toEqual(docsBefore);
    expect(fingerprint(f.workspace)).toBe(sourceTree);
    expect(fingerprint(coverDir)).toBe(coversBefore);
    writeFileSync(f.manifest, f.original);
    for (const suffix of ["docs", "docs/manual.pdf", "cover"]) {
      const admitted = await f.started.app.inject({ method: "GET", url: `${base}/${suffix}`, headers });
      expect(admitted.statusCode, admitted.body).toBe(200);
    }
    expect(f.repo.listSourceDocs(f.source.id).find((doc) => doc.path === "manual.pdf")?.extract_status).toBe("ready");
    const docRows = f.repo.listSourceDocs(f.source.id);
    const cachedTree = fingerprint(f.workspace);
    const cachedCovers = fingerprint(coverDir);
    writeFileSync(f.manifest, `${f.original}\n`);
    for (const suffix of ["docs", "docs/manual.pdf", "cover"]) {
      const cached = await f.started.app.inject({ method: "GET", url: `${base}/${suffix}`, headers });
      expect(cached.statusCode, cached.body).toBe(200);
    }
    expect(f.repo.listSourceDocs(f.source.id)).toEqual(docRows);
    expect(fingerprint(f.workspace)).toBe(cachedTree);
    expect(fingerprint(coverDir)).toBe(cachedCovers);
  });

  it("rechecks local import admission after document discovery before replacing the index", async () => {
    const f = await localAdmissionFixture("index-recheck");
    writeFileSync(join(f.workspace, "README.md"), "# New indexed document\n");
    const before = f.repo.getProjectRow(f.source.id);
    const actual = await vi.importActual<typeof docScan>("../services/source-docs-scan.js");
    vi.spyOn(docScan, "walkSourceDocs").mockImplementationOnce((path) => {
      const docs = actual.walkSourceDocs(path);
      writeFileSync(f.manifest, `${f.original}\n`);
      return docs;
    });
    await expect(syncProjectById(f.repo, f.repo.reposDir, f.source.id, join(f.dir, "covers"), {
      beforePublish: () => requireSourceSyncParticipant("job.import-scan"),
    })).rejects.toThrow(/runtime manifest does not match/);
    expect(f.repo.listSourceDocs(f.source.id)).toEqual([]);
    expect(f.repo.getProjectRow(f.source.id)).toEqual(before);
  });

  it.each(["", "/api/v1"])("removes %s new Git source when enqueue admission fails", async (prefix) => {
    const f = await localAdmissionFixture("enqueue-compensation");
    f.repo.deleteSource(f.source.id);
    const jobs = f.started.ports.jobs;
    if (!(jobs instanceof InProcessJobRunner)) throw new Error("Expected local job runner");
    const start = jobs.start.bind(jobs);
    for (let attempt = 0; attempt < 2; attempt++) {
      writeFileSync(f.manifest, f.original);
      vi.spyOn(jobs, "start").mockImplementationOnce(async (...args) => {
        writeFileSync(f.manifest, `${f.original}\n`);
        return start(...args);
      });
      const rejected = await f.started.app.inject({
        method: "POST", url: `${prefix}/sources`, headers: { authorization: "Bearer test-mcp-key" },
        payload: { name: "Compensated source", source_kind: "github", url: "https://github.com/example/fixture" },
      });
      expect(rejected.statusCode, rejected.body).toBe(503);
      expect(rejected.body).toMatch(/runtime manifest does not match/);
      expect(f.repo.listSources()).toEqual([]);
      expect(jobs.listJobs({}, "default")).toEqual([]);
    }
  });

  it.each(["dangling-symlink", "valid-symlink", "directory", "fifo"])(
    "rejects a non-regular startup receipt (%s) without replacing it",
    async (kind) => {
      const dir = scratch(`non-regular-${kind}`);
      const manifest = writeManifest(dir, "admitted.json");
      const dataDir = join(dir, "data");
      mkdirSync(dataDir);
      installManifest(manifest, dataDir);
      const targetDir = join(dir, "outside");
      const valid = beginSourceSyncAdmission(targetDir);
      const target = sourceSyncAdmissionReceiptPath(targetDir);
      const targetBytes = readFileSync(target);
      const receiptPath = sourceSyncAdmissionReceiptPath(dataDir);
      if (kind === "dangling-symlink") symlinkSync(join(dir, "missing"), receiptPath);
      else if (kind === "valid-symlink") symlinkSync(target, receiptPath);
      else if (kind === "directory") mkdirSync(receiptPath);
      else expect(spawnSync("mkfifo", [receiptPath]).status).toBe(0);
      const entry = lstatSync(receiptPath);
      const watchers = installedSourceSyncWatchers();
      await expect(startServer(loadConfig())).rejects.toThrow(/admission receipt is not a regular file/);
      expect(lstatSync(receiptPath).ino).toBe(entry.ino);
      expect(lstatSync(receiptPath).mode).toBe(entry.mode);
      expect(readdirSync(dataDir)).toEqual(["source-sync-admission.json"]);
      expect(readFileSync(target)).toEqual(targetBytes);
      expect(JSON.parse(targetBytes.toString())).toEqual(valid);
      expect(installedSourceSyncWatchers()).toBe(watchers);
    },
  );

  it.each(["", "/api/v1"])("guards repo-manifest publication and archival through %s", async (prefix) => {
    const dir = scratch("repo-manifest");
    const manifest = writeManifest(dir, "admitted.json");
    installManifest(manifest, dir);
    const started = await boot(dir);
    const repo = started.ports.repository;
    const reposDir = started.ports.reposDir;
    if (!repo || !reposDir) throw new Error("Expected self-host Source repository");
    const source = repo.createSource({ name: "Editable", source_kind: "local" });
    const workspace = join(reposDir, String(source.id));
    mkdirSync(workspace, { recursive: true });
    const legacyPath = join(workspace, "print-partner.manifest.yaml");
    writeFileSync(legacyPath, "project: legacy\n");
    writeFileSync(join(workspace, "cube.stl"), "solid cube\nendsolid cube\n");
    const url = `${prefix}/sources/${source.id}/repo-manifest`;
    const headers = { authorization: "Bearer test-mcp-key" };
    const original = readFileSync(manifest, "utf8");
    writeFileSync(manifest, `${original}\n`);
    const before = fingerprint(workspace);
    const rowBefore = repo.getProjectRow(source.id);
    const revisionsBefore = repo.listSourceRevisions(source.id);
    const refused = await started.app.inject({ method: "PUT", url, headers, payload: { yaml: "project: denied\n" } });
    expect(refused.statusCode, refused.body).toBe(503);
    expect(refused.body).toMatch(/runtime manifest does not match/);
    expect(fingerprint(workspace)).toBe(before);
    expect(repo.getProjectRow(source.id)).toEqual(rowBefore);
    expect(repo.listSourceRevisions(source.id)).toEqual(revisionsBefore);
    writeFileSync(manifest, original);
    const admitted = await started.app.inject({ method: "PUT", url, headers, payload: { yaml: "project: admitted\n" } });
    expect(admitted.statusCode, admitted.body).toBe(200);
    expect(admitted.json()).toMatchObject({ saved: true });
    expect(repo.getSource(source.id)?.current_source_revision_id).toEqual(expect.any(Number));
    expect(existsSync(legacyPath)).toBe(false);
    const read = await started.app.inject({ method: "GET", url, headers });
    expect(read.json()).toMatchObject({ yaml: "project: admitted\n" });
    const archived = readdirSync(workspace).filter((name) => name.startsWith("print-partner.manifest.yaml.migrated-"));
    expect(archived).toHaveLength(1);
    expect(readFileSync(join(workspace, archived[0], "print-partner.manifest.yaml.migrated"), "utf8")).toBe("project: legacy\n");
  });

  it.each([
    ["", "publication"], ["/api/v1", "publication"],
    ["", "archival"], ["/api/v1", "archival"],
  ])("rechecks %s repo-manifest admission before %s", async (prefix, phase) => {
    const dir = scratch(`repo-manifest-${phase}`);
    const manifest = writeManifest(dir, "admitted.json");
    installManifest(manifest, dir);
    const started = await boot(dir);
    const repo = started.ports.repository;
    const reposDir = started.ports.reposDir;
    if (!repo || !reposDir) throw new Error("Expected self-host Source repository");
    const source = repo.createSource({ name: "Editable", source_kind: "local" });
    const workspace = join(reposDir, String(source.id));
    mkdirSync(workspace, { recursive: true });
    const legacyPath = join(workspace, "print-partner.manifest.yaml");
    writeFileSync(legacyPath, "project: legacy\n");
    writeFileSync(join(workspace, "cube.stl"), "solid cube\nendsolid cube\n");
    const original = readFileSync(manifest, "utf8");
    const rowBefore = repo.getProjectRow(source.id);
    const revisionsBefore = repo.listSourceRevisions(source.id);
    const treeBefore = fingerprint(workspace);
    const actualLegacy = await vi.importActual<typeof legacyManifest>("../services/legacy-source-manifest.js");
    if (phase === "publication") {
      const inspect = actualLegacy.inspectLegacySourceManifest;
      vi.spyOn(legacyManifest, "inspectLegacySourceManifest").mockImplementationOnce(async (input) => {
        const observed = await inspect(input);
        writeFileSync(manifest, `${original}\n`);
        return observed;
      });
    } else {
      const archive = actualLegacy.archiveLegacySourceManifest;
      vi.spyOn(legacyManifest, "archiveLegacySourceManifest").mockImplementationOnce(async (...args) => {
        writeFileSync(manifest, `${original}\n`);
        return archive(...args);
      });
    }
    const refused = await started.app.inject({
      method: "PUT", url: `${prefix}/sources/${source.id}/repo-manifest`,
      headers: { authorization: "Bearer test-mcp-key" }, payload: { yaml: "project: edited\n" },
    });
    expect(refused.statusCode, refused.body).toBe(503);
    expect(refused.body).toMatch(/runtime manifest does not match/);
    expect(readFileSync(legacyPath, "utf8")).toBe("project: legacy\n");
    expect(readdirSync(workspace).filter((name) => name.includes(".migrated-"))).toEqual([]);
    if (phase === "publication") {
      expect(repo.getProjectRow(source.id)).toEqual(rowBefore);
      expect(repo.listSourceRevisions(source.id)).toEqual(revisionsBefore);
      expect(fingerprint(workspace)).toBe(treeBefore);
    } else {
      expect(repo.getSource(source.id)?.current_source_revision_id).toEqual(expect.any(Number));
    }
  });

  it("rejects dropped resource claims for every participant before receipt creation", () => {
    for (const [index, id] of SOURCE_SYNC_PARTICIPANTS.entries()) {
      const dir = scratch(`wrong-resource-${index}`);
      const dataDir = join(dir, "data");
      const manifest = writeManifest(dir, "wrong-resources.json", (value) => {
        const participants = value.participants as Array<{ id: string; resources: string[] }>;
        const participant = participants.find((item) => item.id === id);
        if (!participant) throw new Error(`Missing fixture participant ${id}`);
        participant.resources = ["file:placeholder"];
      });
      installManifest(manifest, dataDir);
      expect(() => beginSourceSyncAdmission(dataDir), id).toThrow(/resource set mismatch/);
      expect(existsSync(dataDir), id).toBe(false);
    }
  });

  it("rejects empty-named fields in manifests and receipts without changing data", () => {
    const dir = scratch("empty-fields");
    const manifestPath = writeManifest(dir, "manifest.json");
    const original = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(original) as { live_format: Record<string, unknown>; participants: Array<Record<string, unknown>> };
    const cases = [
      { "": true, unknown: true, ...manifest },
      { ...manifest, live_format: { "": true, ...manifest.live_format } },
      { ...manifest, participants: [{ "": true, ...manifest.participants[0] }, ...manifest.participants.slice(1)] },
    ];
    installManifest(manifestPath, join(dir, "data"));
    for (const value of cases) {
      writeFileSync(manifestPath, JSON.stringify(value));
      expect(() => beginSourceSyncAdmission(join(dir, "data"))).toThrow(/unknown field/);
      expect(existsSync(join(dir, "data"))).toBe(false);
    }
    writeFileSync(manifestPath, original);
    const receipt = beginSourceSyncAdmission(join(dir, "data"));
    const invalidReceipt = JSON.stringify({ "": true, unknown: true, ...receipt });
    const path = sourceSyncAdmissionReceiptPath(join(dir, "data"));
    writeFileSync(path, invalidReceipt);
    expect(() => beginSourceSyncAdmission(join(dir, "data"))).toThrow(/admission receipt/);
    expect(readFileSync(path, "utf8")).toBe(invalidReceipt);
  });

  it.each(["symlink", "hardlink"])("ignores a planted receipt temporary %s and preserves its target", (kind) => {
    const dir = scratch(`receipt-${kind}`);
    const manifest = writeManifest(dir, "manifest.json");
    installManifest(manifest, dir);
    const target = join(dir, "unrelated.txt");
    writeFileSync(target, "untouched data");
    const planted = `${sourceSyncAdmissionReceiptPath(dir)}.tmp`;
    if (kind === "symlink") symlinkSync(target, planted);
    else linkSync(target, planted);
    const receipt = beginSourceSyncAdmission(dir);
    expect(readFileSync(target, "utf8")).toBe("untouched data");
    expect(JSON.parse(readFileSync(sourceSyncAdmissionReceiptPath(dir), "utf8"))).toEqual(receipt);
    expect(lstatSync(sourceSyncAdmissionReceiptPath(dir)).isFile()).toBe(true);
    expect(statSync(sourceSyncAdmissionReceiptPath(dir)).nlink).toBe(1);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual(["source-sync-admission.json.tmp"]);
  });

  it("rejects every participant relabeled with another allowed kind before persisting admission", () => {
    for (const [index, id] of SOURCE_SYNC_PARTICIPANTS.entries()) {
      const dir = scratch(`wrong-kind-${index}`);
      const dataDir = join(dir, "new-data");
      const manifest = writeManifest(dir, "wrong-kind.json", (value) => {
        const participants = value.participants as Array<{ id: string; kind: string }>;
        const participant = participants.find((item) => item.id === id);
        if (!participant) throw new Error(`Missing fixture participant ${id}`);
        participant.kind = participant.kind === "job" ? "http" : "job";
      });
      installManifest(manifest, dataDir);
      expect(() => beginSourceSyncAdmission(dataDir), id).toThrow(/participant kind mismatch/);
      expect(existsSync(dataDir), id).toBe(false);
    }
  });

  it("rejects an unsupported live format before creating the data directory", () => {
    const dir = scratch("unknown-format");
    const dataDir = join(dir, "new-data");
    const manifest = writeManifest(dir, "unknown-format.json", (value) => {
      value.live_format = { id: "source-revision-workspace-v2", rollback: "compatible" };
    });
    installManifest(manifest, dataDir);
    expect(() => beginSourceSyncAdmission(dataDir)).toThrow(/unknown live format/);
    expect(existsSync(dataDir)).toBe(false);
  });

  it.each(["same", "different", "malformed", "nonregular"])("preserves a concurrent %s admission receipt", (scenario) => {
    const dir = scratch(`concurrent-${scenario}`);
    const result = spawnSync(process.execPath, [
      "--experimental-strip-types", join(sourceDir, "fixtures/concurrent-admission.mjs"), dir, scenario,
    ], { encoding: "utf8", timeout: 20_000 });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`Preserved concurrent ${scenario} admission`);
  });

  it("publishes a complete reusable receipt when filesystem writes are short", () => {
    const dir = scratch("short-writes");
    const proof = join(dir, "short-writes.mjs");
    writeFileSync(proof, [
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      'const actualWrite = fs.writeSync;',
      'let shortWrites = 0;',
      'fs.writeSync = (fd, data, offset = 0, length = data.length, position = null) => {',
      '  shortWrites += 1;',
      '  if (typeof data === "string") return actualWrite(fd, Buffer.from(data).subarray(0, 17));',
      '  return actualWrite(fd, data, offset, Math.min(17, length), position);',
      '};',
      'syncBuiltinESMExports();',
      `const { beginSourceSyncAdmission, sourceSyncAdmissionReceiptPath } = await import(${JSON.stringify(join(sourceDir, "source-sync-admission.ts"))});`,
      'const first = beginSourceSyncAdmission(process.argv[2]);',
      'const bytes = fs.readFileSync(sourceSyncAdmissionReceiptPath(process.argv[2]), "utf8");',
      'const second = beginSourceSyncAdmission(process.argv[2]);',
      'if (shortWrites < 2 || JSON.stringify(first) !== JSON.stringify(second)) throw Error("incomplete admission");',
      'if (JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(first)) throw Error("incomplete receipt");',
      'console.log("Complete receipt after short writes");',
    ].join("\n"));
    const env = { ...process.env };
    delete env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", proof, join(dir, "data")], {
      encoding: "utf8", env,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Complete receipt after short writes");
  });

  it("rejects a conflicting manifest before timers or data changes", async () => {
    const dir = scratch("conflict");
    const manifest = writeManifest(dir, "conflict.json", (value) => {
      const participants = value.participants as Array<Record<string, unknown>>;
      const worker = participants.find((item) => item.id === "worker.startSourceWatcher");
      if (!worker) throw new Error("missing worker participant");
      worker.owner = "rust";
    });
    installManifest(manifest, dir);
    const ports = createPorts(loadConfig());
    await ports.db.connect();
    const before = fingerprint(dir);
    const watchers = installedSourceSyncWatchers();
    let rejected: unknown;
    try {
      await buildApp(loadConfig(), ports);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(OwnershipAdmissionError);
    expect((rejected as Error).message).toMatch(/conflicting ownership/);
    expect(fingerprint(dir)).toBe(before);
    expect(existsSync(sourceSyncAdmissionReceiptPath(dir))).toBe(false);
    expect(installedSourceSyncWatchers()).toBe(watchers);
    await ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a missing watcher participant before installing timers", async () => {
    const dir = scratch("missing");
    const manifest = writeManifest(dir, "missing.json", (value) => {
      value.participants = (value.participants as Array<{ id: string }>).filter(
        (item) => item.id !== "startup.startSourceWatcher",
      );
    });
    installManifest(manifest, dir);
    const ports = createPorts(loadConfig());
    await ports.db.connect();
    const before = fingerprint(dir);
    const watchers = installedSourceSyncWatchers();
    await expect(buildApp(loadConfig(), ports)).rejects.toThrow(/participant set mismatch/);
    expect(fingerprint(dir)).toBe(before);
    expect(existsSync(sourceSyncAdmissionReceiptPath(dir))).toBe(false);
    expect(installedSourceSyncWatchers()).toBe(watchers);
    await ports.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a corrupt startup receipt without rewriting it or installing timers", async () => {
    const manifestText = readFileSync(packagedManifest, "utf8");
    const participantCount = (JSON.parse(manifestText) as { participants: unknown[] }).participants.length;
    const sha = createHash("sha256").update(manifestText).digest("hex");
    const valid = {
      operation: "source.sync",
      owner: "node",
      worker_pid: 123,
      admission_count: 1,
      participant_count: participantCount,
      manifest_sha256: sha,
    };
    const cases: Array<{ name: string; body: string }> = [
      {
        name: "count",
        body: JSON.stringify({ ...valid, participant_count: 999 }),
      },
      {
        name: "pid",
        body: JSON.stringify({
          operation: valid.operation,
          owner: valid.owner,
          admission_count: valid.admission_count,
          participant_count: valid.participant_count,
          manifest_sha256: valid.manifest_sha256,
        }),
      },
      { name: "null", body: "null" },
      { name: "unknown", body: JSON.stringify({ ...valid, unexpected: true }) },
    ];
    for (const planted of cases) {
      const dir = scratch(`corrupt-${planted.name}`);
      const manifest = writeManifest(dir, "admitted.json");
      installManifest(manifest, dir);
      const receiptPath = sourceSyncAdmissionReceiptPath(dir);
      writeFileSync(receiptPath, planted.body);
      const ports = createPorts(loadConfig());
      await ports.db.connect();
      const watchers = installedSourceSyncWatchers();
      let rejected: unknown;
      try {
        await buildApp(loadConfig(), ports);
      } catch (error) {
        rejected = error;
      }
      expect(rejected, planted.name).toBeInstanceOf(OwnershipAdmissionError);
      expect(rejected, planted.name).not.toBeInstanceOf(TypeError);
      expect((rejected as Error).message).toMatch(/admission receipt/);
      expect(readFileSync(receiptPath, "utf8")).toBe(planted.body);
      expect(installedSourceSyncWatchers()).toBe(watchers);
      await ports.db.close();
    }
  });

  it("admits HTTP aliases, source create, MCP confirm, and one restart receipt", async () => {
    const dir = scratch("valid");
    const manifest = writeManifest(dir, "admitted.json");
    installManifest(manifest, dir);
    const started = await boot(dir);
    const receiptPath = sourceSyncAdmissionReceiptPath(dir);
    const firstReceipt = readFileSync(receiptPath, "utf8");
    const firstParsed = JSON.parse(firstReceipt) as {
      operation: string;
      owner: string;
      admission_count: number;
      participant_count: number;
      worker_pid: number;
    };
    expect(firstParsed).toMatchObject({
      operation: "source.sync",
      owner: "node",
      admission_count: 1,
    });
    expect(firstParsed.participant_count).toBe(SOURCE_SYNC_PARTICIPANTS.length);
    expect(firstParsed.worker_pid).toBe(process.pid);
    expect(installedSourceSyncWatchers()).toBe(1);

    const created = await started.app.inject({
      method: "POST",
      url: "/sources",
      payload: { name: "Local fixture", source_kind: "local" },
    });
    expect(created.statusCode).toBe(200);
    const source = created.json() as { id: number; local_path: string | null };
    expect(source.local_path).toBeTruthy();
    const createdAlias = await started.app.inject({
      method: "POST",
      url: "/api/v1/sources",
      headers: { authorization: "Bearer test-mcp-key" },
      payload: { name: "Local fixture alias", source_kind: "local" },
    });
    expect(createdAlias.statusCode, createdAlias.body).toBe(200);
    const syncAction = {
      type: "start_sync",
      plan_id: 1,
      label: "Sync",
      summary: "Sync",
      params: { project_ids: [source.id] },
    };
    const applied = await started.app.inject({
      method: "POST",
      url: "/assistant/actions/apply",
      payload: { action: { ...syncAction, id: "apply-sync" } },
    });
    expect(applied.statusCode, applied.body).toBe(200);
    const appliedAlias = await started.app.inject({
      method: "POST",
      url: "/api/v1/assistant/actions/apply",
      headers: { authorization: "Bearer test-mcp-key" },
      payload: { action: { ...syncAction, id: "apply-sync-v1" } },
    });
    expect(appliedAlias.statusCode, appliedAlias.body).toBe(200);
    const fixture = join(source.local_path!, "fixture.txt");
    mkdirSync(source.local_path!, { recursive: true });
    writeFileSync(fixture, "owned-local-fixture");
    const fixtureHash = createHash("sha256").update(readFileSync(fixture)).digest("hex");

    const direct = await started.app.inject({
      method: "POST",
      url: "/jobs/sync",
      payload: { project_ids: [source.id] },
    });
    expect(direct.statusCode).toBe(200);
    const directJob = (direct.json() as { job_id: string }).job_id;
    const alias = await started.app.inject({
      method: "POST",
      url: "/api/v1/jobs/sync",
      headers: { authorization: "Bearer test-mcp-key" },
      payload: { project_ids: [source.id] },
    });
    expect(alias.statusCode).toBe(200);
    const aliasJob = (alias.json() as { job_id: string }).job_id;
    const importJobs: string[] = [];
    for (const url of ["/jobs/import-scan", "/api/v1/jobs/import-scan", "/jobs/extract-source-docs", "/api/v1/jobs/extract-source-docs", "/jobs/check-source-updates", "/api/v1/jobs/check-source-updates"]) {
      const imported = await started.app.inject({
        method: "POST",
        url,
        headers: { authorization: "Bearer test-mcp-key" },
        payload: { project_id: source.id },
      });
      expect(imported.statusCode, imported.body).toBe(200);
      importJobs.push(imported.json().job_id);
    }

    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer test-mcp-key",
    };
    const initialized = await started.app.inject({
      method: "POST",
      url: "/api/v1/mcp",
      headers,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "gre402", version: "0" },
        },
      },
    });
    expect(initialized.statusCode).toBe(200);
    const session = initialized.headers["mcp-session-id"];
    expect(typeof session).toBe("string");
    const sessionHeaders = { ...headers, "mcp-session-id": String(session) };
    await started.app.inject({
      method: "POST",
      url: "/api/v1/mcp",
      headers: sessionHeaders,
      payload: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    const proposed = await started.app.inject({
      method: "POST",
      url: "/api/v1/mcp",
      headers: sessionHeaders,
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "start_sync", arguments: { source_name: "Local fixture" } },
      },
    });
    expect(proposed.statusCode).toBe(200);
    const proposedBody = JSON.parse(toolText(proposed.body)) as { action?: { id?: string } };
    expect(proposedBody.action?.id).toBeTruthy();
    const confirmed = await started.app.inject({
      method: "POST",
      url: "/api/v1/mcp",
      headers: sessionHeaders,
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "confirm_apply", arguments: { action_id: proposedBody.action!.id } },
      },
    });
    expect(confirmed.statusCode).toBe(200);
    const confirmedBody = JSON.parse(toolText(confirmed.body)) as { ok?: boolean; job_id?: string };
    expect(confirmedBody.ok).toBe(true);
    expect(confirmedBody.job_id).toBeTruthy();

    const appliedJob = (applied.json() as { job_id?: string }).job_id;
    const appliedAliasJob = (appliedAlias.json() as { job_id?: string }).job_id;
    expect(appliedJob).toBeTruthy();
    expect(appliedAliasJob).toBeTruthy();
    for (const jobId of [directJob, aliasJob, confirmedBody.job_id!, appliedJob!, appliedAliasJob!]) {
      const job = await waitJob(started.app, jobId);
      expect(job.status).toBe("done");
      expect(job.result?.synced).toBeGreaterThan(0);
    }
    for (const jobId of importJobs) {
      expect((await waitJob(started.app, jobId)).status).toBe("done");
    }
    const listed = await started.app.inject({ method: "GET", url: `/sources/${source.id}` });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { last_synced_at: string | null }).last_synced_at).toBeTruthy();
    expect(createHash("sha256").update(readFileSync(fixture)).digest("hex")).toBe(fixtureHash);

    const beforeReplacement = fingerprint(dir);
    const originalManifest = readFileSync(manifest, "utf8");
    const queuedImport = await started.ports.jobs.start("import-scan", { project_id: source.id });
    const queuedExtraction = await started.ports.jobs.start("extract-source-docs", { project_id: source.id });
    const queuedUpdateCheck = await started.ports.jobs.start("check-source-updates", {});
    writeFileSync(manifest, `${originalManifest}\n`);
    for (const url of ["/jobs/sync", "/api/v1/jobs/sync", "/jobs/import-scan", "/api/v1/jobs/import-scan", "/jobs/extract-source-docs", "/api/v1/jobs/extract-source-docs", "/jobs/check-source-updates", "/api/v1/jobs/check-source-updates"]) {
      const refused = await started.app.inject({
        method: "POST",
        url,
        headers: { authorization: "Bearer test-mcp-key" },
        payload: { project_ids: [source.id], project_id: source.id },
      });
      expect(refused.statusCode, refused.body).toBe(503);
      expect(refused.body).toMatch(/runtime manifest does not match/);
    }
    await expect(started.ports.jobs.start("import-scan", { project_id: source.id }))
      .rejects.toThrow(/runtime manifest does not match/);
    await expect(started.ports.jobs.start("extract-source-docs", { project_id: source.id }))
      .rejects.toThrow(/runtime manifest does not match/);
    await expect(started.ports.jobs.start("check-source-updates", {}))
      .rejects.toThrow(/runtime manifest does not match/);
    for (const jobId of [queuedImport, queuedExtraction, queuedUpdateCheck]) {
      expect(await waitJob(started.app, jobId)).toMatchObject({
        status: "error",
        error: expect.stringMatching(/runtime manifest does not match/),
      });
    }
    writeFileSync(manifest, originalManifest);
    expect(fingerprint(dir)).toBe(beforeReplacement);

    const conflicted = writeManifest(dir, "conflict.json", (value) => {
      const participants = value.participants as Array<Record<string, unknown>>;
      const worker = participants.find((item) => item.id === "worker.startSourceWatcher");
      if (!worker) throw new Error("missing worker participant");
      worker.owner = "rust";
    });
    process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST = conflicted;
    const refused = await started.app.inject({
      method: "POST",
      url: "/sources",
      payload: { name: "Should not exist", source_kind: "local" },
    });
    expect(refused.statusCode).toBe(503);
    expect(refused.body).toMatch(/conflicting ownership/);
    for (const url of ["/jobs/import-scan", "/api/v1/jobs/import-scan", "/jobs/extract-source-docs", "/api/v1/jobs/extract-source-docs", "/jobs/check-source-updates", "/api/v1/jobs/check-source-updates"]) {
      const refusedImport = await started.app.inject({
        method: "POST",
        url,
        headers: { authorization: "Bearer test-mcp-key" },
        payload: { project_id: source.id },
      });
      expect(refusedImport.statusCode).toBe(503);
      expect(refusedImport.body).toMatch(/conflicting ownership/);
    }
    const sources = (await started.app.inject({ method: "GET", url: "/sources" })).json() as {
      sources: Array<{ name: string }>;
    };
    expect(sources.sources.map((item) => item.name).sort()).toEqual([
      "Local fixture",
      "Local fixture alias",
    ]);
    expect(readFileSync(receiptPath, "utf8")).toBe(firstReceipt);
    expect(createHash("sha256").update(readFileSync(fixture)).digest("hex")).toBe(fixtureHash);

    await started.app.close();
    await started.ports.db.close();
    openApps.splice(openApps.indexOf(started), 1);
    expect(installedSourceSyncWatchers()).toBe(0);
    process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST = manifest;
    const restarted = await boot(dir);
    expect(readFileSync(receiptPath, "utf8")).toBe(firstReceipt);
    expect(JSON.parse(readFileSync(receiptPath, "utf8")).admission_count).toBe(1);
    expect(installedSourceSyncWatchers()).toBe(1);
    await restarted.app.close();
    await restarted.ports.db.close();
    openApps.splice(openApps.indexOf(restarted), 1);
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("census admits every live source sync entry", () => {
    const prior = process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST;
    delete process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST;
    try {
      const packaged = packagedSourceSyncManifestPath();
      expect(defaultSourceSyncManifestPath()).toBe(packaged);
      const text = readFileSync(packaged, "utf8");
      const admitted = admitSourceSyncManifest(text);
      expect(admitted.operation).toBe(SOURCE_SYNC_OPERATION);
      expect([...admitted.participantIds].sort()).toEqual([...SOURCE_SYNC_PARTICIPANTS].sort());
      const receipt: SourceSyncAdmissionReceipt = {
        operation: "source.sync",
        owner: "node",
        worker_pid: 1,
        admission_count: 1,
        participant_count: SOURCE_SYNC_PARTICIPANTS.length,
        manifest_sha256: admitted.manifestSha256,
      };
      expect(
        parseSourceSyncAdmissionReceipt(JSON.stringify(receipt), SOURCE_SYNC_PARTICIPANTS.length)
          .participant_count,
      ).toBe(SOURCE_SYNC_PARTICIPANTS.length);
    } finally {
      if (prior === undefined) delete process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST;
      else process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST = prior;
    }
  });

  it("refuses standalone startup before sqlite upgrade when the receipt is corrupt", async () => {
    const dir = scratch("startup-corrupt");
    const receiptPath = sourceSyncAdmissionReceiptPath(dir);
    writeFileSync(receiptPath, "null");
    const receiptBefore = readFileSync(receiptPath);
    const dbPath = join(dir, "print-partner.db");
    const sqlite = new Database(dbPath);
    sqlite.close();
    const dbBefore = readFileSync(dbPath);
    installManifest(packagedManifest, dir);
    await expect(startServer(loadConfig())).rejects.toThrow(/admission receipt/);
    expect(existsSync(join(dir, "backups"))).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(readFileSync(dbPath)).toEqual(dbBefore);
    expect(readFileSync(receiptPath)).toEqual(receiptBefore);
  });

  it("refuses stdio MCP before opening the database when the receipt is corrupt", () => {
    const dir = scratch("stdio-corrupt");
    const receiptPath = sourceSyncAdmissionReceiptPath(dir);
    writeFileSync(receiptPath, "null");
    const receiptBefore = readFileSync(receiptPath);
    const tsx = join(sourceDir, "../../../../node_modules/tsx/dist/cli.mjs");
    const started = spawnSync(
      process.execPath,
      [tsx, join(sourceDir, "../mcp/stdio-server.ts")],
      {
        encoding: "utf8",
        timeout: 20_000,
        input: "",
        env: {
          ...process.env,
          DEPLOY_MODE: "self-host",
          HOST: "127.0.0.1",
          PRINT_PARTNER_DATA_DIR: dir,
          PRINT_PARTNER_API_KEY: "test-mcp-key",
          PP_SOURCE_SYNC_OWNERSHIP_MANIFEST: packagedManifest,
        },
      },
    );
    expect(started.status, `${started.stdout}\n${started.stderr}`).toBe(1);
    expect(`${started.stdout}\n${started.stderr}`).toMatch(/admission receipt/);
    expect(existsSync(join(dir, "print-partner.db"))).toBe(false);
    expect(readFileSync(receiptPath)).toEqual(receiptBefore);
  });

  it("builds a fresh server package into a temporary directory and reuses one receipt", async () => {
    const webRoot = join(sourceDir, "../../../..");
    for (const [workspace, index] of [
      ["@print-partner/contracts", join(webRoot, "packages/contracts/dist/current/index.js")],
      ["@print-partner/domain", join(webRoot, "packages/domain/dist/current/index.js")],
    ] as const) {
      if (existsSync(index)) continue;
      const dependency = spawnSync("npm", ["run", "build", "-w", workspace], {
        cwd: webRoot,
        encoding: "utf8",
      });
      expect(dependency.status, `${dependency.stdout}\n${dependency.stderr}`).toBe(0);
    }

    const layout = scratch("layout");
    const outputDirectory = join(layout, "apps/server/dist");
    const builder = join(webRoot, "scripts/atomic-package-build.mjs");
    const buildScript = join(layout, "build-once.mjs");
    writeFileSync(
      buildScript,
      [
        `import { buildPackageAtomically } from ${JSON.stringify(builder)};`,
        "await buildPackageAtomically({",
        "  packageDirectory: process.argv[2],",
        "  project: \"tsconfig.build.json\",",
        "  outputDirectory: process.argv[3],",
        "  copies: [{ source: \"src/data\", target: \"data\" }],",
        "  requiredFiles: [\"data/source-sync-ownership.json\"],",
        "});",
      ].join("\n"),
    );
    const built = spawnSync(
      process.execPath,
      [buildScript, join(sourceDir, "../.."), outputDirectory],
      { encoding: "utf8" },
    );
    expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);
    const current = join(outputDirectory, "current");
    const modulePath = join(current, "ownership/source-sync-admission.js");
    expect(existsSync(modulePath)).toBe(true);
    expect(existsSync(join(layout, "rust"))).toBe(false);
    const manifest = join(current, "data/source-sync-ownership.json");
    expect(statSync(manifest).isFile()).toBe(true);
    const proof = join(current, "prove-layout.mjs");
    const dataDir = join(layout, "data");
    writeFileSync(
      proof,
      [
        'import { readFileSync } from "node:fs";',
        'import { beginSourceSyncAdmission, defaultSourceSyncManifestPath } from "./ownership/source-sync-admission.js";',
        "const manifest = defaultSourceSyncManifestPath();",
        'if (!manifest.endsWith("/data/source-sync-ownership.json")) { console.error(manifest); process.exit(2); }',
        'if (manifest.includes("/rust/")) process.exit(3);',
        "const dir = process.argv[2];",
        "const first = beginSourceSyncAdmission(dir);",
        'const bytes = readFileSync(dir + "/source-sync-admission.json");',
        "const second = beginSourceSyncAdmission(dir);",
        'const again = readFileSync(dir + "/source-sync-admission.json");',
        "if (first.admission_count !== 1 || second.admission_count !== 1 || first.owner !== \"node\") process.exit(4);",
        "if (!bytes.equals(again)) process.exit(5);",
        "console.log(JSON.stringify({ manifest, owner: first.owner, admission_count: first.admission_count }));",
      ].join("\n"),
    );
    const env = { ...process.env };
    delete env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST;
    const admitted = spawnSync(process.execPath, [proof, dataDir], { encoding: "utf8", env });
    expect(admitted.status, `${admitted.stdout}\n${admitted.stderr}`).toBe(0);
    expect(admitted.stdout).toMatch(/"admission_count":1/);
    renameSync(manifest, `${manifest}.hidden`);
    const missing = spawnSync(process.execPath, [proof, join(layout, "missing-data")], {
      encoding: "utf8",
      env,
    });
    expect(missing.status).not.toBe(0);
    expect(`${missing.stdout}\n${missing.stderr}`).toMatch(/packaged source sync ownership manifest is missing/);
  }, 240_000);
});
